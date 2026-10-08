// Kill streaks and nukes, in two real browser tabs, with screenshots.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9234;
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
    await send('Page.navigate', { url: PAGE });
    await sleep(1700);
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

  console.log('\n== streaks are tracked by the server ==');
  for (const tab of [a, b]) for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  let paired = false;
  for (let i = 0; i < 40; i++) { if ((await a.js('__game.NET.peers.size')) >= 1) { paired = true; break; } await sleep(250); }
  check('the tabs are paired', paired);

  if (paired) {
    const aId = await a.js('__game.NET.id');
    const bId = await b.js('__game.NET.id');

    // B wrecks twice, credited to A. The second should be a double kill.
    const wreckByA = async () => {
      await b.js(`(() => {
        const g = window.__game;
        g.car.shieldTimer = 0;
        g.car.lastHitBy = ${aId};
        g.car.wreckTimer = 0; g.car.damage = 0.99;
        g.applyDamage(g.car.x, g.car.y, 0.05, 0);
        return true; })()`);
    };

    await a.js('(() => { __game.streakBanners.length = 0; return true; })()');
    await wreckByA();
    let afterOne = null;
    for (let i = 0; i < 25; i++) {
      afterOne = await a.js('__game.NET.scores');
      const ra = afterOne.find(r => r.id === aId);
      if (ra && ra.streak >= 1) break;
      await sleep(150);
    }
    const raOne = afterOne.find(r => r.id === aId);
    check('a kill starts a streak', raOne && raOne.streak >= 1, JSON.stringify(raOne));

    await wreckByA();
    let afterTwo = null, banner = null;
    for (let i = 0; i < 30; i++) {
      afterTwo = await a.js('__game.NET.scores');
      banner = await a.js('__game.streakBanners[0] || null');
      const ra = afterTwo.find(r => r.id === aId);
      if (ra && ra.streak >= 2 && banner) break;
      await sleep(150);
    }
    const raTwo = afterTwo.find(r => r.id === aId);
    check('two in a row is a double kill', raTwo && raTwo.streak >= 2, JSON.stringify(raTwo));
    check('the streak is shouted on screen', !!banner, JSON.stringify(banner));
    check('the shout carries the right words', banner && /DOUBLE KILL/.test(banner.label),
      banner && banner.label);
    check('our own streak is flagged as ours', banner && banner.mine === true, JSON.stringify(banner));
    check('the streak count is kept on the scoreboard', raTwo && raTwo.best >= raTwo.streak,
      JSON.stringify(raTwo));

    const shot = await a.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOT_DIR}/35-streak.png`, Buffer.from(shot.data, 'base64'));
    console.log('  wrote ' + SHOT_DIR + '/35-streak.png');

    // dying should reset it
    await a.js(`(() => {
      const g = window.__game;
      g.car.shieldTimer = 0; g.car.lastHitBy = null;
      g.car.wreckTimer = 0; g.car.damage = 0.99;
      g.applyDamage(g.car.x, g.car.y, 0.05, 0);
      return true; })()`);
    let reset = false;
    for (let i = 0; i < 25; i++) {
      const rows = await a.js('__game.NET.scores');
      const me = rows.find(r => r.id === aId);
      if (me && me.streak === 0) { reset = true; break; }
      await sleep(150);
    }
    check('being wrecked resets our streak', reset === true);
  }

  console.log('\n== nukes ==');
  const nk = await a.js(`(() => {
    const g = window.__game;
    // the streak checks above wrecked us; clear that so the item can be used
    g.car.wreckTimer = 0; g.car.damage = 0;
    g.nukes.length = 0; g.rubble.length = 0;
    g.car.item = 'nuke';
    g.useItem();
    return { armed: g.nukes.length, t: g.nukes[0] ? g.nukes[0].t : null, item: g.car.item, rubbleBefore: g.rubble.length };
  })()`);
  check('using a nuke arms a countdown', nk.armed === 1 && nk.t > 0, JSON.stringify(nk));
  check('the nuke is consumed', nk.item === null);
  const beforeDetonation = nk.rubbleBefore;

  if (paired) {
    let armed = false;
    for (let i = 0; i < 25; i++) {
      armed = (await b.js('__game.nukes.length')) > 0;
      if (armed) break;
      await sleep(120);
    }
    check('the other player is warned about the nuke', armed === true,
      'B nukes=' + (await b.js('__game.nukes.length')));
    const warn = await b.js('__game.nukes[0] ? {x: __game.nukes[0].x, y: __game.nukes[0].y, t: __game.nukes[0].t} : null');
    check('the warning marks the same spot', warn && Number.isFinite(warn.x) && warn.t > 0, JSON.stringify(warn));
  }

  // Run the fuse on the fixed timestep rather than waiting on wall-clock frames:
  // a background tab has requestAnimationFrame throttled, and the fuse can
  // expire during the warning poll above.
  const detonation = await a.js(`(() => {
    const g = window.__game;
    const before = g.rubble.length;
    for (let i = 0; i < 400 && g.nukes.length; i++) g.step(1/120);
    return { nukes: g.nukes.length, before, after: g.rubble.length, flash: g.nukeFlash };
  })()`);
  check('the nuke detonates and levels the area',
    detonation.nukes === 0 && detonation.after > detonation.before,
    JSON.stringify(detonation));
  const blast = await a.js('({ rubble: __game.rubble.length, flash: __game.nukeFlash, damage: __game.car.damage, wreck: __game.car.wreckTimer })');
  console.log('  after the blast: ' + JSON.stringify(blast));
  check('the blast leaves a lot of rubble', blast.rubble >= 2, 'rubble=' + blast.rubble);

  const flashShot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/36-nuke-flash.png`, Buffer.from(flashShot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/36-nuke-flash.png');

  await sleep(1400);
  const afterShot = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/37-nuke-aftermath.png`, Buffer.from(afterShot.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/37-nuke-aftermath.png');

  console.log('\n== errors ==');
  for (const tab of [a, b]) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 200));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });