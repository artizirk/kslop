// Phone-sized checks: closing the panel, not losing controls, and the reset
// button being reachable without opening anything.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');
const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9242;
const PAGE = `http://127.0.0.1:${RELAY}/?seed=20251008&audio=0`;
const SHOT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu', '--mute-audio',
  '--hide-scrollbars', '--window-size=900,420', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' });

const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 80; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const t = (await getJSON('/json/list')).find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  const raw = wsSend(ws);
  let seq = 0; const pend = new Map(); const errors = [];
  ws.on('message', (m) => {
    const d = JSON.parse(m.toString());
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    raw(JSON.stringify({ id, method, params }));
  });
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOT}/${n}.png`, Buffer.from(r.data, 'base64')); console.log('  wrote ' + SHOT + '/' + n + '.png'); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: PAGE });
  await sleep(1900);

  const tap = async (x, y) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await sleep(60);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(220);
  };
  const centreOf = async (sel) => js(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; })()`);

  console.log('\n== opening and closing the panel ==');
  const menu = await centreOf('#touch .tbtn.menu');
  await tap(menu.x, menu.y);
  check('the menu button opens the panel', await js("!document.getElementById('net').classList.contains('hidden')"));
  await shot('45-panel-open');

  const close = await centreOf('#netClose');
  check('the panel has a close button', close.w > 20, JSON.stringify(close));
  await tap(close.x, close.y);
  check('the close button shuts it', await js("document.getElementById('net').classList.contains('hidden')"));

  // and the menu button still works, since it now sits above the panel
  await tap(menu.x, menu.y);
  check('it can be reopened', await js("!document.getElementById('net').classList.contains('hidden')"));
  await tap(menu.x, menu.y);
  check('and the menu button closes it too', await js("document.getElementById('net').classList.contains('hidden')"));

  // tapping the game behind the panel puts it away
  await tap(menu.x, menu.y);
  check('reopened once more', await js("!document.getElementById('net').classList.contains('hidden')"));
  await tap(200, 250);
  check('tapping the game dismisses the panel', await js("document.getElementById('net').classList.contains('hidden')"));

  console.log('\n== the nickname is reachable on a phone ==');
  await tap(menu.x, menu.y);
  const nameBox = await centreOf('#netName');
  check('the name box is on screen', nameBox.y > 0 && nameBox.y < 420, JSON.stringify(nameBox));
  check('the name box is big enough to tap', nameBox.h >= 34, 'h=' + nameBox.h);
  await js(`(() => { const el = document.getElementById('netName'); el.value = 'PhoneGuy';
    el.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(200);
  check('the nickname takes', await js('__game.NET.name') === 'PhoneGuy', await js('__game.NET.name'));
  await tap(close.x, close.y);

  console.log('\n== a reset button sits in the UI ==');
  const reset = await centreOf('#touch .tbtn.reset');
  check('there is a reset control on screen', reset.w >= 40, JSON.stringify(reset));
  check('it is a full-size touch target', reset.w >= 60 && reset.h >= 60, `${reset.w}x${reset.h}`);

  // drag a control, then put it back with the on-screen button
  const gas = await centreOf('#touch .tbtn[data-id="gas"]');
  const home = { x: gas.x, y: gas.y };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gas.x, y: gas.y, id: 3 }] });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gas.x - i * 22, y: gas.y - i * 12, id: 3 }] });
    await sleep(25);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const moved = await centreOf('#touch .tbtn[data-id="gas"]');
  check('a control can be dragged', Math.abs(moved.x - home.x) > 30, `${home.x.toFixed(0)} -> ${moved.x.toFixed(0)}`);

  await tap(reset.x, reset.y);
  const back = await centreOf('#touch .tbtn[data-id="gas"]');
  check('the reset button puts it back', Math.abs(back.x - home.x) < 8 && Math.abs(back.y - home.y) < 8,
    `home ${home.x.toFixed(0)},${home.y.toFixed(0)} now ${back.x.toFixed(0)},${back.y.toFixed(0)}`);
  check('and clears the saved layout', await js("localStorage.getItem('leonida.pads')") === null);

  console.log('\n== a control cannot be dragged off screen ==');
  const fire = await centreOf('#touch .tbtn[data-id="fire"]');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fire.x, y: fire.y, id: 4 }] });
  for (let i = 1; i <= 14; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 5000, y: 5000, id: 4 }] });
    await sleep(18);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const clamped = await js(`(() => { const r = document.querySelector('#touch .tbtn[data-id="fire"]').getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, left: r.left, top: r.top, iw: window.innerWidth, ih: window.innerHeight }; })()`);
  check('dragging far off screen is clamped', clamped.right <= clamped.iw + 2 && clamped.bottom <= clamped.ih + 2 &&
    clamped.left >= -2 && clamped.top >= -2, JSON.stringify(clamped));
  await tap(reset.x, reset.y);

  console.log('\n== fullscreen ==');
  const fsBtn = await js(`(() => {
    const b = document.querySelector('#touch .tbtn.fs');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { hidden: b.hidden, w: r.width, h: r.height, top: r.top, right: r.right,
             supported: __game.fullscreenSupported(), active: __game.fullscreenActive() };
  })()`);
  check('a fullscreen button is in the mobile UI', !!fsBtn, JSON.stringify(fsBtn));
  check('it is a full-size target', fsBtn && fsBtn.w >= 60 && fsBtn.h >= 60, JSON.stringify(fsBtn));
  check('it does not overlap the menu button',
    fsBtn && fsBtn.top >= 70, 'top=' + (fsBtn && fsBtn.top));
  check('fullscreen is supported in Chrome', fsBtn && fsBtn.supported === true);
  check('nothing is fullscreen yet', fsBtn && fsBtn.active === false);
  let fsThrew = false;
  try { await js('__game.toggleFullscreen(), true'); } catch (e) { fsThrew = true; }
  check('toggling it does not throw', !fsThrew);
  await sleep(300);
  await js('if (__game.fullscreenActive()) __game.toggleFullscreen();');
  await sleep(200);
  check('and the page is left usable', await js('!!window.__game.car'));

  const rows = await js(`(() => {
    const btns = [...document.querySelectorAll('#touch .tbtn')];
    return btns.map(b => ({ id: b.dataset.id, right: b.getBoundingClientRect().right, top: b.getBoundingClientRect().top }));
  })()`);
  const utility = rows.filter(r => ['menu', 'fs', 'reset'].includes(r.id));
  check('the utility buttons are stacked, not overlapping', (() => {
    const tops = utility.map(u => Math.round(u.top)).sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] < 55) return false;
    return true;
  })(), JSON.stringify(utility));

  console.log('\n== the controls stay put ==');
  // Entering fullscreen changes the viewport and can change env() insets. The
  // utility column must not jump when that happens.
  const topsNow = await js(`(() => {
    const o = {};
    for (const id of ['menu', 'fs', 'reset']) {
      const b = document.querySelector('#touch .tbtn[data-id="' + id + '"]');
      o[id] = Math.round(b.getBoundingClientRect().top);
    }
    return o;
  })()`);
  // simulate the chrome coming and going by changing the viewport height
  for (const h of [360, 480, 420]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(250);
  }
  const topsAfter = await js(`(() => {
    const o = {};
    for (const id of ['menu', 'fs', 'reset']) {
      const b = document.querySelector('#touch .tbtn[data-id="' + id + '"]');
      o[id] = Math.round(b.getBoundingClientRect().top);
    }
    return o;
  })()`);
  check('the utility buttons do not move when the viewport changes',
    ['menu', 'fs', 'reset'].every(id => Math.abs(topsAfter[id] - topsNow[id]) <= 1),
    JSON.stringify(topsNow) + ' -> ' + JSON.stringify(topsAfter));
  check('the utility column is still spaced out',
    (() => { const t = ['menu', 'fs', 'reset'].map(id => topsAfter[id]).sort((a, b) => a - b);
      return t[1] - t[0] >= 55 && t[2] - t[1] >= 55; })(), JSON.stringify(topsAfter));

  // the driving pads are bottom-anchored, so they should follow the bottom edge
  // the lowest control should hug the bottom edge, whatever the viewport height
  const padBottom = await js(`(() => {
    const all = [...document.querySelectorAll('#touch .tbtn')].map(b => b.getBoundingClientRect().bottom);
    return Math.round(window.innerHeight - Math.max(...all));
  })()`);
  check('the pads stay anchored to the bottom', padBottom >= 0 && padBottom < 40, 'gap=' + padBottom);

  console.log('\n== everyone can be shot ==');
  const shooting = await js(`(() => {
    const g = window.__game;
    g.cash.length = 0; g.car.money = 0; g.car.damage = 0; g.car.wreckTimer = 0;
    const p = g.peds.find(x => x.alive);
    // put both of them in open ground: a pavement pedestrian usually has a
    // building right behind them, and the round would hit that instead
    const saved = g.solids.splice(0, g.solids.length);
    g.car.x = g.WORLD / 2; g.car.y = g.WORLD / 2; g.car.a = 0;
    g.car.vx = g.car.vy = 0;
    p.x = g.car.x + 45; p.y = g.car.y;
    p.panic = 0;
    globalThis.__savedSolids = saved;
    g.bullets.length = 0;
    g.fireCooldown = 0;
    g.fire();
    let down = false;
    for (let i = 0; i < 60 && !down; i++) { g.updateBullets(1/120); down = !p.alive; }
    g.solids.push(...globalThis.__savedSolids);
    return { down, money: g.car.money };
  })()`);
  check('a pedestrian can be shot', shooting.down === true);
  check('shooting them pays', shooting.money > 0, 'money=' + shooting.money);

  await shot('46-mobile-final');

  console.log('\n== errors ==');
  check('no page errors', errors.filter(e => !/favicon/.test(e)).length === 0, errors.join(' | ').slice(0, 200));
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message); chrome.kill(); process.exit(1); });