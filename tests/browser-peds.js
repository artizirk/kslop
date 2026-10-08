const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');
const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9241;
const PAGE = `http://127.0.0.1:${RELAY}/?seed=20251008`;
const SHOT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,720', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
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
  await send('Page.navigate', { url: PAGE });
  await sleep(1900);

  console.log('\n== the rebuilt file is whole ==');
  const feats = await js(`(() => { const g = window.__game; return {
    peds: g.peds.length, cash: typeof g.dropCash, weapons: Object.keys(g.WEAPONS).length,
    items: g.ITEMS.length, boxes: g.boxes.length, nuke: typeof g.armNuke,
    destroy: typeof g.destroySolid, feed: typeof g.pushKillFeed, streak: typeof g.pushStreak,
    board: g.NET.scores.length, guns: g.car.guns.length, money: g.car.money,
    death: typeof g.drawDeathScreen, tag: typeof g.drawCarTag, seed: g.WORLD_SEED,
  }; })()`);
  console.log('  ' + JSON.stringify(feats));
  check('pedestrians exist', feats.peds > 10, 'peds=' + feats.peds);
  check('every prior feature survived the rebuild',
    feats.weapons >= 13 && feats.items >= 17 && feats.boxes > 5 &&
    feats.nuke === 'function' && feats.destroy === 'function' && feats.feed === 'function' &&
    feats.streak === 'function' && feats.death === 'function' && feats.tag === 'function',
    JSON.stringify(feats));

  console.log('\n== money ==');
  await js('(() => { __game.car.money = 0; return true; })()');
  // Do the whole run in one call, on open ground: a pavement pedestrian has a
  // building behind them, and the car would be shoved to a stop before it moved.
  await js(`(() => {
    const g = window.__game;
    const saved = g.solids.splice(0, g.solids.length);
    g.car.money = 0;
    const p = g.peds.find(x => x.alive);
    g.car.x = g.WORLD / 2; g.car.y = g.WORLD / 2; g.car.a = 0;
    g.car.vx = 380; g.car.vy = 0; g.car.damage = 0; g.car.wreckTimer = 0;
    p.x = g.car.x + 40; p.y = g.car.y; p.panic = 0;
    for (let i = 0; i < 90; i++) { g.car.x += g.car.vx / 120; g.updatePeds(1/120); }
    g.solids.push(...saved);
    return true; })()`);
  const money = await js('({ money: __game.car.money, dead: __game.peds.filter(p => !p.alive).length, cash: __game.cash.length, popups: __game.popups.length })');
  console.log('  ' + JSON.stringify(money));
  check('running people over pays', money.money > 0, 'money=' + money.money);

  await js(`(() => {
    const g = window.__game;
    const p = g.peds.find(x => x.alive);
    g.car.x = p.x - 70; g.car.y = p.y - 40; g.cam.x = g.car.x; g.cam.y = g.car.y;
    return true; })()`);
  await sleep(400);
  await shot('43-pedestrians');

  await js(`(() => {
    const g = window.__game;
    g.dropCash(g.car.x + 40, g.car.y, 60);
    g.popups.push({ x: g.car.x + 40, y: g.car.y - 10, text: '+60', life: 1.4, color: '#4bd07a' });
    g.car.money = 1240;
    return true; })()`);
  await sleep(300);
  await shot('44-money');

  console.log('\n== errors ==');
  check('no page errors', errors.filter(e => !/favicon/.test(e)).length === 0, errors.join(' | ').slice(0, 200));
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message); chrome.kill(); process.exit(1); });
