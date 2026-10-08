// Verify: nickname persistence, the leaderboard, and the server-driven reload.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9232;
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
const httpGet = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: RELAY, path }, (r) => {
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
    let sseq = 0; const spend = new Map(); const errors = []; const navs = [];
    ws.on('message', (m) => {
      const d = JSON.parse(m.toString());
      if (d.sessionId !== sessionId) return;
      if (d.id && spend.has(d.id)) { spend.get(d.id)(d); spend.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      if (d.method === 'Page.frameNavigated' && d.params.frame.parentId === undefined) navs.push(Date.now());
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++sseq; spend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      raw(JSON.stringify({ id, sessionId, method, params }));
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: PAGE });
    await sleep(1700);
    return {
      name, errors, navs, send,
      js: async (e) => {
        const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }

  const a = await openTab('A');
  const b = await openTab('B');

  console.log('\n== nickname persistence ==');
  const stored = await a.js('(() => { try { return localStorage.getItem("leonida.player"); } catch (e) { return "blocked"; } })()');
  console.log('  stored profile after first load:', stored);

  // set a nickname, then reload and check it comes back
  await a.js(`(() => {
    const el = document.getElementById('netName');
    el.value = 'Speedy';
    el.dispatchEvent(new Event('input'));
    return __game.NET.name;
  })()`);
  let saved = null;
  for (let i = 0; i < 10; i++) {
    saved = await a.js('(() => { try { return localStorage.getItem("leonida.player"); } catch (e) { return null; } })()');
    if (saved && saved.includes('Speedy')) break;
    await sleep(120);
  }
  check('the nickname is written to localStorage', !!saved && saved.includes('Speedy'), String(saved));

  await a.send('Page.reload');
  await sleep(1700);
  const after = await a.js('__game.NET.name');
  check('the nickname survives a reload', after === 'Speedy', 'name=' + after);
  const field = await a.js("document.getElementById('netName').value");
  check('the name box is refilled', field === 'Speedy', 'value=' + field);

  // a fresh tab should pick it up too
  const c = await openTab('C');
  const cName = await c.js('__game.NET.name');
  check('a new tab reuses the saved nickname', cName === 'Speedy', 'name=' + cName);

  console.log('\n== leaderboard ==');
  for (const tab of [a, b, c]) for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  let rows = [];
  for (let i = 0; i < 40; i++) {
    rows = await a.js('__game.NET.scores');
    if (rows.length >= 3) break;
    await sleep(200);
  }
  check('the server publishes a scoreboard', rows.length >= 3, 'rows=' + rows.length);
  check('every row has kills and deaths',
    rows.every(r => Number.isFinite(r.kills) && Number.isFinite(r.deaths)), JSON.stringify(rows));
  check('rows carry names', rows.every(r => typeof r.name === 'string' && r.name.length > 0), JSON.stringify(rows.map(r => r.name)));
  check('the board is sorted by kills', rows.every((r, i) => i === 0 || rows[i - 1].kills >= r.kills),
    JSON.stringify(rows.map(r => r.kills)));

  // record a kill and check the tally moves for both players
  const aId = await a.js('__game.NET.id');
  const bId = await b.js('__game.NET.id');
  const byId = (list, id) => list.find(r => r.id === id);
  const beforeA = byId(rows, aId) || { kills: 0, deaths: 0 };
  const beforeB = byId(rows, bId) || { kills: 0, deaths: 0 };

  // B wrecks, credited to A
  await b.js(`(() => {
    __game.car.shieldTimer = 0;
    __game.car.lastHitBy = ${aId};
    __game.car.wreckTimer = 0; __game.car.damage = 0.99;
    __game.applyDamage(__game.car.x, __game.car.y, 0.05, 0);
    return true; })()`);
  let afterRows = rows;
  for (let i = 0; i < 25; i++) {
    afterRows = await a.js('__game.NET.scores');
    const ra = byId(afterRows, aId), rb = byId(afterRows, bId);
    if (ra && rb && ra.kills === beforeA.kills + 1 && rb.deaths === beforeB.deaths + 1) break;
    await sleep(150);
  }
  const afterA = byId(afterRows, aId), afterB = byId(afterRows, bId);
  check('a credited kill increments the killer', afterA.kills === beforeA.kills + 1,
    `${beforeA.kills} -> ${afterA && afterA.kills}`);
  check('and the victim\'s death count', afterB.deaths === beforeB.deaths + 1,
    `${beforeB.deaths} -> ${afterB && afterB.deaths}`);

  // and the board appears in the panel
  await a.js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))");
  await sleep(400);
  const panel = await a.js(`(() => {
    const rows = [...document.querySelectorAll('#netBoard .lbrow')];
    return { rows: rows.length, text: rows.map(r => r.textContent.trim()).slice(0, 3) };
  })()`);
  check('the panel shows the leaderboard', panel.rows >= 3, JSON.stringify(panel));
  console.log('  panel rows: ' + JSON.stringify(panel.text));

  const shot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/31-leaderboard.png`, Buffer.from(shot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/31-leaderboard.png');

  await a.js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))");
  await sleep(300);
  const onScreen = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/32-leaderboard-hud.png`, Buffer.from(onScreen.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/32-leaderboard-hud.png');

  console.log('\n== server-driven reload ==');
  const health = await httpGet('/health');
  check('health reports a build id', typeof health.build === 'string' && health.build.length > 0, JSON.stringify(health.build));

  const navsBefore = c.navs.length;
  const res = await httpGet('/reload?token=' + encodeURIComponent(process.env.TOKEN || 'test-token'));
  check('the reload endpoint answers', res.ok === true, JSON.stringify(res));
  let reloaded = false;
  for (let i = 0; i < 30; i++) {
    if (c.navs.length > navsBefore) { reloaded = true; break; }
    await sleep(200);
  }
  check('every client is told to reload', reloaded, 'navigations=' + (c.navs.length - navsBefore));
  await sleep(1200);
  check('the client comes back after reloading', await c.js('!!window.__game.car'));

  console.log('\n== editing the page pushes a reload ==');
  const navsBefore2 = (await a.js('1'), c.navs.length);
  // touch index.html the way an editor would
  const idx = path.join(__dirname, '..', 'index.html');
  const body = fs.readFileSync(idx, 'utf8');
  fs.writeFileSync(idx, body.replace('</body>', '<!-- build probe -->\n</body>'));
  let autoReloaded = false;
  for (let i = 0; i < 40; i++) {
    if (c.navs.length > navsBefore2) { autoReloaded = true; break; }
    await sleep(250);
  }
  fs.writeFileSync(idx, body);   // restore exactly
  check('saving index.html reloads open clients automatically', autoReloaded,
    'navigations=' + (c.navs.length - navsBefore2));

  console.log('\n== errors ==');
  for (const tab of [a, b, c]) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 200));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });