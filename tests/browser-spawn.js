// Verify the two new features across two real browser tabs: randomised
// respawn, and seeing the other player's health.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9230;
const PAGE = `http://127.0.0.1:${RELAY}/?seed=20251008&audio=0`;
const SHOT_DIR = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu', '--mute-audio',
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
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++sseq; spend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      raw(JSON.stringify({ id, sessionId, method, params }));
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: PAGE });
    await sleep(1600);
    return {
      name, errors, send,
      js: async (e) => {
        const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }

  const a = await openTab('A');
  const b = await openTab('B');

  console.log('\n== randomised respawn ==');
  const poses = await a.js(`(() => {
    const seen = new Set(); let badHeading = 0, offRoad = 0, blocked = 0;
    for (let i = 0; i < 60; i++) {
      __game.respawn();
      seen.add(Math.round(__game.car.x) + ',' + Math.round(__game.car.y));
      const q = Math.round(__game.car.a / (Math.PI/2)) % 4;
      if (Math.abs(__game.car.a - q * Math.PI/2) > 1e-6) badHeading++;
      if (!__game.insideRoad(__game.car.x, __game.car.y)) offRoad++;
      if (!__game.clearOfSolids(__game.car.x, __game.car.y, 30)) blocked++;
    }
    return { distinct: seen.size, badHeading, offRoad, blocked };
  })()`);
  check('respawn lands somewhere different each time', poses.distinct > 10, 'distinct=' + poses.distinct);
  check('every respawn is on a road', poses.offRoad === 0, poses.offRoad + ' off-road');
  check('no respawn is inside an obstacle', poses.blocked === 0, poses.blocked + ' blocked');
  check('respawn always faces down a road', poses.badHeading === 0, poses.badHeading + ' odd headings');

  console.log('\n== other players are placed clear of us ==');
  for (const tab of [a, b]) {
    for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  }
  let paired = false;
  for (let i = 0; i < 40; i++) { if ((await a.js('__game.NET.peers.size')) >= 1) { paired = true; break; } await sleep(250); }
  check('the tabs are paired', paired);
  if (paired) {
    const apart = await a.js(`(() => {
      const p = [...__game.NET.peers.values()][0];
      let min = Infinity;
      for (let i = 0; i < 40; i++) {
        __game.respawn();
        min = Math.min(min, Math.hypot(__game.car.x - p.x, __game.car.y - p.y));
      }
      return min;
    })()`);
    check('respawn keeps a gap from the other player', apart > 150, 'closest=' + apart.toFixed(0) + 'px');
  }

  console.log('\n== other player health ==');
  // B takes damage; A should see it in the relayed state
  const bId = await b.js('__game.NET.id');
  await b.js('(() => { __game.car.damage = 0; return true; })()');
  let seenDamage = -1;
  for (let i = 0; i < 25; i++) {
    const p = await a.js(`(() => { const p = __game.NET.peers.get(${bId}); return p ? p.damage : -1; })()`);
    if (p === 0) { seenDamage = 0; break; }
    await sleep(120);
  }
  check('healthy remote players read as undamaged', seenDamage === 0, 'damage=' + seenDamage);

  await b.js('(() => { __game.car.damage = 0.4; return true; })()');
  let midDamage = -1;
  for (let i = 0; i < 30; i++) {
    midDamage = await a.js(`(() => { const p = __game.NET.peers.get(${bId}); return p ? p.damage : -1; })()`);
    if (Math.abs(midDamage - 0.4) < 0.02) break;
    await sleep(120);
  }
  check('damage is relayed to the other player', Math.abs(midDamage - 0.4) < 0.05, 'damage=' + midDamage);

  await b.js('(() => { __game.car.damage = 0.95; return true; })()');
  let lowDamage = 0;
  for (let i = 0; i < 30; i++) {
    lowDamage = await a.js(`(() => { const p = __game.NET.peers.get(${bId}); return p ? p.damage : -1; })()`);
    if (lowDamage > 0.9) break;
    await sleep(120);
  }
  check('near-wreck damage is relayed too', lowDamage > 0.9, 'damage=' + lowDamage);

  console.log('\n== health is actually drawn ==');
  // put the two cars close together and screenshot A's view of B
  await a.js(`(() => { const p = __game.NET.peers.get(${bId});
    __game.car.x = p.x - 150; __game.car.y = p.y; __game.car.a = 0;
    __game.cam.x = __game.car.x; __game.cam.y = __game.car.y; return true; })()`);
  await sleep(400);
  const shot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/27-remote-health.png`, Buffer.from(shot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/27-remote-health.png');

  // the overlay list should show a bar for each peer
  await a.js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))");
  await sleep(400);
  const list = await a.js(`(() => {
    const rows = [...document.querySelectorAll('#netPeers .hpbar')];
    return { bars: rows.length, widths: rows.map(r => r.querySelector('i').style.width) };
  })()`);
  check('the player list shows a health bar per peer', list.bars >= 1, JSON.stringify(list));
  check('the bar reflects their damage', list.widths.some(w => parseInt(w, 10) <= 10),
    JSON.stringify(list.widths));
  const panelShot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/28-health-panel.png`, Buffer.from(panelShot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/28-health-panel.png');

  console.log('\n== spawn on a real respawn ==');
  // Drive the fixed timestep directly rather than waiting on wall-clock frames:
  // a background tab has requestAnimationFrame throttled, so a real-time wait
  // here would measure the browser's scheduling, not the game.
  const cycle = await a.js(`(() => {
    __game.car.damage = 0.99;
    __game.applyDamage(__game.car.x, __game.car.y, 0.05, 0);
    const wasWrecked = __game.car.wreckTimer > 0;
    const bangsAtWreck = __game.bangs.length;
    for (let i = 0; i < 400; i++) __game.step(1 / 120);   // past the 2.4s wreck timer
    return {
      wasWrecked, bangsAtWreck,
      wreck: __game.car.wreckTimer, damage: __game.car.damage,
      onRoad: __game.insideRoad(__game.car.x, __game.car.y),
      clear: __game.clearOfSolids(__game.car.x, __game.car.y, 30),
    };
  })()`);
  check('a wreck starts the respawn cycle', cycle.wasWrecked === true);
  check('the wreck produced a bang', cycle.bangsAtWreck >= 2, 'bangs=' + cycle.bangsAtWreck);
  check('the car respawns after a wreck', cycle.wreck === 0 && cycle.damage === 0, JSON.stringify(cycle));
  check('and respawns somewhere legal', cycle.onRoad && cycle.clear, JSON.stringify(cycle));

  console.log('\n== errors ==');
  for (const tab of [a, b]) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 200));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });