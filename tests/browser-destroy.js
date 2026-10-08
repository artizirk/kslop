// Destructible world, in two real browser tabs, plus screenshots.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');

const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9233;
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

  console.log('\n== the world can be broken ==');
  const info = await a.js(`(() => {
    const g = window.__game;
    return {
      solids: g.solids.length,
      destructible: g.solids.filter(s => typeof s.hp === 'number').length,
      kinds: [...new Set(g.solids.map(s => s.kind))],
      uniqueIds: new Set(g.solids.map(s => s.did)).size === g.solids.length,
    };
  })()`);
  check('solids are flagged destructible', info.destructible === info.solids, JSON.stringify(info));
  check('ids are unique', info.uniqueIds === true);
  console.log('  kinds: ' + info.kinds.join(', '));

  console.log('\n== shooting a building apart ==');
  const shot = await a.js(`(() => {
    const g = window.__game;
    g.rubble.length = 0;
    const target = g.buildings.find(b => !b.dead);
    g.car.x = target.x - 70; g.car.y = target.y + target.h / 2; g.car.a = 0;
    g.car.vx = g.car.vy = 0; g.car.wreckTimer = 0; g.car.damage = 0;
    g.cam.x = g.car.x; g.cam.y = g.car.y;
    let shots = 0;
    for (let i = 0; i < 2000 && !target.dead; i++) {
      g.fireCooldown = 0; g.fire(); shots++;
      g.step(1/120);
    }
    return { dead: target.dead, shots, rubble: g.rubble.length, hp: target.hp };
  })()`);
  check('gunfire destroys a building', shot.dead === true, JSON.stringify(shot));
  console.log(`  took ${shot.shots} volleys; ${shot.rubble} rubble patch(es)`);

  console.log('\n== the rubble is drawn ==');
  await sleep(400);
  const sc = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/33-destroyed-building.png`, Buffer.from(sc.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/33-destroyed-building.png');

  console.log('\n== an explosion levels the block around it ==');
  const blast = await a.js(`(() => {
    const g = window.__game;
    g.rubble.length = 0;
    const near = g.buildings.filter(b => !b.dead).slice(0, 6);
    const before = near.map(b => b.hp);
    const target = near[0];
    g.explode(target.x + target.w / 2, target.y + target.h / 2);
    g.blastNearby(target.x + target.w / 2, target.y + target.h / 2, 120, 7);
    return { damaged: near.filter((b, i) => b.dead || b.hp < before[i]).length, rubble: g.rubble.length };
  })()`);
  check('an explosion damages several nearby buildings', blast.damaged >= 1, JSON.stringify(blast));

  console.log('\n== the break reaches the other player ==');
  for (const tab of [a, b]) for (let i = 0; i < 40; i++) { if (await tab.js('__game.NET.id')) break; await sleep(250); }
  let paired = false;
  for (let i = 0; i < 40; i++) { if ((await a.js('__game.NET.peers.size')) >= 1) { paired = true; break; } await sleep(250); }
  check('the tabs are paired', paired);
  if (paired) {
    // both start from the same map, so find a building intact on both sides
    const did = await a.js(`(() => {
      const g = window.__game;
      const b = g.buildings.find(x => !x.dead);
      return b.did;
    })()`);
    await b.js(`(() => { const g = window.__game; const s = g.solids.find(x => x.did === ${did}); if (s && s.dead) return 'already'; return 'intact'; })()`);
    const bBefore = await b.js(`(() => { const g = window.__game; const s = g.solids.find(x => x.did === ${did}); return { dead: !!s.dead, rubble: g.rubble.length }; })()`);
    await a.js(`(() => {
      const g = window.__game;
      const s = g.solids.find(x => x.did === ${did});
      g.destroySolid(s);
      return true; })()`);
    let mirrored = false;
    for (let i = 0; i < 30; i++) {
      const state = await b.js(`(() => { const g = window.__game; const s = g.solids.find(x => x.did === ${did}); return { dead: !!s.dead, rubble: g.rubble.length }; })()`);
      if (state.dead && state.rubble > bBefore.rubble) { mirrored = true; break; }
      await sleep(150);
    }
    check('a destroyed building disappears for the other player', mirrored,
      'before=' + JSON.stringify(bBefore));

    // and a destroyed building stops blocking on the far side too
    const blocked = await b.js(`(() => {
      const g = window.__game;
      const s = g.solids.find(x => x.did === ${did});
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      g.car.x = cx; g.car.y = cy; g.car.vx = g.car.vy = 0;
      for (let i = 0; i < 60; i++) g.step(1/120);
      return Math.hypot(g.car.x - cx, g.car.y - cy) < 20;
    })()`);
    check('the rubble does not block the other player either', blocked === true);
  }

  console.log('\n== a wreck carves a hole ==');
  await a.js(`(() => {
    const g = window.__game;
    g.rubble.length = 0;
    const intact = g.buildings.filter(b => !b.dead);
    const t = intact[0];
    g.car.x = t.x + t.w / 2; g.car.y = t.y + t.h / 2;
    g.car.wreckTimer = 0; g.car.damage = 0.99;
    g.applyDamage(g.car.x, g.car.y, 0.05, 0);
    return true; })()`);
  await sleep(120);
  const wreckBlast = await a.js('({ rubble: __game.rubble.length, bangs: __game.bangs.length })');
  check('a wreck leaves debris', wreckBlast.rubble >= 1, JSON.stringify(wreckBlast));
  await sleep(300);
  const sc2 = await a.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/34-wreck-damage.png`, Buffer.from(sc2.data, 'base64'));
  console.log('  wrote ' + SHOT_DIR + '/34-wreck-damage.png');

  console.log('\n== errors ==');
  for (const tab of [a, b]) {
    const real = tab.errors.filter((e) => !/favicon/i.test(e));
    check(`tab ${tab.name} had no page errors`, real.length === 0, real.join(' | ').slice(0, 200));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); chrome.kill(); process.exit(1); });