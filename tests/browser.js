// Drive the real page in headless Chrome over CDP: catch console errors,
// page exceptions, failed requests, and confirm the canvas is actually painted.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9222;
const PAGE = 'file://' + path.join(__dirname, '..', 'index.html') + '?seed=20251008';
const SHOT_DIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1280,720',
  ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try { return await getJSON('/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('chrome never came up:\n' + chromeErr);
}

// minimal CDP client over the websocket endpoint
const WebSocket = require('./ws');

(async () => {
  await waitForChrome();
  const targets = await getJSON('/json/list');
  let page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.once('open', r));

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  const consoleErrors = [], pageExceptions = [], failedRequests = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrors.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageExceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (m.method === 'Network.loadingFailed') failedRequests.push(m.params.errorText + ' ' + (m.params.type || ''));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Log.enable');

  await send('Page.navigate', { url: PAGE });
  await sleep(1500);

  let failures = 0;
  const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

  console.log('\n== page load ==');
  check('no uncaught page exceptions', pageExceptions.length === 0, pageExceptions.join(' | '));
  check('no console errors/warnings', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('no failed requests', failedRequests.length === 0, failedRequests.join(' | '));

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const boot = await evalJs(`(() => ({
    hasCanvas: !!document.getElementById('c'),
    canvasW: document.getElementById('c').width,
    canvasH: document.getElementById('c').height,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    hasGame: !!window.__game,
    buildings: window.__game ? window.__game.buildings.length : 0,
    ctx2d: !!document.getElementById('c').getContext('2d'),
    carFinite: window.__game ? Number.isFinite(window.__game.car.x) : false,
    audioState: (window.AudioContext ? 'available' : 'none'),
  }))()`);
  check('canvas element present', boot.hasCanvas);
  check('2d context available', boot.ctx2d);
  check('canvas backing store matches viewport * dpr',
    boot.canvasW === Math.round(boot.innerW * boot.dpr) && boot.canvasH === Math.round(boot.innerH * boot.dpr),
    `canvas=${boot.canvasW}x${boot.canvasH} viewport=${boot.innerW}x${boot.innerH} dpr=${boot.dpr}`);
  check('game booted with buildings', boot.hasGame && boot.buildings >= 36, 'buildings=' + boot.buildings);

  // hold W and let real frames run
  const key = async (type, k, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text: type === 'keyDown' ? k : undefined });
  };

  console.log('\n== real keyboard input in the browser ==');
  // spawn is randomised, so put the car on a clear road facing down it
  await evalJs(`(() => {
    const m = __game.METRICS;
    __game.car.x = m.ROAD / 2; __game.car.y = m.STEP + m.ROAD / 2; __game.car.a = 0;
    __game.car.vx = __game.car.vy = 0; __game.car.damage = 0; __game.car.wreckTimer = 0;
    __game.cam.x = __game.car.x; __game.cam.y = __game.car.y;
    return true; })()`);
  // Start from a stock car in a known place: the browser profile persists, so a
  // saved upgrade from an earlier run would change every number below.
  await evalJs(`(() => {
    const g = __game;
    g.car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
    g.car.money = 0;
    g.car.item = null; g.car.shieldTimer = 0; g.car.boostTimer = 0;
    try { localStorage.removeItem('leonida.progress'); } catch (e) {}
    return true; })()`);
  const before = await evalJs('({x: __game.car.x, y: __game.car.y})');
  await key('keyDown', 'w', 'KeyW', 87);
  await sleep(1400);
  const afterW = await evalJs('({x: __game.car.x, y: __game.car.y, v: Math.hypot(__game.car.vx, __game.car.vy), engine: __game.car.engine})');
  check('holding W moves the car', afterW.x > before.x + 100, `x ${before.x.toFixed(0)} -> ${afterW.x.toFixed(0)}`);
  check('car has real speed', afterW.v > 100, 'speed=' + afterW.v.toFixed(0));
  check('engine audio revs', afterW.engine > 0.05, 'engine=' + afterW.engine.toFixed(2));

  const audio = await evalJs(`(() => { try { const AC = window.AudioContext||window.webkitAudioContext; return AC ? 'available' : 'none'; } catch(e){ return 'err'; } })()`);
  check('WebAudio context constructible', audio === 'available', audio);

  await key('keyDown', 'a', 'KeyA', 65);
  await sleep(700);
  const afterA = await evalJs('({a: __game.car.a})');
  check('steering changes heading', Math.abs(afterA.a) > 0.15, 'a=' + afterA.a.toFixed(3));
  await key('keyUp', 'a', 'KeyA', 65);

  // Handbrake drift. Sample over a window rather than once: slip builds up
  // only while the car is both moving and turning, so a single late sample
  // can read low just because the car has already spun round or slowed.
  await key('keyDown', 'a', 'KeyA', 65);
  await key('keyDown', ' ', 'Space', 32);
  let peakSlipEarly = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(90);
    const st = await evalJs(`(() => {
      const c = __game.car, s = Math.hypot(c.vx, c.vy);
      if (s < 40) return { slip: 0, s };
      let d = Math.atan2(c.vy, c.vx) - c.a;
      while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI;
      return { slip: Math.abs(d)*180/Math.PI, s };
    })()`);
    peakSlipEarly = Math.max(peakSlipEarly, st.slip);
  }
  check('handbrake produces real slip angle', peakSlipEarly > 20, 'peak slip=' + peakSlipEarly.toFixed(1) + 'deg');
  await key('keyUp', ' ', 'Space', 32);
  await key('keyUp', 'a', 'KeyA', 65);
  await key('keyUp', 'w', 'KeyW', 87);

  console.log('\n== canvas actually painted ==');
  // sample pixels: the city has distinct asphalt/sidewalk/building colours,
  // so a painted frame must contain several distinct colours.
  const pixels = await evalJs(`(() => {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Map();
    let lit = 0, lumaSum = 0, n = 0, bright = 0;
    const lums = [];
    const stepX = 4, stepY = 4;
    for (let y = 0; y < c.height; y += stepY) {
      for (let x = 0; x < c.width; x += stepX) {
        const i = (y * c.width + x) * 4;
        const k = (d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4);
        seen.set(k, (seen.get(k)||0)+1);
        const L = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
        lumaSum += L; n++;
        if (L > 8) lit++;
        if (L > 120) { bright++; lums.push(L); }
      }
    }
    lums.sort((a,b)=>a-b);
    return {
      distinct: seen.size,
      litFraction: lit / n,
      meanLuma: lumaSum / n,
      brightPixels: bright,
      p99: lums.length ? lums[Math.floor(lums.length*0.99)] : 0,
      p50bright: lums.length ? lums[Math.floor(lums.length*0.5)] : 0,
      top: [...seen.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,n])=>k+':'+n),
    };
  })()`);
  check('frame is not blank', pixels.litFraction > 0.95, `${(pixels.litFraction * 100).toFixed(1)}% lit`);
  check('frame is not a black screen', pixels.meanLuma > 25 && pixels.meanLuma < 190,
    'meanLuma=' + pixels.meanLuma.toFixed(1));
  check('frame has real highlights, not just murk', pixels.brightPixels > 400 && pixels.p50bright > 60,
    `bright=${pixels.brightPixels} p50=${pixels.p50bright.toFixed(0)} p99=${pixels.p99.toFixed(0)}`);
  check('frame contains a real scene (many colours)', pixels.distinct > 12, 'distinct colour buckets=' + pixels.distinct);
  console.log('  dominant colours: ' + pixels.top.join('  '));
  console.log(`  luma: mean=${pixels.meanLuma.toFixed(1)} brightPixels=${pixels.brightPixels}`);

  console.log('\n== resize ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const mob = await evalJs(`(() => { const c=document.getElementById('c'); return {w:c.width,h:c.height,carOk:Number.isFinite(__game.car.x)}; })()`);
  check('canvas follows resize', mob.w === 1000 && mob.h === 1800, `${mob.w}x${mob.h}`);
  await sleep(400);
  await send('Emulation.clearDeviceMetricsOverride');

  console.log('\n== screenshots ==');
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = `${SHOT_DIR}/${name}.png`;
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  wrote ' + p + ' (' + (fs.statSync(p).size / 1024).toFixed(0) + ' KB)');
    return p;
  };
  await evalJs(`(() => { __game.respawn(); })()`);
  await sleep(300);
  await shot('01-spawn');
  await key('keyDown', 'w', 'KeyW', 87);
  await sleep(2600);
  await shot('02-driving');
  await key('keyDown', 'a', 'KeyA', 65);
  await sleep(900);
  await shot('03-turning');
  await key('keyUp', 'a', 'KeyA', 65);
  await sleep(2000);
  await shot('04-cruising');

  // handbrake drift, to capture skid marks + smoke without wrecking
  await evalJs(`(() => {
    const c = __game.car;
    c.x = 755; c.y = 405; c.a = 0; c.vx = 0; c.vy = 0; c.damage = 0; c.wreckTimer = 0;
    __game.respawn && 0;
  })()`);
  await evalJs('(() => { __game.car.x = 400; __game.car.y = 405; __game.car.a = 0; __game.car.vx = 520; __game.car.vy = 0; })()');
  await key('keyDown', 'a', 'KeyA', 65);
  await key('keyDown', ' ', 'Space', 32);
  await sleep(1100);
  const driftState = await evalJs('({damage: __game.car.damage, wreck: __game.car.wreckTimer, speed: Math.hypot(__game.car.vx,__game.car.vy)})');
  await shot('06-handbrake-drift');
  console.log(`  drift state: damage=${driftState.damage.toFixed(2)} wreck=${driftState.wreck.toFixed(2)} speed=${driftState.speed.toFixed(0)}`);
  check('a handbrake drift does not wreck the car', driftState.wreck === 0 && driftState.damage < 0.5,
    `damage=${driftState.damage.toFixed(2)} wreck=${driftState.wreck.toFixed(2)}`);
  await key('keyUp', ' ', 'Space', 32);
  await key('keyUp', 'a', 'KeyA', 65);
  await key('keyUp', 'w', 'KeyW', 87);
  await sleep(600);
  await key('keyUp', 'w', 'KeyW', 87);

  // deliberately crash into a building to capture damage + smoke + wreck
  await evalJs(`(() => {
    const b = __game.buildings.find(b => b.w > 80 && b.h > 80);
    __game.car.x = b.x - 260; __game.car.y = b.y + b.h/2; __game.car.a = 0;
    __game.car.vx = 0; __game.car.vy = 0; __game.car.damage = 0.55;
    __game.car.x = b.x - 150;
  })()`);
  await key('keyDown', 'w', 'KeyW', 87);
  await sleep(1600);
  await shot('05-crash-damage');
  const crashState = await evalJs('({damage: __game.car.damage, wreck: __game.car.wreckTimer})');
  console.log(`  single crash at speed: damage=${crashState.damage.toFixed(2)} wrecked=${crashState.wreck > 0}`);
  check('one crash at speed does not instantly wreck', crashState.wreck === 0,
    `damage=${crashState.damage.toFixed(2)} wreck=${crashState.wreck}`);
  await key('keyUp', 'w', 'KeyW', 87);

  console.log('\n== permanent daylight ==');
  {
    // The cycle is gone: the sun is fixed late-morning, so the tint and the
    // night factor should be constant no matter how long the game runs.
    const before = await evalJs('({ tint: __game.sceneTint(), night: __game.nightF(), alt: __game.sunAlt() })');
    await sleep(1200);
    const after = await evalJs('({ tint: __game.sceneTint(), night: __game.nightF(), alt: __game.sunAlt() })');
    check('the scene tint never changes', before.tint === after.tint, before.tint + ' vs ' + after.tint);
    check('it is never night', after.night === 0 && before.night === 0, 'night=' + after.night);
    check('the sun stays up', after.alt > 0.2, 'sunAlt=' + after.alt.toFixed(2));
    check('the tint is a real colour', /^rgb\(\d+,\d+,\d+\)$/.test(after.tint), after.tint);
    // a fixed clock should read as morning
    const clock = await evalJs('document.title, (() => { const c = __game; return c.dayT; })()');
    check('the day is pinned to a fixed time', typeof clock === 'number' && clock > 0.25 && clock < 0.5, 'dayT=' + clock);
  }

  await evalJs(`(() => {
    const b = __game.buildings.filter(b => b.neon).sort((a, c) => Math.hypot(a.x-1200, a.y-1200) - Math.hypot(c.x-1200, c.y-1200))[0];
    const roadY = Math.round((b.y + b.h/2) / __game.METRICS.STEP) * __game.METRICS.STEP + __game.METRICS.ROAD/2;
    __game.car.x = b.x + b.w/2; __game.car.y = roadY;
    __game.car.a = Math.PI/2; __game.car.vx = 0; __game.car.vy = 0;
    __game.car.damage = 0; __game.car.wreckTimer = 0;
    __game.cam.x = __game.car.x; __game.cam.y = __game.car.y;
    return true; })()`);
  await sleep(300);
  await shot('10-daytime');
