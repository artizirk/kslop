// Screenshot the death screen, the arsenal HUD and the own-car health bar.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9240;
const PAGE = `http://127.0.0.1:${RELAY}/?seed=20251008&audio=0`;
const SHOT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu', '--mute-audio',
  '--hide-scrollbars', '--window-size=1280,720', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  'about:blank',
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
  let seq = 0; const pend = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m.toString()); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    raw(JSON.stringify({ id, method, params }));
  });
  const js = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${SHOT}/${n}.png`, Buffer.from(r.data, 'base64'));
    console.log('  wrote ' + SHOT + '/' + n + '.png');
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1900);

  console.log('\n== seed ==');
  console.log('  WORLD_SEED =', await js('__game.WORLD_SEED'));
  console.log('  buildings  =', await js('__game.buildings.length'));

  console.log('\n== own health bar ==');
  await js(`(() => {
    const g = window.__game;
    g.car.x = 1160; g.car.y = 460; g.car.a = 0; g.car.damage = 0.35;
    g.cam.x = g.car.x; g.cam.y = g.car.y;
    g.NET.name = 'Speedy'; g.NET.color = g.colourForName('Speedy');
    return true; })()`);
  await sleep(400);
  await shot('39-own-health');

  console.log('\n== arsenal ==');
  await js(`(() => {
    const g = window.__game;
    g.resetGuns(); g.giveGun('smg'); g.giveGun('shotgun'); g.giveGun('rpg');
    g.car.damage = 0.6; g.car.item = 'shield';
    return true; })()`);
  await sleep(400);
  await shot('40-arsenal');

  console.log('\n== death screen ==');
  const state = await js(`(() => {
    const g = window.__game;
    g.car.wreckTimer = g.WRECK_TIME - 1.0;   // part way through the fade
    g.car.lastHitBy = 42;
    return { wreck: g.car.wreckTimer, time: g.WRECK_TIME };
  })()`);
  console.log('  ' + JSON.stringify(state));
  await sleep(120);
  await shot('41-death-screen');

  console.log('\n== the world is breakable from here ==');
  await js(`(() => {
    const g = window.__game;
    g.car.wreckTimer = 0; g.car.damage = 0;
    const b = g.buildings.filter(x => !x.dead)[3];
    g.car.x = b.x - 40; g.car.y = b.y + b.h / 2; g.car.a = 0;
    g.cam.x = g.car.x; g.cam.y = g.car.y;
    for (let i = 0; i < 12; i++) { g.fireCooldown = 0; g.fire(); g.step(1/120); }
    return true; })()`);
  await sleep(300);
  await shot('42-shooting-up');

  console.log('\n== page errors ==');
  console.log('  alive:', await js('!!window.__game.car'));
  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error('ERROR: ' + e.message); chrome.kill(); process.exit(1); });