// Item boxes, abilities and the kill feed, in two real browser tabs.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9231;
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
      key: (type, k, code, vk) => send('Input.dispatchKeyEvent', {
        type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        text: type === 'keyDown' ? k : undefined,
      }),
    };
  }

  const a = await openTab('A');
  const b = await openTab('B');

  console.log('\n== boxes exist in the page ==');
  const boxInfo = await a.js(`(() => {
    const g = window.__game;
    const kinds = {};
    return {
      count: g.boxes.length,
      active: g.boxes.filter(b => b.active).length,
      items: g.ITEMS,
      info: Object.fromEntries(g.ITEMS.map(k => [k, g.ITEM_INFO[k].label])),
      onRoadOrLot: g.boxes.every(b => g.insideRoad(b.x, b.y) ||
        g.lots.some(l => b.x > l.x && b.x < l.x + l.w && b.y > l.y && b.y < l.y + l.h)),
      clear: g.boxes.every(b => g.clearOfSolids(b.x, b.y, 20)),
      kinds,
    };
  })()`);
  check('boxes are placed', boxInfo.count >= 10, 'count=' + boxInfo.count);
  check('boxes sit on roads or lots', boxInfo.onRoadOrLot === true);
  check('boxes avoid solid objects', boxInfo.clear === true);
  check('the box pool covers abilities and guns', boxInfo.items.length >= 5, JSON.stringify(boxInfo.items));
  console.log('  items: ' + boxInfo.items.map(k => k + '=' + boxInfo.info[k]).join(', '));

  console.log('\n== driving through a box collects it ==');
  const collect = await a.js(`(() => {
    const g = window.__game;
    g.car.item = null;
    // repairs heal on pickup and guns arm you, so pick a plain ability box
    const plain = (k) => !g.isWeapon(k) && k !== 'repair';
    const box = g.boxes.find(b => b.active && plain(b.kind));
    g.car.x = box.x; g.car.y = box.y; g.car.vx = 0; g.car.vy = 0;
    g.car.wreckTimer = 0;
    g.updateBoxes(1/120);
    return { item: g.car.item, boxActive: box.active, id: box.id, kind: box.kind };
  })()`);
  check('a box hands over an item', !!collect.item, JSON.stringify(collect));
  check('the box is consumed', collect.boxActive === false);

  console.log('\n== the other player sees the box go ==');
  for (const tab of [a, b]) for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  let paired = false;
  for (let i = 0; i < 40; i++) { if ((await a.js('__game.NET.peers.size')) >= 1) { paired = true; break; } await sleep(250); }
  check('the tabs are paired', paired);
  if (paired) {
    const boxId = await a.js("(() => { const g = __game; const plain = (k) => !g.isWeapon(k) && k !== 'repair'; const b = g.boxes.find(x => x.active && plain(x.kind)); return b.id; })()");
    await b.js(`(() => { const b = __game.boxes.find(x => x.id === ${boxId}); b.active = true; b.timer = 0; return true; })()`);
    // A takes it
    await a.js(`(() => {
      const g = window.__game;
      const b = g.boxes.find(x => x.id === ${boxId});
      g.car.item = null; g.car.x = b.x; g.car.y = b.y; g.car.vx = 0; g.car.vy = 0;
      g.updateBoxes(1/120);
      return true; })()`);
    let seen = false;
    for (let i = 0; i < 25; i++) {
      seen = await b.js(`!__game.boxes.find(x => x.id === ${boxId}).active`);
      if (seen) break;
      await sleep(120);
    }
    check('the taken box disappears for the other player', seen === true);

    console.log('\n== abilities are visible to the other player ==');
    await a.js(`(() => {
      __game.car.item = 'shield'; __game.useItem();
      __game.NET.lastSend = 0; __game.netTick();   // flush immediately
      return true; })()`);
    let sawShield = false;
    for (let i = 0; i < 25; i++) {
      sawShield = await b.js(`(() => { const p = [...__game.NET.peers.values()][0]; return p ? !!p.sh : false; })()`);
      if (sawShield) break;
      await a.js('(() => { __game.NET.lastSend = 0; __game.netTick(); return true; })()');
      await sleep(120);
    }
    check('a remote shield is relayed', sawShield === true);

    await a.js(`(() => {
      __game.car.item = 'boost'; __game.useItem();
      __game.NET.lastSend = 0; __game.netTick();
      return true; })()`);
    let sawBoost = false;
    for (let i = 0; i < 25; i++) {
      sawBoost = await b.js(`(() => { const p = [...__game.NET.peers.values()][0]; return p ? !!p.bo : false; })()`);
      if (sawBoost) break;
      await a.js('(() => { __game.NET.lastSend = 0; __game.netTick(); return true; })()');
      await sleep(120);
    }
    check('a remote boost is relayed', sawBoost === true);

    console.log('\n== mines are shared ==');
    const minesBefore = await b.js('__game.mines.length');
    await a.js(`(() => { __game.mines.length = 0; __game.car.item = 'mine'; __game.useItem(); return true; })()`);
    let sawMine = false;
    for (let i = 0; i < 25; i++) {
      sawMine = (await b.js('__game.mines.length')) > minesBefore;
      if (sawMine) break;
      await sleep(120);
    }
    check('a dropped mine appears for the other player', sawMine === true);
    check('the mine is armed with a delay', await b.js('__game.mines.length ? __game.mines[0].arm > 0 : false') === true);
  }

  console.log('\n== kill feed ==');
  await a.js('(() => { __game.killFeed.length = 0; return true; })()');
  // A wrecks, crediting whoever last hit them (nobody), so it should show as a solo wreck
  await a.js(`(() => {
    __game.car.shieldTimer = 0;
    __game.car.lastHitBy = null;
    __game.car.wreckTimer = 0; __game.car.damage = 0.99;
    __game.applyDamage(__game.car.x, __game.car.y, 0.05, 0);
    return true; })()`);
  let feedSeen = false;
  for (let i = 0; i < 25; i++) {
    feedSeen = (await a.js('__game.killFeed.length')) > 0;
    if (feedSeen) break;
    await sleep(120);
  }
  check('a wreck lands in the kill feed', feedSeen === true, 'entries=' + (await a.js('__game.killFeed.length')));
  const entry = await a.js('__game.killFeed[0]');
  check('the feed names the victim', entry && typeof entry.victimName === 'string' && entry.victimName.length > 0,
    JSON.stringify(entry));

  // and it should show on the other player's screen too
  if (paired) {
    await b.js('(() => { __game.killFeed.length = 0; return true; })()');
    const bId = await b.js('__game.NET.id');
    await a.js(`(() => { __game.car.shieldTimer = 0; __game.car.lastHitBy = ${bId}; __game.car.wreckTimer = 0; __game.car.damage = 0.99;
      __game.applyDamage(__game.car.x, __game.car.y, 0.05, 0); return true; })()`);
    let sharedFeed = false;
    for (let i = 0; i < 25; i++) {
      sharedFeed = (await b.js('__game.killFeed.length')) > 0;
      if (sharedFeed) break;
      await sleep(120);
    }
    check('the kill feed is shared with other players', sharedFeed === true);
    const shared = await b.js('__game.killFeed[0]');
    check('the shared entry credits the killer by name', shared && shared.byName === (await b.js('__game.NET.name')),
      JSON.stringify(shared));
  }

  console.log('\n== screenshots ==');
  await a.js(`(() => {
    const g = window.__game;
    const b = g.boxes.find(x => x.active);
    g.car.x = b.x - 90; g.car.y = b.y; g.car.a = 0;
    g.cam.x = g.car.x; g.cam.y = g.car.y;
    return true; })()`);
  await sleep(400);
  let s1 = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/29-item-box.png`, Buffer.from(s1.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/29-item-box.png');

  await a.js(`(() => {
    const g = window.__game;
    g.car.item = 'shield'; g.useItem();
    g.car.item = 'boost';
    g.car.boostTimer = 1.5;
    g.killFeed.length = 0;
    g.pushKillFeed({ by: g.NET.id, victim: 3 });
    g.pushKillFeed({ by: null, victim: 4 });
    return true; })()`);
  await sleep(400);
  s1 = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/30-item-hud.png`, Buffer.from(s1.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/30-item-hud.png');

  console.log('\n== errors ==');
  for (const tab of [a, b]) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 200));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });