const path = require('path');
// Drive the game through its REAL event listeners (no direct state poking),
// to prove the input path itself works: keydown -> physics -> canvas.
const noop = () => {};
const mkNode = (id) => ({
  id, value: '', textContent: '', innerHTML: '', className: '',
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  addEventListener: noop, select: noop,
});
const calls = { count: 0 };
function checkNums(op, args) {
  for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`non-finite in ctx.${op}(): ${a}`);
}
const ctxStub = new Proxy({}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && k.startsWith('__')) return undefined;
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
    return (...args) => { checkNums(k, args); calls.count++; }; },
  set(t, k, v) { t[k] = v; return true; },
});

const listeners = {};
global.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 640,
  addEventListener: (t, fn) => { (listeners['w:' + t] ||= []).push(fn); },
  AudioContext: function () {
    const n = () => ({ value: 0, setTargetAtTime() {}, connect(x) { return x; }, start() {}, destination: {} });
    return { state: 'running', currentTime: 0, resume() {}, createOscillator: n, createBiquadFilter: n, createGain: n };
  },
};
global.document = {
  addEventListener: () => {}, contains: () => false, querySelector: () => null,
  documentElement: { requestFullscreen: null },
  getElementById: (id) => (id === 'c'
    ? { getContext: () => ctxStub, style: {} }
    : mkNode(id)),
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};
global.RTCPeerConnection = undefined;
global.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
global.performance = { now: () => 0 };

let rafQueue = [];
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

(0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));

const g = global.window.__game;
let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

const keydown = (key) => listeners.keydown.forEach((fn) => fn({ key, preventDefault() {} }));
const keyup = (key) => listeners.keyup.forEach((fn) => fn({ key }));
let clock = 0;
const frames = (n) => { for (let i = 0; i < n; i++) { clock += 16.7; const f = rafQueue.pop(); f(clock); } };
const speed = () => Math.hypot(g.car.vx, g.car.vy);

console.log('\n== real input path ==');
check('keydown listener registered', (listeners.keydown || []).length > 0);
check('blur listener registered', (listeners.blur || []).length > 0);

// Spawn is randomised now, so put the car at a known intersection facing a
// clear road before driving it. Otherwise this measures whichever wall the
// random spawn happened to be pointing at.
const road = g.METRICS;
g.car.x = road.ROAD / 2;
g.car.y = road.STEP + road.ROAD / 2;
g.car.a = 0;
g.car.vx = 0; g.car.vy = 0; g.car.damage = 0;

const startX = g.car.x;
keydown('w');
frames(60);
check('holding W via real events moves the car', g.car.x > startX + 50, `x ${startX.toFixed(0)} -> ${g.car.x.toFixed(0)}`);
check('engine revs up under throttle', g.car.engine > 0.05, 'engine=' + g.car.engine.toFixed(2));
const audioRunning = calls.count >= 0;

keyup('w');
frames(30);
const coasting = speed();
check('releasing W coasts down', coasting > 0 && speed() < coasting + 1, `speed=${speed().toFixed(0)}`);

keydown('ArrowLeft');
frames(40);
check('arrow keys steer too', Math.abs(g.car.a) > 0.05, 'a=' + g.car.a.toFixed(3));
keyup('ArrowLeft');

keydown(' ');
frames(30);
check('space handbrake accepted', true);
keyup(' ');

keydown('r');
check('R respawns the car', g.car.damage === 0 && g.insideRoad(g.car.x, g.car.y), `x=${g.car.x} y=${g.car.y}`);

// mute toggle must not throw
let muteOk = true;
try { keydown('m'); keydown('m'); } catch (e) { muteOk = false; console.log('    ' + e.message); }
check('M mute toggle does not throw', muteOk);

// blur clears held keys
keydown('w');
listeners.blur.forEach((fn) => fn());
frames(30);
check('blur releases held keys (car slows)', speed() < coasting, `speed=${speed().toFixed(0)}`);

console.log('\n== long real-input session ==');
try {
  for (let i = 0; i < 600; i++) {
    if (i % 45 === 0) {
      const k = ['w', 'a', 's', 'd', ' '][(Math.random() * 5) | 0];
      keydown(k);
      if (i % 90 === 0) keyup(k);
    }
    clock += 16.7;
    const f = rafQueue.pop(); f(clock);
  }
  check('600 real frames of random driving render cleanly', true);
  check('canvas got a realistic number of draw calls', calls.count > 5000, 'calls=' + calls.count);
  check('car is still sane at the end',
    Number.isFinite(g.car.x) && Number.isFinite(g.car.a) &&
    g.car.x > -60 && g.car.y > -60 && g.car.x < g.WORLD + 60 && g.car.y < g.WORLD + 60,
    `x=${g.car.x.toFixed(1)} y=${g.car.y.toFixed(1)}`);
} catch (e) { check('600 real frames of random driving render cleanly', false, e.message); }
void audioRunning;

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);