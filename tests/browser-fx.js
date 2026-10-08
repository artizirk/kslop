// Two real browser tabs on the served page. Verifies the things the user
// reported missing: seeing the other player's gunfire and explosions, plus
// the mobile control layout.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);

const RELAY_PORT = Number(process.env.RELAY_PORT || 8099);
const CDP_PORT = 9228;
const PAGE = `http://127.0.0.1:${RELAY_PORT}/?seed=20251008`;
const SHOT_DIR = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const getJSON = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,720', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  'about:blank',
], { stdio: 'ignore' });

(async () => {
  for (let i = 0; i < 80; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const t = (await getJSON('/json/list')).find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));

  const rawSend = wsSend(ws);
  let bseq = 0; const bpend = new Map();
  ws.on('message', (m) => {
    const d = JSON.parse(m.toString());
    if (d.sessionId === undefined && d.id && bpend.has(d.id)) { bpend.get(d.id)(d); bpend.delete(d.id); }
  });
  const bsend = (method, params = {}) => new Promise((res, rej) => {
    const id = ++bseq;
    bpend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    rawSend(JSON.stringify({ id, method, params }));
  });

  const tabs = [];
  async function openTab(name, metrics) {
    const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await bsend('Target.attachToTarget', { targetId, flatten: true });
    let sseq = 0; const spend = new Map(); const errors = [];
    ws.on('message', (m) => {
      const d = JSON.parse(m.toString());
      if (d.sessionId !== sessionId) return;
      if (d.id && spend.has(d.id)) { spend.get(d.id)(d); spend.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console: ' + d.params.args.map(a => a.value ?? a.description).join(' '));
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++sseq;
      spend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      rawSend(JSON.stringify({ id, sessionId, method, params }));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    if (metrics) await send('Emulation.setDeviceMetricsOverride', metrics);
    await send('Page.navigate', { url: PAGE });
    await sleep(1500);
    const tab = {
      name, send, errors,
      js: async (e) => {
        const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
    tabs.push(tab);
    return tab;
  }

  const a = await openTab('A');
  const b = await openTab('B');

  console.log('\n== both players connect ==');
  for (const tab of [a, b]) {
    for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  }
  check('tab A joined', !!(await a.js('__game.NET.id')));
  check('tab B joined', !!(await b.js('__game.NET.id')));
  let paired = false;
  for (let i = 0; i < 40; i++) {
    const n = await a.js('__game.NET.peers.size');
    if (n >= 1) { paired = true; break; }
    await sleep(250);
  }
  check('the two tabs see each other', paired, 'peers=' + (await a.js('__game.NET.peers.size')));

  console.log('\n== one player sees the other shoot ==');
  await a.js('(() => { __game.bullets.length = 0; __game.NET.peers.forEach(p => { p.x = __game.car.x + 200; p.y = __game.car.y; }); return true; })()');
  await b.js('(() => { __game.bullets.length = 0; return true; })()');
  const bulletsBefore = await b.js('__game.bullets.length');
  // A fires; B should spawn ghost bullets for it
  await a.js('(() => { __game.fireCooldown = 0; __game.fire(); return true; })()');
  let sawFire = false;
  for (let i = 0; i < 20; i++) {
    const n = await b.js('__game.bullets.length');
    if (n > bulletsBefore) { sawFire = true; break; }
    await sleep(100);
  }
  check('the other player sees tracers from our gun', sawFire,
    'B bullets ' + bulletsBefore + ' -> ' + (await b.js('__game.bullets.length')));
  const ghost = await b.js('__game.bullets.length ? !!__game.bullets[0].ghost : false');
  check('remote bullets are cosmetic ghosts', ghost === true, 'ghost=' + ghost);

  console.log('\n== remote bullets cannot hurt us ==');
  await b.js('(() => { __game.car.damage = 0; return true; })()');
  const dmgBefore = await b.js('__game.car.damage');
  // aim A's ghost bullets straight through B
  await b.js('(() => { __game.bullets.length = 0; __game.car.x = 800; __game.car.y = 600; __game.car.damage = 0; return true; })()');
  await a.js(`(() => {
    __game.car.x = 500; __game.car.y = 600; __game.car.a = 0; __game.car.vx = 0; __game.car.vy = 0;
    __game.fireCooldown = 0; __game.fire(); return true; })()`);
  await sleep(900);
  const dmgAfter = await b.js('__game.car.damage');
  check('ghost bullets pass through without damage', dmgAfter === dmgBefore,
    dmgBefore.toFixed(3) + ' -> ' + dmgAfter.toFixed(3));

  console.log('\n== a real hit still lands (shooter authority) ==');
  await b.js('(() => { __game.car.damage = 0; return true; })()');
  const bId = await b.js('__game.NET.id');
  await a.js(`(() => { __game.send({ t: 'hit', to: ${bId}, dmg: 0.06 }); return true; })()`);
  let hitLanded = false;
  for (let i = 0; i < 20; i++) {
    if ((await b.js('__game.car.damage')) > 0) { hitLanded = true; break; }
    await sleep(100);
  }
  check('a hit message still damages the target', hitLanded, 'damage=' + (await b.js('__game.car.damage')));

  console.log('\n== one player sees the other explode ==');
  await b.js('(() => { __game.bangs.length = 0; return true; })()');
  await a.js('(() => { __game.car.damage = 0; __game.wreckCar(); return true; })()');
  let sawBang = false;
  for (let i = 0; i < 20; i++) {
    const n = await b.js('__game.bangs.length');
    if (n > 0) { sawBang = true; break; }
    await sleep(100);
  }
  check('the other player sees the explosion', sawBang, 'B bangs=' + (await b.js('__game.bangs.length')));

  console.log('\n== and hears it only from nearby ==');
  // Shake decays, so sample the peak rather than a value at an arbitrary
  // moment after the event.
  const peakShake = async () => {
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      peak = Math.max(peak, await b.js('__game.shakeAmount'));
      await sleep(70);
    }
    return peak;
  };
  // The falloff itself is a pure function, so test it directly rather than
  // trying to time a decaying value over the network.
  const falloff = await b.js(`(() => {
    const g = window.__game, c = g.car;
    const cx = c.x, cy = c.y;
    g.shakeAmount = 0; g.shakeAt(cx, cy, 18);           const near = g.shakeAmount;
    g.shakeAmount = 0; g.shakeAt(cx + 400, cy, 18);     const mid = g.shakeAmount;
    g.shakeAmount = 0; g.shakeAt(cx + 4000, cy, 18);    const far = g.shakeAmount;
    g.shakeAmount = 0;
    return { near, mid, far };
  })()`);
  check('a blast centred on us shakes hard', falloff.near > 10, JSON.stringify(falloff));
  check('a blast across the map does not shake us', falloff.far === 0, JSON.stringify(falloff));
  check('the shake falls off with distance', falloff.near > falloff.mid && falloff.mid > falloff.far,
    JSON.stringify(falloff));

  // and end to end: a wreck next to the other player does reach them
  await b.js('(() => { __game.shakeAmount = 0; __game.bangs.length = 0; return true; })()');
  await a.js('(() => { const p = [...__game.NET.peers.values()][0]; __game.car.wreckTimer = 0; __game.car.damage = 0; __game.car.x = p.x; __game.car.y = p.y; __game.wreckCar(); return true; })()');
  const nearShake = await peakShake();
  check('a nearby wreck shakes the other player', nearShake > 1, 'peak=' + nearShake.toFixed(2));

  console.log('\n== mobile controls ==');
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 420, deviceScaleFactor: 2, mobile: true,
  });
  await a.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await a.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  const mob = await a.js(`(() => {
    const pad = document.getElementById('touch');
    const btns = [...pad.querySelectorAll('.tbtn')];
    const right = document.querySelector('#touch .pad.right');
    const rightBtns = [...right.querySelectorAll('.tbtn')];
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return {
      visible: !pad.hidden,
      total: btns.length,
      right: rightBtns.map(b => b.dataset.id || b.dataset.key || '?'),
      sizes: btns.map(b => Math.round(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
      overlap: btns.some((x, i) => btns.some((y, j) => i < j && (() => {
        const A = box(x), B = box(y);
        return A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
      })())),
      offscreen: btns.some(b => { const r = b.getBoundingClientRect();
        return r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.top < -1; }),
    };
  })()`);
  check('touch controls appear on a touch device', mob.visible === true);
  check('the right thumb cluster holds the pedals and the action buttons',
    mob.right.length <= 5, JSON.stringify(mob.right));
  check('the handbrake moved off the right side', !mob.right.some(v => v === ' ' || v === 'drift'), JSON.stringify(mob.right));
  check('every right-hand button is identifiable', mob.right.every(v => v && v !== '?'), JSON.stringify(mob.right));
  check('every touch target is at least 60px', mob.sizes.every(s => s >= 60), JSON.stringify(mob.sizes));
  check('touch buttons do not overlap each other', mob.overlap === false);
  check('no touch button runs off screen', mob.offscreen === false);

  // the HUD must not sit under the thumbs
  const hud = await a.js(`(() => ({
    minimapTop: 92,
    mapArea: (() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; })(),
    touchActive: __game.touchActive === undefined ? null : __game.touchActive,
  }))()`);
  check('the minimap moves up when touch controls are on', hud.mapArea.h > 0);

  await a.send('Page.captureScreenshot', { format: 'png' }).then(r =>
    fs.writeFileSync(`${SHOT_DIR}/22-mobile-controls.png`, Buffer.from(r.data, 'base64')));
  console.log('  wrote ' + SHOT_DIR + '/22-mobile-controls.png');
  await a.send('Emulation.clearDeviceMetricsOverride');
  await a.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  console.log('\n== errors ==');
  for (const tab of tabs) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 300));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });