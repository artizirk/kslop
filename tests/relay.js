const path = require('path');
// Two real WebSocket clients against the real server: no codes, auto-join,
// and car state actually relayed from one to the other.
const WebSocket = require('./ws');
const http = require('http');

const PORT = Number(process.env.RELAY_PORT || 8099);
const URL = `ws://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.msgs = [];
    ws.on('message', (d) => { try { ws.msgs.push(JSON.parse(d.toString())); } catch (e) {} });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const waitFor = async (ws, pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find(pred);
    if (m) return m;
    await sleep(40);
  }
  return null;
};
const clear = (ws) => { ws.msgs.length = 0; };
const httpGet = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  console.log('\n== auto-join, no codes ==');
  const a = await connect();
  const wA = await waitFor(a, (m) => m.t === 'welcome');
  check('a lone client gets a welcome immediately', !!wA);
  check('welcome carries an id', typeof wA.id === 'number', 'id=' + wA.id);
  check('welcome carries a roster', Array.isArray(wA.roster), JSON.stringify(wA.roster));
  check('there is no room code to supply', !('room' in wA));

  const b = await connect();
  const wB = await waitFor(b, (m) => m.t === 'welcome');
  check('second client gets a different id', wB.id !== wA.id, `${wA.id} vs ${wB.id}`);
  check('second client sees the first in the roster', wB.roster.some((p) => p.id === wA.id), JSON.stringify(wB.roster));
  const joined = await waitFor(a, (m) => m.t === 'peer-joined' && m.id === wB.id);
  check('first is told the second arrived', !!joined);

  console.log('\n== names ==');
  clear(a); clear(b);
  send(a, { t: 'hello', name: 'Ava', color: '#2f5f9e' });
  send(b, { t: 'hello', name: 'Bo', color: '#3d8f6b' });
  await sleep(250);
  const rosterMsg = [...a.msgs, ...b.msgs].filter((m) => m.t === 'roster').pop();
  check('roster broadcasts both names', !!rosterMsg && rosterMsg.roster.length === 2 &&
    rosterMsg.roster.some((p) => p.name === 'Ava') && rosterMsg.roster.some((p) => p.name === 'Bo'),
    JSON.stringify(rosterMsg && rosterMsg.roster));

  console.log('\n== car state relay ==');
  clear(a); clear(b);
  send(a, { t: 'state', x: 123, y: 456, a: 1.25, hb: 1, d: 0.4, sk: 1, sx0: 1, sy0: 2, sx1: 3, sy1: 4 });
  const gotB = await waitFor(b, (m) => m.t === 'state');
  check('state reaches the other client', !!gotB, JSON.stringify(gotB));
  check('state is stamped with the sender', gotB.from === wA.id, 'from=' + gotB.from);
  check('position survives the relay', gotB.x === 123 && gotB.y === 456);
  check('heading survives', Math.abs(gotB.a - 1.25) < 1e-6);
  check('handbrake survives', gotB.hb === 1);
  check('damage survives', Math.abs(gotB.d - 0.4) < 1e-6);
  check('skid data survives', gotB.sk === 1 && gotB.sx0 === 1 && gotB.sy1 === 4);
  check('state is NOT echoed to the sender', !a.msgs.some((m) => m.t === 'state'),
    JSON.stringify(a.msgs.filter((m) => m.t === 'state')));

  console.log('\n== directed bump ==');
  clear(b);
  send(a, { t: 'bump', to: wB.id, vx: -300, vy: 10 });
  const bump = await waitFor(b, (m) => m.t === 'bump');
  check('bump reaches the addressed client', !!bump && bump.vx === -300, JSON.stringify(bump));
  check('bump is stamped with the sender', bump.from === wA.id);

  console.log('\n== third client ==');
  const c = await connect();
  const wC = await waitFor(c, (m) => m.t === 'welcome');
  check('third client sees both others',
    wC.roster.some((p) => p.id === wA.id) && wC.roster.some((p) => p.id === wB.id),
    JSON.stringify(wC.roster));
  check('everyone in the roster has a usable name',
    wC.roster.every((p) => typeof p.name === 'string' && p.name.length > 0),
    JSON.stringify(wC.roster.map((p) => p.name)));
  await sleep(150);
  clear(c);
  send(a, { t: 'state', x: 9, y: 9, a: 0 });
  await sleep(250);
  check('state fans out to every other client', b.msgs.some((m) => m.t === 'state') && c.msgs.some((m) => m.t === 'state'));

  console.log('\n== gunfire and explosions relay ==');
  clear(b); clear(c);
  send(a, { t: 'fire', x: 300, y: 400, a: 1.2, vx: 100, vy: -20 });
  const fireMsg = await waitFor(b, (m) => m.t === 'fire');
  check('gunfire reaches the other player', !!fireMsg, JSON.stringify(fireMsg));
  check('gunfire carries a position and angle', fireMsg && fireMsg.x === 300 && Math.abs(fireMsg.a - 1.2) < 1e-6);
  check('gunfire is stamped with the shooter', fireMsg && fireMsg.from === wA.id);
  check('gunfire is not echoed to the shooter', !a.msgs.some((m) => m.t === 'fire'));

  clear(b);
  send(a, { t: 'bang', x: 500, y: 600 });
  const bangMsg = await waitFor(b, (m) => m.t === 'bang');
  check('an explosion reaches the other player', !!bangMsg && bangMsg.x === 500 && bangMsg.y === 600,
    JSON.stringify(bangMsg));

  clear(a);
  send(b, { t: 'hit', to: wA.id, dmg: 0.08 });
  const hitMsg = await waitFor(a, (m) => m.t === 'hit');
  check('a bullet hit is routed to the player it hit', !!hitMsg && hitMsg.dmg === 0.08, JSON.stringify(hitMsg));
  check('the hit names the shooter', hitMsg && hitMsg.from === wB.id);

  // nonsense must not be relayed
  clear(a); clear(c);
  send(a, { t: 'fire', x: NaN, y: 1, a: 0 });
  send(a, { t: 'fire', y: 1, a: 0 });
  send(a, { t: 'bang' });
  send(a, { t: 'hit', to: wB.id, dmg: 'lots' });
  await sleep(250);
  check('malformed events are dropped', !c.msgs.some((m) => m.t === 'fire' || m.t === 'bang'));
  check('a non-numeric hit is not relayed', !b.msgs.some((m) => m.t === 'hit'));

  // and a peer cannot exceed the damage cap the client enforces
  clear(c);
  send(a, { t: 'hit', to: wC.id, dmg: 5 });
  const capped = await waitFor(c, (m) => m.t === 'hit');
  check('excessive damage is clamped by the relay', !!capped && capped.dmg <= 0.25, JSON.stringify(capped));

  console.log('\n== rejection ==');
  clear(a);
  send(a, { t: 'state', x: NaN, y: 0, a: 0 });
  send(a, { t: 'state', y: 5, a: 0 });
  send(a, { t: 'state', x: 'a', y: 'b', a: 'c' });
  await sleep(250);
  check('malformed state is dropped, not relayed', !b.msgs.some((m) => m.t === 'state' && (m.x === undefined)));
  send(a, { t: 'bump', to: 999999, vx: 1, vy: 1 });
  await sleep(150);
  check('bump to a missing player is ignored', a.readyState === 1);

  console.log('\n== leaving ==');
  clear(a); clear(c);
  b.close();
  const left = await waitFor(a, (m) => m.t === 'peer-left' && m.id === wB.id);
  check('departure is broadcast', !!left, JSON.stringify(left));
  check('the third client is told too', !!(await waitFor(c, (m) => m.t === 'peer-left' && m.id === wB.id)));

  console.log('\n== health ==');
  const h = await httpGet('/health');
  check('health reports the live count', h.ok === true && h.players === 2, JSON.stringify(h));

  console.log('\n== robustness ==');
  a.send('not json');
  send(a, { t: 'nonsense' });
  send(a, { t: 'state' });
  send(a, { t: 'bump' });
  await sleep(200);
  check('garbage does not drop the connection', a.readyState === 1);

  let survived = true;
  try { send(a, { t: 'state', x: 1, y: 1, a: 1, pad: 'x'.repeat(20000) }); } catch (e) { survived = false; }
  await sleep(400);
  check('oversized frames do not kill the server', survived);
  const stillUp = await connect();
  check('the server still accepts connections', stillUp.readyState === 1);

  a.close(); c.close(); stillUp.close();
  await sleep(300);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.message + '\n' + e.stack); process.exit(1); });