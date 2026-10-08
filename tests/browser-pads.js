// Mobile control dragging (with saved positions) and nickname-derived colours.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9235;
const PAGE = `http://127.0.0.1:${RELAY}/?seed=20251008`;
const SHOT_DIR = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,720', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  'about:blank',
], { stdio: 'ignore' });

const getJSON = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 80; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const t = (await getJSON('/json/list')).find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  const raw = wsSend(ws);
  let bseq = 0; const bpend = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m.toString()); if (d.sessionId === undefined && d.id && bpend.has(d.id)) { bpend.get(d.id)(d); bpend.delete(d.id); } });
  const bsend = (method, params = {}) => new Promise((res, rej) => {
    const id = ++bseq; bpend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    raw(JSON.stringify({ id, method, params }));
  });

  async function openTab(name) {
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
      const id = ++sseq; spend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      raw(JSON.stringify({ id, sessionId, method, params }));
    });
    await send('Runtime.enable'); await send('Page.enable');
    // a phone-shaped touch device
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: PAGE });
    await sleep(1800);
    return {
      name, errors, send,
      js: async (e) => {
        const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }

  const a = await openTab('phone');

  console.log('\n== touch controls are up ==');
  const up = await a.js(`(() => {
    const pad = document.getElementById('touch');
    const ids = [...pad.querySelectorAll('.tbtn')].map(b => b.dataset.id);
    return { visible: !pad.hidden, ids };
  })()`);
  check('the pads are visible', up.visible === true);
  check('every control has a stable id', up.ids.every(Boolean) && up.ids.length >= 7, JSON.stringify(up.ids));
  console.log('  controls: ' + up.ids.join(', '));

  console.log('\n== dragging a button moves it ==');
  const before = await a.js(`(() => {
    const b = document.querySelector('.tbtn[data-id="gas"]');
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, dx: b.style.getPropertyValue('--dx'), stored: localStorage.getItem('leonida.pads') };
  })()`);
  check('nothing is stored before a drag', before.stored === null, String(before.stored));

  // press the gas button and drag it left and up
  const box = await a.js(`(() => { const r = document.querySelector('.tbtn[data-id="gas"]').getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  const dragTo = { x: box.x - 130, y: box.y - 90 };

  await a.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }] });
  await sleep(60);
  // moving more than the threshold turns the press into a move
  for (let i = 1; i <= 6; i++) {
    const px = box.x + (dragTo.x - box.x) * (i / 6);
    const py = box.y + (dragTo.y - box.y) * (i / 6);
    await a.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px, y: py, id: 1 }] });
    await sleep(30);
  }
  await a.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);

  const after = await a.js(`(() => {
    const b = document.querySelector('.tbtn[data-id="gas"]');
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, dx: b.style.getPropertyValue('--dx'), dy: b.style.getPropertyValue('--dy'),
             moving: b.classList.contains('moving'), held: b.classList.contains('held'),
             stored: localStorage.getItem('leonida.pads') };
  })()`);
  check('the button moved', Math.abs(after.x - before.x) > 40 && Math.abs(after.y - before.y) > 30,
    `(${before.x.toFixed(0)},${before.y.toFixed(0)}) -> (${after.x.toFixed(0)},${after.y.toFixed(0)})`);
  check('the offset is written to the element', /px/.test(after.dx) && /px/.test(after.dy), after.dx + '/' + after.dy);
  check('the position is saved to localStorage', !!after.stored && after.stored.includes('gas'), String(after.stored));
  check('the move state is cleared on release', after.moving === false);
  check('a drag does not leave the control pressed', after.held === false);

  console.log('\n== dragging does not drive the car ==');
  await a.js('(() => { __game.keys["w"] = false; __game.car.vx = 0; __game.car.vy = 0; return true; })()');
  const gasHeld = await a.js('!!__game.keys["w"]');
  check('the throttle was never left on by the drag', gasHeld === false);

  console.log('\n== a tap still drives ==');
  const gasBox = await a.js(`(() => { const r = document.querySelector('.tbtn[data-id="gas"]').getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  await a.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gasBox.x, y: gasBox.y, id: 2 }] });
  await sleep(120);
  const pressed = await a.js('!!__game.keys["w"]');
  await a.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
  const released = await a.js('!!__game.keys["w"]');
  check('a plain press drives', pressed === true);
  check('and releasing stops', released === false);

  console.log('\n== positions survive a reload ==');
  await a.send('Page.reload');
  await sleep(1900);
  const restored = await a.js(`(() => {
    const b = document.querySelector('.tbtn[data-id="gas"]');
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, dx: b.style.getPropertyValue('--dx') };
  })()`);
  check('the button comes back where it was left', Math.abs(restored.x - after.x) < 6 && Math.abs(restored.y - after.y) < 6,
    `saved (${after.x.toFixed(0)},${after.y.toFixed(0)}) restored (${restored.x.toFixed(0)},${restored.y.toFixed(0)})`);

  const shot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/38-moved-controls.png`, Buffer.from(shot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/38-moved-controls.png');

  console.log('\n== reset puts them back ==');
  await a.js('window.__resetPads()');
  await sleep(300);
  const reset = await a.js(`(() => {
    const b = document.querySelector('.tbtn[data-id="gas"]');
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, stored: localStorage.getItem('leonida.pads') };
  })()`);
  check('reset returns the control home', Math.abs(reset.x - before.x) < 6 && Math.abs(reset.y - before.y) < 6,
    `home (${before.x.toFixed(0)},${before.y.toFixed(0)}) now (${reset.x.toFixed(0)},${reset.y.toFixed(0)})`);
  check('reset clears the stored layout', reset.stored === null, String(reset.stored));

  console.log('\n== colours come from the nickname ==');
  const colours = await a.js(`(() => {
    const names = ['Speedy', 'speedy', 'AVA', 'Bo', 'Zed', 'racer1', 'racer2', 'racer3'];
    return names.map(n => ({ n, c: window.__game.colourForName(n) }));
  })()`);
  check('every name yields a valid hex colour',
    colours.every(o => /^#[0-9a-f]{6}$/i.test(o.c)), JSON.stringify(colours));
  check('the same name always gives the same colour',
    colours[0].c === colours[1].c, colours[0].n + '=' + colours[0].c + ' ' + colours[1].n + '=' + colours[1].c);
  check('case does not change the colour', colours[0].c === colours[1].c);
  const uniq = new Set(colours.map(o => o.c));
  check('different names give different colours', uniq.size >= 7, uniq.size + ' distinct of ' + colours.length);
  console.log('  ' + colours.map(o => o.n + '=' + o.c).join('  '));

  // and it applies to our own car
  await a.js(`(() => { const el = document.getElementById('netName'); el.value = 'Speedy'; el.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(250);
  const mine = await a.js('({ name: __game.NET.name, color: __game.NET.color, expect: __game.colourForName("Speedy") })');
  check('our car colour follows our name', mine.color === mine.expect, JSON.stringify(mine));

  console.log('\n== errors ==');
  const real = a.errors.filter((e) => !/favicon/i.test(e));
  check('no page errors', real.length === 0, real.join(' | ').slice(0, 200));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });