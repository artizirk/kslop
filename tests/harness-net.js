const path = require('path');
// Client-side multiplayer logic, headless. The wire is a plain WebSocket now,
// so this can drive handleRelay() directly with server-shaped messages.
const noop = () => {};
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    return noop;
  },
  set(t, k, v) { t[k] = v; return true; },
});

const mkNode = (id) => ({
  id, value: '', textContent: '', innerHTML: '', className: '',
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  addEventListener: noop, select: noop,
});
global.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: noop, AudioContext: undefined };
global.document = {
  addEventListener: () => {}, contains: () => false, querySelector: () => null,
  documentElement: { requestFullscreen: null },
  getElementById: (id) => (id === 'c' ? { getContext: () => ctxStub, style: {} } : mkNode(id)),
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};
global.addEventListener = noop;
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 1;
global.location = { protocol: 'http:', host: 'localhost', search: '?seed=20251008', pathname: '/' };
// a websocket that records what the game tries to send
const sent = [];
global.WebSocket = class {
  constructor(url) { this.url = url; this.readyState = 0; global.__ws = this; }
  send(s) { sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
};

(0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));

const g = global.window.__game;
const { car, respawn, step, NET, netSkid, handleRelay, updateNet, encodeState, onRemoteState } = g;
const keys = (...on) => { for (const k of ['w', 'a', 's', 'd', ' ']) g.keys[k] = false; for (const k of on) g.keys[k] = true; };

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

console.log('\n== no peer-to-peer left ==');
const src = require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8');
for (const gone of ['RTCPeerConnection', 'createOffer', 'createDataChannel', 'iceServers', 'stun:', 'packCode', 'unpackCode']) {
  check(`no ${gone} in the client`, !src.includes(gone));
}

console.log('\n== it connects on load ==');
check('a websocket was opened at boot', !!global.__ws, global.__ws && global.__ws.url);
check('it targets the page origin', global.__ws && global.__ws.url === 'ws://localhost/', global.__ws && global.__ws.url);
check('no join code UI exists', !src.includes('netCode') && !src.includes('roomcode'));

console.log('\n== welcome ==');
respawn(); keys();
check('starts with no peers', NET.peers.size === 0);
handleRelay({ t: 'welcome', id: 1, roster: [{ id: 1, name: 'Me', color: '#c8453a' }] });
check('we learn our own id', NET.id === 1);

handleRelay({ t: 'peer-joined', id: 2, roster: [
  { id: 1, name: 'Me', color: '#c8453a' },
  { id: 2, name: 'Ava', color: '#2f5f9e' },
] });
check('a newcomer appears in the roster', NET.roster.length === 2);
check('but not as a car until it sends state', NET.peers.size === 0);

console.log('\n== state relay ==');
handleRelay({ t: 'state', from: 2, x: 900, y: 500, a: 1.5, hb: 1, d: 0.2, sk: 1, sx0: 880, sy0: 500, sx1: 900, sy1: 500 });
check('a state packet creates the remote car', NET.peers.has(2));
const p2 = NET.peers.get(2);
check('target position is set', p2.tx === 900 && p2.ty === 500);
check('handbrake relayed', p2.hb === 1);
check('damage relayed', p2.damage === 0.2);
check('skid flag relayed', p2.skid === true);
check('skid segment relayed', p2.sx0 === 880 && p2.sx1 === 900);
check('name comes from the roster', p2.name === 'Ava', p2.name);

console.log('\n== identity is server-stamped ==');
handleRelay({ t: 'state', from: 3, x: 100, y: 100, a: 0 });
check('a new sender is adopted', NET.peers.has(3));
check('a packet with no from is ignored', (() => {
  const before = NET.peers.size;
  handleRelay({ t: 'state', x: 1, y: 1, a: 0 });
  return NET.peers.size === before;
})());
check('our own echo is ignored', (() => {
  const before = NET.peers.size;
  handleRelay({ t: 'state', from: NET.id, x: 1, y: 1, a: 0 });
  return NET.peers.size === before;
})());

console.log('\n== outgoing packet ==');
respawn(); keys('w');
for (let i = 0; i < 120; i++) step(1 / 120);
const pkt = encodeState();
check('packet is a state message', pkt.t === 'state');
check('position is quantised', Number.isInteger(pkt.x) && Number.isInteger(pkt.y));
check('packet carries our name and colour', typeof pkt.n === 'string' && /^#/.test(pkt.c));
const bytes = JSON.stringify(pkt).length;
console.log(`  packet: ${bytes} bytes at 20Hz = ${(bytes * 20 / 1024).toFixed(1)} KB/s upstream`);
check('packet stays small', bytes < 220, bytes + ' bytes');

console.log('\n== sending is rate limited ==');
sent.length = 0;
NET.online = true;
global.__ws.readyState = 1;     // the fake socket is now "open"
// performance.now() is frozen at 0 here, so backdate lastSend to let a tick through
NET.lastSend = -1000;
g.netTick();
g.netTick();
g.netTick();
check('only one state packet per tick window', sent.filter((m) => m.t === 'state').length === 1,
  'sent ' + sent.length);
check('packet was actually put on the wire', sent.length === 1 && sent[0].t === 'state');

console.log('\n== interpolation ==');
respawn(); keys();
handleRelay({ t: 'state', from: 5, x: 900, y: 500, a: 0 });
const p5 = NET.peers.get(5);
p5.x = 880; p5.y = 500;   // small gap: should ease, not snap
const beforeX = p5.x;
updateNet(1 / 60);
check('remote car eases toward its target', p5.x > beforeX && p5.x < p5.tx,
  `x ${beforeX.toFixed(1)} -> ${p5.x.toFixed(1)}`);
p5.tx = 1900; p5.ty = 1500;
updateNet(1 / 60);
check('a large jump snaps instead of sliding', Math.hypot(p5.x - 1900, p5.y - 1500) < 5);
p5.x = p5.tx = 1000; p5.y = p5.ty = 1000; p5.a = 3.0; p5.ta = -3.0;
updateNet(1 / 60);
check('heading takes the short way round', Math.abs(p5.a) < 3.2, 'a=' + p5.a.toFixed(3));

console.log('\n== timeouts and departures ==');
p5.last = performance.now() - 10000;
updateNet(1 / 60);
check('a silent peer is dropped', !NET.peers.has(5));
handleRelay({ t: 'state', from: 6, x: 10, y: 10, a: 0 });
check('peer re-added before leave test', NET.peers.has(6));
handleRelay({ t: 'peer-left', id: 6 });
check('an explicit leave removes the car', !NET.peers.has(6));
check('and removes them from the roster', !NET.roster.some((p) => p.id === 6));

console.log('\n== malformed input ==');
let threw = false, terr = '';
try {
  handleRelay(null);
  handleRelay('nope');
  handleRelay({ t: 'state' });
  handleRelay({ t: 'state', from: 7, x: NaN, y: 0, a: 0 });
  handleRelay({ t: 'state', from: 7, x: Infinity, y: 0, a: 0 });
  handleRelay({ t: 'bump' });
  handleRelay({ t: 'bump', vx: 'x', vy: null });
  handleRelay({ t: 'roster' });
  handleRelay({ t: 'peer-left' });
  handleRelay({ t: 'nonsense' });
} catch (err) { threw = true; terr = err.message; }
check('malformed messages never throw', !threw, terr);
check('non-finite positions are rejected', !NET.peers.has(7));

console.log('\n== collision with a remote car ==');
NET.peers.clear();
respawn(); keys();
handleRelay({ t: 'state', from: 11, x: car.x + 6, y: car.y, a: 0 });
const p11 = NET.peers.get(11);
p11.vx = 700; p11.vy = 0;
car.damage = 0;
for (let i = 0; i < 10; i++) { p11.tx = p11.x; p11.ty = p11.y; p11.last = performance.now(); updateNet(1 / 120); }
check('overlapping a remote car pushes us apart',
  Math.hypot(car.x - p11.x, car.y - p11.y) > 20,
  'dist=' + Math.hypot(car.x - p11.x, car.y - p11.y).toFixed(1));
check('a fast remote collision does damage', car.damage > 0, 'damage=' + car.damage.toFixed(2));
check('the car stays finite', Number.isFinite(car.x) && Number.isFinite(car.y));

console.log('\n== incoming bump ==');
respawn(); keys();
car.damage = 0; car.vx = 0; car.vy = 0;
handleRelay({ t: 'bump', from: 2, vx: 700, vy: 0 });
check('a hard bump damages us', car.damage > 0, 'damage=' + car.damage.toFixed(2));
respawn(); keys();
car.damage = 0; car.vx = 500; car.vy = 0;
handleRelay({ t: 'bump', from: 2, vx: 480, vy: 0 });
check('a gentle bump is harmless', car.damage === 0, 'damage=' + car.damage.toFixed(2));
respawn(); keys();
car.damage = 0; car.vx = 300; car.vy = 0;
handleRelay({ t: 'bump', from: 2, vx: -300, vy: 0 });
check('both sides agree on damage from the same closing speed',
  Math.abs(car.damage - 0.5) < 0.01, 'damage=' + car.damage.toFixed(3));

console.log('\n== remote cars are not static solids ==');
NET.peers.clear();
handleRelay({ t: 'state', from: 13, x: car.x, y: car.y, a: 0 });
const p13 = NET.peers.get(13);
check('remote cars stay out of the static collision set',
  !g.solids.some((s) => p13.x >= s.x && p13.x <= s.x + s.w && p13.y >= s.y && p13.y <= s.y + s.h));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);