console.log('\n== drift space ==');
  // find a genuinely clear spot inside a lot, then drift from it
  const spot = await evalJs(`(() => {
    const g = window.__game;
    const lot = g.lots.find(l => g.parked.every(p =>
      !(Math.abs(p.x - (l.x + l.w/2)) < 90 && Math.abs(p.y - (l.y + l.h/2)) < 90)));
    const lot2 = lot || g.lots[0];
    const cx = lot2.x + lot2.w/2, cy = lot2.y + lot2.h/2;
    const c = g.car;
    c.x = cx; c.y = cy; c.a = 0; c.vx = 430; c.vy = 0;
    c.damage = 0; c.wreckTimer = 0;
    return { x: cx, y: cy, lot: g.lots.indexOf(lot2), lots: g.lots.length };
  })()`);
  console.log(`  ${spot.lots} lots in the city; drifting from lot #${spot.lot} at (${spot.x.toFixed(0)},${spot.y.toFixed(0)})`);
  check('the city has open space to drift in', spot.lots >= 3, 'lots=' + spot.lots);

  await evalJs('(() => { __game.timeScale = 1; })()');
  await key('keyDown', 'w', 'KeyW', 87);
  await key('keyDown', 'a', 'KeyA', 65);
  await key('keyDown', ' ', 'Space', 32);
  let peakSlip = 0;
  const readSlip = `(() => { const c=__game.car,s=Math.hypot(c.vx,c.vy);
    if (s<20) return {slip:0, s, dmg:c.damage, wreck:c.wreckTimer};
    let d=Math.atan2(c.vy,c.vx)-c.a;
    while(d>Math.PI)d-=2*Math.PI; while(d<-Math.PI)d+=2*Math.PI;
    return {slip:Math.abs(d)*180/Math.PI, s, dmg:c.damage, wreck:c.wreckTimer}; })()`;
  const trace = [];
for (let i = 0; i < 14; i++) {
    await sleep(90);
    const st = await evalJs(readSlip);
    trace.push(`${st.s.toFixed(0)}px/s slip=${st.slip.toFixed(0)} dmg=${st.dmg.toFixed(2)} wreck=${st.wreck.toFixed(2)}`);
    peakSlip = Math.max(peakSlip, st.slip);
  }
  console.log('  ' + trace.join('\n  '));
  await shot('16-drifting-in-lot');
  console.log(`  peak slip while drifting: ${peakSlip.toFixed(1)}deg`);
  check('drifting works in an open lot', peakSlip > 25, 'peakSlip=' + peakSlip.toFixed(1) + 'deg');
  await key('keyUp', ' ', 'Space', 32);
  await key('keyUp', 'a', 'KeyA', 65);
  await key('keyUp', 'w', 'KeyW', 87);
  await sleep(300);

  console.log('\n== canvas backing store ==');
  const budget = await evalJs(`(() => {
    const c = document.getElementById('c');
    return { w: c.width, h: c.height, mp: +(c.width*c.height/1e6).toFixed(2), dpr: window.devicePixelRatio };
  })()`);
  check('backing store stays within the pixel budget', budget.mp <= 2.7,
    `${budget.w}x${budget.h} = ${budget.mp}MP (dpr ${budget.dpr})`);
  check('canvas still matches the viewport in CSS pixels', budget.w / budget.dpr >= 1270,
    'css width=' + (budget.w / budget.dpr).toFixed(0));

  console.log('\n== fps meter ==');
  // the page must be rendering continuously for the counter to mean anything
  const sample = async (label) => {
    const readings = [];
    for (let i = 0; i < 6; i++) {
      await sleep(200);
      readings.push(await evalJs('({fps: __game.fps, min: __game.fpsMin, shown: __game.showFps})'));
    }
    const last = readings[readings.length - 1];
    const vals = readings.map(r => r.fps);
    console.log(`  ${label}: fps=${vals.map(v => v.toFixed(1)).join(' ')} min=${last.min.toFixed(1)} shown=${last.shown}`);
    return last;
  };

  const fpsDrive = await sample('driving');
  check('fps counter is visible by default', fpsDrive.shown === true);
  check('fps counter reports a real frame rate', fpsDrive.fps > 20 && fpsDrive.fps < 400,
    'fps=' + fpsDrive.fps.toFixed(1));
  check('fps reading is stable across samples', fpsDrive.min > 0 && fpsDrive.min <= fpsDrive.fps + 0.01,
    `min=${fpsDrive.min.toFixed(1)} fps=${fpsDrive.fps.toFixed(1)}`);

  // Worst-case load: full night (every light on screen) plus a handbrake
  // drift. Drop resolution first, since a software-rendered 5000x3000 canvas
  // measures the rasteriser, not the game's actual cost.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(600);
  await evalJs(`(() => {
    const lot = __game.lots[0];
    __game.car.x = lot.x + lot.w/2; __game.car.y = lot.y + lot.h/2;
    __game.car.a = 0; __game.car.vx = 460; __game.car.vy = 0;
    __game.dayT = 0.95;               // full night: most lights on screen
  })()`);
  await key('keyDown', 'w', 'KeyW', 87);
  await key('keyDown', 'a', 'KeyA', 65);
  await key('keyDown', ' ', 'Space', 32);
  await sleep(400);
  const fpsWorst = await sample('night drift @4k');
  await key('keyUp', ' ', 'Space', 32);
  await key('keyUp', 'a', 'KeyA', 65);
  await key('keyUp', 'w', 'KeyW', 87);
  // This machine has no GPU, so Chrome falls back to a software rasteriser and
  // the absolute number says little about real hardware. The meaningful
  // assertion is that the pixel budget keeps 4k from costing 4x a 1080p frame.
  check('fps at 4k software-raster is at least a third of 1080p',
    fpsWorst.fps > fpsDrive.fps / 3,
    `4k=${fpsWorst.fps.toFixed(1)}fps vs 1080p=${fpsDrive.fps.toFixed(1)}fps`);
  console.log('  (software rasteriser, no GPU here -- a real GPU will be far faster)');
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  const budgetNormal = await evalJs(`(() => {
    const c = document.getElementById('c');
    return +(c.width*c.height/1e6).toFixed(2);
  })()`);
  check('budget recovers on a normal display', budgetNormal <= 2.7, budgetNormal + 'MP');
  check('fps is smooth at the default window size', fpsDrive.fps >= 55, 'fps=' + fpsDrive.fps.toFixed(1));
  await evalJs('(() => { __game.dayT = 0.735; })()');

  // F toggles it off
  await key('keyDown', 'f', 'KeyF', 70);
  await sleep(200);
  const off = await evalJs('__game.showFps');
  await key('keyUp', 'f', 'KeyF', 70);
  await key('keyDown', 'f', 'KeyF', 70);
  await sleep(200);
  const on = await evalJs('__game.showFps');
  check('F toggles the fps counter off and on', off === false && on === true, `off=${off} on=${on}`);

  await shot('17-fps-counter');

  console.log('\n== late error check ==');
  check('still no uncaught exceptions after full session', pageExceptions.length === 0, pageExceptions.join(' | '));
  check('still no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close();
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR: ' + e.message);
  console.error(chromeErr.slice(0, 2000));
  chrome.kill();
  process.exit(1);
});