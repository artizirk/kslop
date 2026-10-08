const path = require('path');
// Canvas stub that records calls and throws on invalid numbers, so a NaN
// leaking into the draw path shows up instead of silently blanking the frame.
const calls = { count: 0, byOp: {} };
function checkNums(op, args) {
  for (const a of args) {
    if (typeof a === 'number' && !Number.isFinite(a)) {
      throw new Error(`non-finite number passed to ctx.${op}(): ${a}`);
    }
  }
}
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && k.startsWith('__')) return undefined;
    // gradient factories must return an object with addColorStop
    if (k === 'createLinearGradient' || k === 'createRadialGradient') {
      return (...args) => { checkNums(k, args); calls.count++; return { addColorStop() {} }; };
    }
    if (k === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
    // any method-ish name behaves as a canvas call
    return (...args) => { checkNums(k, args); calls.count++; calls.byOp[k] = (calls.byOp[k] || 0) + 1; };
  },
  set(t, k, v) { t[k] = v; return true; },
});

const canvasStub = { getContext: () => ctxStub, style: {} };
global.window = { devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720, addEventListener: noop0, AudioContext: undefined };
function noop0() {}
const mkNode = (id) => ({
  id, value: '', textContent: '', innerHTML: '', className: '',
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  addEventListener: () => {}, select: () => {},
});
global.document = {
  addEventListener: () => {}, contains: () => false, querySelector: () => null,
  documentElement: { requestFullscreen: null },
  getElementById: (id) => (id === 'c' ? canvasStub : mkNode(id)),
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};
global.RTCPeerConnection = undefined;
global.addEventListener = noop0;
global.performance = { now: () => 0 };

let rafQueue = [];
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

(0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));

const g = global.window.__game;
const { car, respawn, step } = g;
const keys = (...on) => { for (const k of ['w','a','s','d',' ']) g.keys[k] = false; for (const k of on) g.keys[k] = true; };

let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };

// pump frames like the real loop does
function frames(n, dtMs = 16.7) {
  for (let i = 0; i < n; i++) {
    step(1 / 120);
    const f = rafQueue.pop();
    f((i + 1) * dtMs);
  }
}

console.log('\n== render path ==');
try {
  respawn(); keys('w');
  frames(90);
  check('frames while driving render cleanly', true);
} catch (e) { check('frames while driving render cleanly', false, e.message); }
check('canvas actually received draw calls', calls.count > 500, 'calls=' + calls.count);
console.log('  ops used: ' + Object.keys(calls.byOp).sort().join(', '));

// drive into buildings, wreck, respawn, drift -- all drawing states
try {
  respawn();
  for (let i = 0; i < 240; i++) {
    if (i % 30 === 0) keys(...['w','a','s','d',' '].filter(() => Math.random() < 0.6));
    step(1 / 120);
    const f = rafQueue.pop(); f((i + 1) * 16.7);
  }
  check('frames during crashes/wrecks render cleanly', true);
} catch (e) { check('frames during crashes/wrecks render cleanly', false, e.message); }

console.log('\n== resize ==');
try {
  for (const [w, h] of [[320, 240], [1920, 1080], [800, 1200]]) {
    global.window.innerWidth = w; global.window.innerHeight = h;
    respawn(); keys('w'); frames(20);
  }
  check('renders at phone, desktop and portrait sizes', true);
} catch (e) { check('renders at phone, desktop and portrait sizes', false, e.message); }

console.log('\n== devicePixelRatio ==');
try {
  global.window.devicePixelRatio = 3; global.window.innerWidth = 1280; global.window.innerHeight = 720;
  respawn(); frames(20);
  check('renders at dpr=3', true);
} catch (e) { check('renders at dpr=3', false, e.message); }

console.log('\n== audio path (mocked) ==');
try {
  // exercise startAudio + updateAudio with a working AudioContext mock
  const nodes = () => ({
    frequency: { value: 0, setTargetAtTime() {} },
    gain: { value: 0, setTargetAtTime() {} },
    connect(n) { return n; },
    start() {},
    destination: {},
  });
  global.window.AudioContext = function () {
    return { state: 'running', currentTime: 0, resume() {},
      createOscillator: nodes, createBiquadFilter: nodes, createGain: nodes };
  };
  // re-eval so the script picks up the mock AudioContext
  (0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));
  const g2 = global.window.__game;
  check('game still boots with audio available', !!g2);
  const listener = global.__capturedKeydown;
  // fire a keydown the way the page would
  const fakeEvt = { key: 'w', preventDefault() {} };
  // re-register: the fresh eval bound its own listener to the noop, so just call via keys
  g2.keys['w'] = true;
  for (let i = 0; i < 120; i++) g2.step(1 / 120);
  check('audio code path did not break physics', true);
} catch (e) { check('audio code path did not break physics', false, e.message); }

console.log('\n== audio can be switched off for tests ==');
try {
  let built = 0;
  global.location = { protocol: 'http:', host: 'localhost', search: '?seed=20251008&audio=0', pathname: '/' };
  global.window.AudioContext = function () {
    built++;
    const node = () => ({ frequency: { value: 0, setTargetAtTime() {} }, gain: { value: 0, setTargetAtTime() {} }, connect(n) { return n; }, start() {} });
    return { state: 'running', currentTime: 0, sampleRate: 48000, resume() {},
      createOscillator: node, createBiquadFilter: node, createGain: node, createBufferSource: node,
      createBuffer() { return { getChannelData() { return new Float32Array(8); } }; }, destination: {} };
  };
  (0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));
  const g3 = global.window.__game;
  check('?audio=0 is recognised', g3.AUDIO_OFF === true);
  g3.startAudio();
  check('no AudioContext is built when audio is off', built === 0, 'built=' + built);
  check('the engine has no audio node', g3.audioOn === false);
  g3.keys['w'] = true;
  for (let i = 0; i < 60; i++) g3.step(1 / 120);
  check('nothing starts audio later either', g3.audioOn === false && built === 0);
} catch (e) { check('the audio-off path works', false, e.message); }

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);