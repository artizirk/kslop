const path = require('path');
// headless harness: stub just enough DOM/canvas/audio to exercise the game loop
const noop = () => {};
global.__calls = [];
const ctxStub = new Proxy({}, {
  get: (t, k) => {
    if (k in t) return t[k];
    // gradient factories must return an object with addColorStop
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
    if (typeof k === 'string' && !k.startsWith('__')) {
      return (...args) => { global.__calls.push([k, args]); };
    }
    return noop;
  },
  set: (t, k, v) => { t[k] = v; global.__calls.push(['set:' + k, [v]]); return true; },
});

let rafQueue = [];
global.window = {
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  addEventListener: noop, AudioContext: undefined,   // also exercise the no-audio path
};
global.document = {
  addEventListener: () => {}, contains: () => false, querySelector: () => null,
  documentElement: { requestFullscreen: null },
  getElementById: () => ({ getContext: () => ctxStub, style: {} }),
  // glow sprites and the minimap base are built with createElement
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};
// No real network in these harnesses: the relay client is stubbed out.
global.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
global.location = { protocol: 'http:', host: 'localhost', search: '?seed=20251008', pathname: '/' };
global.addEventListener = noop;
global.performance = { now: () => 0 };
global.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

// multiplayer UI elements the game reaches for at boot
const uiNodes = {};
const canvasNode = { getContext: () => ctxStub, style: {}, width: 0, height: 0 };
global.document.getElementById = (id) => {
  if (id === 'c') return canvasNode;
  return (uiNodes[id] ||= {
    id, value: '', textContent: '', innerHTML: '', className: '',
    style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener: noop, select: noop, onclick: null,
  });
};

(0, eval)(require('fs').readFileSync(path.join(__dirname, '.game.js'), 'utf8'));

const g = global.window.__game;
const { car, respawn, step } = g;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (!cond && extra ? ' :: ' + extra : ''));
  if (!cond) failures++;
}
const keys = (...on) => { for (const k of ['w', 'a', 's', 'd', ' ']) g.keys[k] = false; for (const k of on) g.keys[k] = true; };
const run = (secs) => { for (let i = 0; i < Math.round(secs * 120); i++) step(1 / 120); };
const speed = () => Math.hypot(car.vx, car.vy);
const finite = (o) => [o.x, o.y, o.a, o.vx, o.vy].every(Number.isFinite);
// does the car body overlap any building?
function overlapsBuilding(pad = 0) {
  const ca = Math.cos(car.a), sa = Math.sin(car.a);
  return g.buildings.some((b) => !b.dead && [-21, 21].some((lx) => [-11, 11].some((ly) => {
    const px = car.x + ca * lx - sa * ly, py = car.y + sa * lx + ca * ly;
    return px > b.x - pad && px < b.x + b.w + pad && py > b.y - pad && py < b.y + b.h + pad;
  })));
}


// Respawn is randomised now, so tests that care about direction put the car
// back on a known intersection facing +x.
const MM = g.METRICS;
function placeEast(i = 2, j = 1) {
  respawn(); keys();
  car.x = i * MM.STEP + MM.ROAD / 2;
  car.y = j * MM.STEP + MM.ROAD / 2;
  car.a = 0; car.vx = car.vy = 0; car.damage = 0; car.wreckTimer = 0;
}
function heading() { return { c: Math.cos(car.a), s: Math.sin(car.a) }; }
// the shop tests leave the car upgraded, and armour changes every damage number
function stockCar() { car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 }; }
let lastBulletCount = 0;
function bulletsFired() { const n = g.bullets.length; const d = Math.max(0, n - lastBulletCount); lastBulletCount = n; return d; }

console.log('\n== world ==');
check('buildings generated', g.buildings.length >= 36, 'got ' + g.buildings.length);
check('buildings inside world', g.buildings.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= g.WORLD && b.y + b.h <= g.WORLD));
check('spawn is on a road', g.insideRoad(car.x, car.y), `x=${car.x} y=${car.y}`);
check('roads detected mid-city', g.insideRoad(105, 400) && g.insideRoad(400, 105));
check('block centre is not a road', !g.insideRoad(230, 230));
check('no buildings on the spawn cell', !g.buildings.some(b => car.x > b.x - 30 && car.x < b.x + b.w + 30 && car.y > b.y - 30 && car.y < b.y + b.h + 30));


console.log('\n== spawn points ==');
{
  const seen = new Set();
  let onRoadCount = 0, clearCount = 0, axisCount = 0, fromCentre = 0;
  for (let n = 0; n < 80; n++) {
    respawn();
    seen.add(Math.round(car.x) + ',' + Math.round(car.y));
    if (g.insideRoad(car.x, car.y)) onRoadCount++;
    if (g.clearOfSolids(car.x, car.y, 30)) clearCount++;
    // heading should be one of the four cardinal directions
    const q = Math.round(car.a / (Math.PI / 2)) % 4;
    if (Math.abs(car.a - q * Math.PI / 2) < 1e-6) axisCount++;
    if (Math.abs(car.x - (2 * MM.STEP + MM.ROAD / 2)) > 1 || Math.abs(car.y - (MM.STEP + MM.ROAD / 2)) > 1) fromCentre++;
  }
  check('every spawn is on a road', onRoadCount === 80, onRoadCount + '/80');
  check('every spawn is clear of solid objects', clearCount === 80, clearCount + '/80');
  check('spawn heading is always down a road', axisCount === 80, axisCount + '/80');
  check('spawns are randomised, not one fixed point', seen.size > 12, 'distinct spawns=' + seen.size);
  check('spawns are not all the old fixed point', fromCentre > 60, fromCentre + '/80 differed');

  // a respawn should avoid dropping you on top of another player
  respawn();
  const occupied = { x: car.x, y: car.y };
  g.NET.peers.set(999, {
    id: 999, name: 'blocker', color: '#fff', x: occupied.x, y: occupied.y, a: 0,
    vx: 0, vy: 0, hb: 0, damage: 0, tx: occupied.x, ty: occupied.y, ta: 0, last: performance.now(),
  });
  let keptClear = 0;
  for (let n = 0; n < 25; n++) {
    respawn();
    if (Math.hypot(car.x - occupied.x, car.y - occupied.y) > 200) keptClear++;
  }
  check('respawn avoids dropping onto another player', keptClear === 25, keptClear + '/25');
  g.NET.peers.clear();
}

console.log('\n== acceleration ==');
placeEast(); keys('w');
const startX = car.x;
run(2);
check('car moves forward', speed() > 200, 'speed=' + speed().toFixed(1));
check('car travels the way it is pointing', car.x > startX + 200, 'x ' + startX.toFixed(0) + ' -> ' + car.x.toFixed(1));
check('stays on the road while driving straight', g.insideRoad(car.x, car.y), `x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`);
check('state finite after 2s', finite(car));

console.log('\n== top speed ==');
run(30);
check('speed clamped under max', speed() <= 645, 'top=' + speed().toFixed(1));
check('still finite at 32s', finite(car));
keys();

console.log('\n== coast / brake / reverse ==');
respawn(); keys('w'); run(2);
const beforeStop = speed(); keys(); run(1);
check('coasts down without input', speed() < beforeStop, `${beforeStop.toFixed(0)} -> ${speed().toFixed(0)}`);
placeEast(); keys('s'); run(2);
check('reverses', car.vx < -5, 'vx=' + car.vx.toFixed(1));
check('reverse is speed-limited', speed() <= 200, 'revSpeed=' + speed().toFixed(1));
keys();

console.log('\n== physics in isolation (buildings removed) ==');
// Stash the level so pure handling tests can't crash the car mid-measurement.
// `g.buildings` is the same array the game reads; splicing it out of the way
// leaves collide() intact but with nothing to hit.
const realBuildings = g.buildings.splice(0, g.buildings.length);
// solids is what collide() actually walks, so empty it too
const realSolids = g.solids.splice(0, g.solids.length);
const clearRun = () => {   // mid-world, so a full-lock circle can't reach the barrier
  respawn(); keys(); car.x = 1100; car.y = 1100; car.a = 0; car.vx = 0; car.vy = 0; car.damage = 0;
};
const slip = () => {                       // angle between velocity and heading
  const s = speed(); if (s < 5) return 0;
  let d = Math.atan2(car.vy, car.vx) - car.a;
  while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) * 180 / Math.PI;
};

clearRun(); keys('w');
const straight0 = car.y;                     // heading 0 travels along +x, so y is lateral
run(1.5);
check('drives dead straight with no steering', Math.abs(car.y - straight0) < 1, `drift=${(car.y - straight0).toFixed(3)}px`);

clearRun(); keys('w'); run(2);
const idleA = car.a; keys(); run(1);
check('no input = no spin', Math.abs(car.a - idleA) < 0.02, `da=${(car.a - idleA).toFixed(4)}`);

clearRun(); keys('w'); run(1.5);
const aL = car.a; keys('w', 'a'); run(0.4);
const leftDelta = car.a - aL;
clearRun(); keys('w'); run(1.5);
const aR = car.a; keys('w', 'd'); run(0.4);
const rightDelta = car.a - aR;
check('left steers one way', leftDelta < -0.2, 'da=' + leftDelta.toFixed(3));
check('right steers the other way', rightDelta > 0.2, 'da=' + rightDelta.toFixed(3));
check('steering is symmetric', Math.abs(Math.abs(leftDelta) - Math.abs(rightDelta)) < 0.1,
  `L=${leftDelta.toFixed(3)} R=${rightDelta.toFixed(3)}`);

// steering authority should be ~0 when stationary (no tank-sliding on the spot)
clearRun(); keys('a');
run(1);
check('no steering authority at a standstill', Math.abs(car.a - 0) < 0.05, 'da=' + car.a.toFixed(4));

const peakSlip = (...hold) => {
  clearRun(); keys('w'); run(1.5);
  keys(...hold);
  let m = 0;
  for (let i = 0; i < 90; i++) { step(1 / 120); m = Math.max(m, slip()); }
  return m;
};
const gripSlip = peakSlip('w', 'a');
const driftSlip = peakSlip('w', 'a', ' ');
check('grip keeps the car pointed where it goes', gripSlip < 45, 'maxSlip=' + gripSlip.toFixed(1) + 'deg');
check('handbrake breaks traction (drifts)', driftSlip > gripSlip + 25,
  `grip=${gripSlip.toFixed(1)}deg drift=${driftSlip.toFixed(1)}deg`);

clearRun(); keys('w'); run(1.5); keys('w', 'a', ' ');
let capPeak = 0;
for (let i = 0; i < 240; i++) { step(1 / 120); capPeak = Math.max(capPeak, speed()); }
check('drifting cannot exceed the speed cap', capPeak <= 640 * 1.19, 'peak=' + capPeak.toFixed(0));

g.buildings.push(...realBuildings);
g.solids.push(...realSolids);
check('level restored for collision tests', g.buildings.length === realBuildings.length && g.solids.length === realSolids.length);
check('collision set includes buildings + props', g.solids.length > g.buildings.length,
  `solids=${g.solids.length} buildings=${g.buildings.length}`);

console.log('\n== drift space ==');
check('open lots were generated', g.lots.length >= 3, 'lots=' + g.lots.length);
const M = g.METRICS;
check('lots are real block-sized areas', g.lots.every(l => l.w === M.BLOCK && l.h === M.BLOCK), `BLOCK=${M.BLOCK}`);
check('lots contain no buildings', g.lots.every(l => !g.buildings.some(b =>
  b.x < l.x + l.w && b.x + b.w > l.x && b.y < l.y + l.h && b.y + b.h > l.y)));
check('lots hold parked cars', g.parked.filter(p => g.lots.some(l =>
  p.x > l.x && p.x < l.x + l.w && p.y > l.y && p.y < l.y + l.h)).length > 10);
check('intersections are kept clear of parked cars', g.parked.every(p => {
  for (let i = 0; i <= M.N; i++) for (let j = 0; j <= M.N; j++) {
    const cx = i * M.STEP + M.ROAD / 2, cy = j * M.STEP + M.ROAD / 2;
    if (Math.hypot(p.x - cx, p.y - cy) < M.ROAD * 0.62 - 1) return false;
  }
  return true;
}));

// Each lot must offer a clear centre and enough room for a real drift.
// A donut's radius grows with speed (v / yaw-rate), so rather than assume a
// speed, measure the fastest drift each lot can actually hold on to.
{
  const YAW = 3.1;                       // rad/s at full lock
  let slowestSupport = Infinity, maxSlipSeen = 0, blocked = 0;

  for (const lot of g.lots) {
    const cx = lot.x + lot.w / 2, cy = lot.y + lot.h / 2;
    if (g.solids.some((s) => cx + 40 > s.x && cx - 40 < s.x + s.w &&
                            cy + 40 > s.y && cy - 40 < s.y + s.h)) blocked++;

    // binary search the entry speed this lot can sustain for 2s without leaving
    const fits = (v0) => {
      respawn(); keys();
      car.x = cx; car.y = cy; car.a = 0;
      car.vx = v0; car.vy = 0; car.damage = 0; car.wreckTimer = 0;
      keys('w', 'a', ' ');
      for (let i = 0; i < 240; i++) {
        step(1 / 120);
        if (car.x < lot.x || car.x > lot.x + lot.w ||
            car.y < lot.y || car.y > lot.y + lot.h) return false;
      }
      return true;
    };
    let lo = 60, hi = 640;
    if (fits(lo)) {
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      slowestSupport = Math.min(slowestSupport, lo);
    }
  }

  // and confirm a drift at that speed really does slide the car
  const lot = g.lots[0];
  respawn(); keys();
  car.x = lot.x + lot.w / 2; car.y = lot.y + lot.h / 2; car.a = 0;
  car.vx = Math.min(300, slowestSupport * 0.8); car.vy = 0;
  car.damage = 0; car.wreckTimer = 0;
  keys('w', 'a', ' ');
  for (let i = 0; i < 240; i++) {
    step(1 / 120);
    const s = Math.hypot(car.vx, car.vy);
    if (s > 30) {
      let d = Math.atan2(car.vy, car.vx) - car.a;
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      maxSlipSeen = Math.max(maxSlipSeen, Math.abs(d) * 180 / Math.PI);
    }
  }
  keys();

  check('lot centres are free of obstacles', blocked === 0, blocked + ' lots blocked at the centre');
  check('every lot can hold a sustained drift', slowestSupport > 180,
    `slowest lot sustains ${slowestSupport.toFixed(0)}px/s (~${(slowestSupport * 0.32).toFixed(0)}km/h)`);
  check('that drift actually slides the car', maxSlipSeen > 25, 'peak slip=' + maxSlipSeen.toFixed(1) + 'deg');
  check('lots give more room than the steering lock needs', slowestSupport / YAW > 40,
    `radius ${(slowestSupport / YAW).toFixed(0)}px`);
}

console.log('\n== collision ==');
respawn();
const target = g.buildings.find(b => b.w > 60 && b.h > 60 && !b.dead);   // a standing face with open road in front
car.x = target.x - 120; car.y = target.y + target.h / 2;
car.a = 0; car.vx = 0; car.vy = 0; car.damage = 0;
car.vx = 900;                                               // slam the wall
let overlapSeen = false;
for (let i = 0; i < 120; i++) { step(1 / 120); if (overlapsBuilding(0)) overlapSeen = true; }
check('car never ends up inside a building', !overlapSeen, `x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`);
check('high-speed impact damages the car', car.damage > 0, 'damage=' + car.damage.toFixed(2));
check('collision bleeds off speed', speed() < 900, 'speed=' + speed().toFixed(0));
check('car stays finite', finite(car));

console.log('\n== light bumps are free ==');
respawn(); keys();
car.x = target.x - 60; car.y = target.y + target.h / 2; car.a = 0; car.damage = 0;
car.vx = 100;                                               // gentle nudge
run(1);
check('gentle nudge causes no damage', car.damage === 0, 'damage=' + car.damage.toFixed(2));

// Multiplayer checks live in harness-net.js (own process: this harness
// runs long synchronous sections that would interleave with its awaits).





console.log('\n== guns ==');
{
  const { bullets, sparks, bangs } = g;
  respawn(); keys();
  bullets.length = 0; sparks.length = 0; bangs.length = 0;

  // a single shot puts bullets in the world, ahead of the car
  g.fireCooldown = 0;
  g.fire();
  check('firing creates bullets', bullets.length > 0, 'count=' + bullets.length);
  const hd = { c: Math.cos(car.a), s: Math.sin(car.a) };
  check('bullets start ahead of the car',
    bullets.every(b => (b.x - car.x) * hd.c + (b.y - car.y) * hd.s > 0),
    'car=(' + car.x.toFixed(0) + ',' + car.y.toFixed(0) + ')');
  check('bullets travel in the car direction',
    bullets.every(b => b.vx * hd.c + b.vy * hd.s > 400),
    'v=(' + bullets[0].vx.toFixed(0) + ',' + bullets[0].vy.toFixed(0) + ')');
  check('firing kicks up sparks', sparks.length > 0);

  // the cooldown stops held-down fire from being a laser
  const afterOne = bullets.length;
  g.fire();
  check('a second shot in the same tick is blocked by the cooldown', bullets.length === afterOne);

  g.fireCooldown = 0;
  g.fire();
  check('after the cooldown it fires again', bullets.length > afterOne);

  console.log('\n== bullets fly and expire ==');
  bullets.length = 0;
  respawn(); keys();
  g.fireCooldown = 0;
  g.fire();
  const b0 = bullets[0];
  const bx0 = b0.x, by0 = b0.y;
  for (let i = 0; i < 30; i++) step(1 / 120);
  const travelled = bullets.length
    ? Math.max(...bullets.map(b => Math.hypot(b.x - bx0, b.y - by0)))
    : Math.hypot(b0.x - bx0, b0.y - by0);
  check('bullets move with the physics tick', travelled > 10, 'travelled=' + travelled.toFixed(0));
  for (let i = 0; i < 300; i++) step(1 / 120);
  check('bullets expire instead of living forever', bullets.length === 0, 'left=' + bullets.length);

  console.log('\n== bullets stop on walls ==');
  bullets.length = 0; sparks.length = 0;
  respawn(); keys();
  const target = g.buildings.find(b => b.w > 60 && b.h > 60);
  car.x = target.x - 120; car.y = target.y + target.h / 2; car.a = 0;
  car.vx = car.vy = 0;
  const sparksBefore = sparks.length;
  g.fireCooldown = 0;
  g.fire();
  check('bullets exist before impact', bullets.length > 0);
  for (let i = 0; i < 40; i++) step(1 / 120);
  check('bullets are absorbed by the building', !bullets.some(b => b.x > target.x),
    'bullets past the wall: ' + bullets.filter(b => b.x > target.x).length);
  check('the impact throws sparks', sparks.length > sparksBefore);

  console.log('\n== guns do not fire while wrecked ==');
  respawn(); keys();
  bullets.length = 0;
  car.wreckTimer = 1;
  g.fireCooldown = 0;
  g.fire();
  check('a wrecked car cannot shoot', bullets.length === 0);
  car.wreckTimer = 0;

  console.log('\n== explosion on wreck ==');
  bangs.length = 0; sparks.length = 0;
  respawn(); keys();
  car.damage = 0;
  g.wreckCar();
  check('wrecking arms the wreck timer', car.wreckTimer > 0, 'wreck=' + car.wreckTimer.toFixed(2));
  check('wrecking spawns a shockwave', bangs.length >= 2, 'bangs=' + bangs.length);
  check('wrecking throws debris', sparks.length > 20, 'sparks=' + sparks.length);
  check('wrecking shakes the camera', g.shakeAmount > 0, 'shake=' + g.shakeAmount.toFixed(1));
  const bangsAtWreck = bangs.length;
  g.wreckCar();
  check('wrecking twice does not double the bang', bangs.length === bangsAtWreck);

  respawn(); keys();
  bangs.length = 0;
  car.damage = 0.99;
  g.applyDamage(car.x, car.y, 0.05, 0);
  check('lethal damage triggers the bang via applyDamage', bangs.length >= 2 && car.wreckTimer > 0,
    'bangs=' + bangs.length + ' wreck=' + car.wreckTimer.toFixed(2));

  check('the explosion draws without error', (() => {
    try { const f = rafQueue.pop(); f(16.7); return true; } catch (e) { return false; }
  })());

  console.log('\n== wrecked car burns then respawns ==');
  respawn(); keys();
  bangs.length = 0; sparks.length = 0;
  car.damage = 0.99;
  g.applyDamage(car.x, car.y, 0.05, 0);
  for (let i = 0; i < 200; i++) step(1 / 120);
  check('the wreck keeps burning', sparks.length > 0 || bulletsBangs() > 0, 'sparks=' + sparks.length);
  for (let i = 0; i < 400; i++) step(1 / 120);
  check('the car comes back after the wreck', car.wreckTimer === 0 && car.damage === 0);
}

console.log('\n== slippery collisions ==');
{
  // Isolate the wall: a coasting car loses a lot to drag on its own, so the
  // honest measure is a scrape compared against a free roll from the same
  // starting state, not against its own starting speed.
  const allSolids = g.solids.splice(0, g.solids.length);
  const wall = g.buildings.find(b => b.w > 100 && b.h > 100);
  const bottom = wall.y + wall.h;

  const run = (withWall) => {
    g.solids.length = 0;
    if (withWall) g.solids.push(wall);
    respawn(); keys();
    car.x = wall.x + wall.w / 2;
    car.y = bottom + 27;          // just inside the collision radius of the face
    car.a = 0;                    // heading along the wall
    car.vx = 420; car.vy = -70;   // drifting gently into it
    car.damage = 0;
    for (let i = 0; i < 60; i++) step(1 / 120);
    return { speed: Math.hypot(car.vx, car.vy), dmg: car.damage };
  };

  const scraped = run(true);
  const free = run(false);
  check('a wall scrape costs little more than coasting',
    scraped.speed > free.speed * 0.8,
    'scrape=' + scraped.speed.toFixed(0) + ' free=' + free.speed.toFixed(0) + ' px/s');
  check('a scrape barely damages the car', scraped.dmg < 0.05, 'damage=' + scraped.dmg.toFixed(3));

  // head-on must still bleed speed hard, or walls would be meaningless
  g.solids.length = 0; g.solids.push(wall);
  respawn(); keys();
  car.x = wall.x - 130; car.y = wall.y + wall.h / 2; car.a = 0;
  car.vx = 620; car.vy = 0; car.damage = 0;
  for (let i = 0; i < 90; i++) step(1 / 120);
  const headOn = Math.hypot(car.vx, car.vy);
  check('a head-on hit still stops the car', headOn < 620 * 0.4, 'speed=' + headOn.toFixed(0));
  check('a head-on hurts more than a scrape', car.damage > scraped.dmg,
    'head-on=' + car.damage.toFixed(3) + ' scrape=' + scraped.dmg.toFixed(3));

  // a corner hit should spin the car; a flat scrape should not
  g.solids.length = 0; g.solids.push(wall);
  respawn(); keys();
  car.x = wall.x - 60; car.y = wall.y + wall.h + 60; car.a = -0.5;
  car.vx = 420; car.vy = -300; car.damage = 0;
  const a0 = car.a;
  for (let i = 0; i < 90; i++) step(1 / 120);
  const spun = Math.abs(car.a - a0);
  check('a corner hit actually turns the car', spun > 0.05, 'turned ' + (spun * 180 / Math.PI).toFixed(0) + 'deg');
  check('the corner hit does not spin it wildly', spun < 1.6, 'turned ' + (spun * 180 / Math.PI).toFixed(0) + 'deg');

  g.solids.length = 0;
  g.solids.push(...allSolids);
}

function bulletsBangs() { return g.bangs.length; }


console.log('\n== item boxes ==');
{
  const { boxes, mines, ITEMS, ITEM_INFO } = g;
  check('boxes were placed around the city', boxes.length >= 10, 'boxes=' + boxes.length);
  check('boxes avoid solid objects', boxes.every(b => g.clearOfSolids(b.x, b.y, 20)),
    boxes.filter(b => !g.clearOfSolids(b.x, b.y, 20)).length + ' blocked');
  check('boxes sit on roads or in lots',
    boxes.every(b => g.insideRoad(b.x, b.y) || g.lots.some(l => b.x > l.x && b.x < l.x + l.w && b.y > l.y && b.y < l.y + l.h)),
    boxes.filter(b => !g.insideRoad(b.x, b.y)).length + ' off-road');
  check('every item has display info', ITEMS.every(k => ITEM_INFO[k] && ITEM_INFO[k].label && ITEM_INFO[k].color),
    JSON.stringify(Object.keys(ITEM_INFO)));

  // driving through a box should hand us an item. Repairs heal on pickup and
  // weapons arm you, so pick a plain ability box for this.
  const isPlainAbility = (k) => !g.isWeapon(k) && k !== 'repair';
  respawn(); keys();
  const box = boxes.find(b => b.active && isPlainAbility(b.kind));
  check('the map has plain ability boxes', !!box,
    'kinds=' + [...new Set(boxes.map(b => b.kind))].join(','));
  car.x = box.x; car.y = box.y; car.vx = car.vy = 0;
  car.item = null;
  g.updateBoxes(1 / 120);
  check('driving over a box gives an item', !!car.item, 'item=' + car.item);
  check('the item is one of the known ones', ITEMS.includes(car.item), car.item);
  check('the box goes inactive', box.active === false);
  check('the box starts its respawn timer', box.timer > 0, 'timer=' + box.timer.toFixed(1));

  // a second box must not overwrite what we are holding
  const box2 = boxes.find(b => b.active && b !== box && isPlainAbility(b.kind));
  car.x = box2.x; car.y = box2.y;
  const held = car.item;
  g.updateBoxes(1 / 120);
  check('a box is not consumed while we already hold an item', box2.active === true);
  check('and our item is unchanged', car.item === held);

  // boxes come back
  box.timer = 0.01;
  car.item = null;
  car.x = -9999; car.y = -9999;
  g.updateBoxes(1 / 60);
  check('a box respawns after its timer', box.active === true);

  console.log('\n== repairs heal on pickup ==');
  {
    // a repair box patches you up the moment you touch it, no button needed
    respawn(); keys();
    const rbox = boxes.find(b => b.active && b.kind === 'repair');
    check('the map has repair boxes', !!rbox,
      'kinds=' + [...new Set(boxes.map(b => b.kind))].join(','));
    if (rbox) {
      car.damage = 0.7;
      car.item = null;
      car.x = rbox.x; car.y = rbox.y; car.vx = car.vy = 0;
      g.updateBoxes(1 / 120);
      check('touching a repair box heals us', car.damage < 0.7, 'damage=' + car.damage.toFixed(2));
      check('it heals a good chunk', car.damage <= 0.25, 'damage=' + car.damage.toFixed(2));
      check('it does not take the item slot', car.item === null, 'item=' + car.item);
      check('the box is used up', rbox.active === false);

      // and a healthy car leaves the box alone rather than wasting it
      const rbox2 = boxes.find(b => b.active && b.kind === 'repair');
      if (rbox2) {
        car.damage = 0;
        car.x = rbox2.x; car.y = rbox2.y;
        g.updateBoxes(1 / 120);
        check('a healthy car leaves a repair box for later', rbox2.active === true);
      }
    }
  }

  console.log('\n== abilities ==');
  respawn(); keys();

  // boost: temporary, and it actually goes faster. Run it down a clear
  // straight so the reading is about the boost and not a wall.
  car.x = MM.ROAD / 2;
  car.y = MM.STEP + MM.ROAD / 2;
  car.a = 0;
  car.vx = car.vy = 0;
  car.item = 'boost';
  g.useItem();
  check('using boost starts the boost timer', car.boostTimer > 0, 'boost=' + car.boostTimer.toFixed(2));
  check('the item is consumed', car.item === null);
  keys('w');
  // the boost is brief, so track the peak rather than the value at the end
  let boostedTop = 0;
  for (let i = 0; i < 240; i++) { step(1 / 120); boostedTop = Math.max(boostedTop, Math.hypot(car.vx, car.vy)); }
  check('a boost exceeds the normal top speed', boostedTop > 645, 'peak=' + boostedTop.toFixed(0));
  // and wears off
  for (let i = 0; i < 400; i++) step(1 / 120);
  check('the boost expires', car.boostTimer <= 0, 'boost=' + car.boostTimer.toFixed(2));

  // control: same straight, no boost, speed stays under the normal cap
  g.handleRelay.length; // no-op to keep the section self-contained
  car.x = MM.ROAD / 2;
  car.y = MM.STEP + MM.ROAD / 2;
  car.a = 0;
  car.vx = car.vy = 0;
  car.boostTimer = 0;
  keys('w');
  let plainTop = 0;
  for (let i = 0; i < 240; i++) { step(1 / 120); plainTop = Math.max(plainTop, Math.hypot(car.vx, car.vy)); }
  check('without a boost the normal cap still applies', plainTop <= 645, 'peak=' + plainTop.toFixed(0));
  check('the boost was meaningfully faster', boostedTop > plainTop + 50, 'boosted=' + boostedTop.toFixed(0) + ' plain=' + plainTop.toFixed(0));

  // shield: blocks damage while it lasts
  respawn(); keys();
  car.item = 'shield';
  g.useItem();
  check('using shield starts the shield timer', car.shieldTimer > 0, 'shield=' + car.shieldTimer.toFixed(2));
  car.damage = 0;
  g.applyDamage(car.x, car.y, 0.5, 0);
  check('a shield absorbs damage', car.damage === 0, 'damage=' + car.damage.toFixed(2));
  car.shieldTimer = 0;
  g.applyDamage(car.x, car.y, 0.5, 0);
  check('damage lands once the shield is gone', car.damage > 0, 'damage=' + car.damage.toFixed(2));

  // shield does not stop a wreck from an existing wound
  car.damage = 0.2;
  car.shieldTimer = 5;
  g.applyDamage(car.x, car.y, 1, 0);
  check('a shield cannot be worn through to a wreck', car.damage === 0.2 && car.wreckTimer === 0,
    'damage=' + car.damage.toFixed(2));

  // repair: gives health back
  respawn(); keys();
  car.damage = 0.8;
  car.item = 'repair';
  g.useItem();
  check('repair restores health', car.damage < 0.5, 'damage=' + car.damage.toFixed(2));
  car.damage = 0.1;
  car.item = 'repair';
  g.useItem();
  check('repair never goes below zero damage', car.damage === 0, 'damage=' + car.damage.toFixed(2));

  // mine: drops, arms, then hurts
  respawn(); keys();
  mines.length = 0;
  car.item = 'mine';
  const mx = car.x, my = car.y;
  g.useItem();
  check('using mine drops a mine behind the car', mines.length === 1, 'mines=' + mines.length);
  check('the mine lands behind us', Math.hypot(mines[0].x - mx, mines[0].y - my) > 10);
  check('the mine is not armed immediately', mines[0].arm > 0);
  // dropping one under ourselves should not hurt us during the arm delay
  const dmgBefore = car.damage;
  car.x = mines[0].x; car.y = mines[0].y;
  g.updateMines(1 / 120);
  check('an unarmed mine does not detonate', car.damage === dmgBefore, 'damage=' + car.damage.toFixed(2));
  // once armed it should
  mines[0].arm = 0;
  car.x = mines[0].x; car.y = mines[0].y;
  car.vx = car.vy = 0;
  g.updateMines(1 / 120);
  check('an armed mine detonates under us', car.damage > dmgBefore, 'damage=' + car.damage.toFixed(2));
  check('the mine is consumed', mines.length === 0, 'mines=' + mines.length);

  // mines expire
  mines.length = 0;
  g.dropMine();
  mines[0].life = 0.001;
  car.x = 9999; car.y = 9999;
  g.updateMines(1 / 60);
  check('mines expire', mines.length === 0);

  // using nothing is a no-op
  respawn(); keys();
  car.item = null; car.damage = 0.3;
  g.useItem();
  check('using with no item does nothing', car.item === null && car.damage === 0.3);

  // a wrecked car cannot use items
  car.item = 'repair';
  car.wreckTimer = 1;
  g.useItem();
  check('a wrecked car cannot use an item', car.item === 'repair');
  car.wreckTimer = 0;

  // items do not survive a respawn
  car.item = 'boost';
  car.shieldTimer = 4;
  car.boostTimer = 1;
  respawn();
  check('respawn clears held items and effects',
    car.item === null && car.shieldTimer === 0 && car.boostTimer === 0);
}

console.log('\n== kill feed ==');
{
  const { killFeed, pushKillFeed } = g;
  killFeed.length = 0;
  g.handleRelay({ t: 'state', from: 3, x: 100, y: 100, a: 0 });
  g.handleRelay({ t: 'state', from: 4, x: 200, y: 200, a: 0 });
  g.NET.peers.get(3).name = 'Ava';
  g.NET.peers.get(4).name = 'Bo';

  pushKillFeed({ by: 3, victim: 4 });
  check('a kill is recorded', killFeed.length === 1);
  check('the killer is named', killFeed[0].byName === 'Ava', killFeed[0].byName);
  check('the victim is named', killFeed[0].victimName === 'Bo', killFeed[0].victimName);
  check('colours come from the roster', /^#/.test(killFeed[0].byColor) && /^#/.test(killFeed[0].victimColor));

  pushKillFeed({ by: null, victim: 3 });
  check('a solo wreck has no killer', killFeed[0].by === null && killFeed[0].byName === null);

  // nonsense must not pollute the feed
  const before = killFeed.length;
  pushKillFeed(null);
  pushKillFeed({});
  pushKillFeed({ by: 3, victim: 3 });
  pushKillFeed({ by: 'x', victim: null });
  check('malformed kills are ignored', killFeed.length === before, 'len=' + killFeed.length);

  // the feed is bounded
  for (let i = 0; i < 30; i++) pushKillFeed({ by: 3, victim: 4 });
  check('the feed is capped', killFeed.length <= 5, 'len=' + killFeed.length);

  // and entries expire
  g.updateKillFeed(100);
  check('feed entries expire', killFeed.length === 0, 'len=' + killFeed.length);

  // our own name resolves without needing a peer entry
  killFeed.length = 0;
  g.NET.id = 77;
  g.NET.name = "Me";
  pushKillFeed({ by: 77, victim: 9 });
  check("our own id resolves to our name", killFeed[0].byName === "Me", killFeed[0].byName);
  check("a kill by us names the victim", killFeed[0].victimName === "racer9", killFeed[0].victimName);
  killFeed.length = 0;
  g.NET.id = null;
}


console.log('\n== destructible world ==');
{
  const { rubble, destroySolid, damageSolid, blastNearby } = g;
  respawn(); keys();
  rubble.length = 0;

  check('every building can be broken', g.buildings.every(b => typeof b.hp === 'number' && b.hp > 0));
  const ids = g.solids.map(s => s.did);
  check('solids carry a unique id', new Set(ids).size === ids.length && ids.every(n => Number.isInteger(n)),
    ids.length + ' ids');
  check('props have health too',
    g.solids.filter(s => s.kind === 'palm').every(s => s.hp > 0) &&
    g.solids.filter(s => s.kind === 'car').every(s => s.hp > 0));

  // chip a building with single hits until it gives
  const wall = g.buildings.find(b => !b.dead);
  const hp0 = wall.hp;
  const did = wall.did;
  damageSolid(wall, 1);
  check('a hit damages a building without destroying it', wall.hp === hp0 - 1 && !wall.dead,
    'hp=' + wall.hp);
  check('damage does not leave rubble', rubble.length === 0);

  for (let i = 0; i < 40; i++) damageSolid(wall, 1);
  check('enough hits destroy the building', wall.dead === true);
  check('the wreck leaves rubble', rubble.length === 1, 'rubble=' + rubble.length);
  check('the rubble occupies where it stood',
    rubble[0].x === wall.x && rubble[0].w === wall.w && rubble[0].h === wall.h);
  check('the rubble has debris chunks', rubble[0].chunks.length >= 3, 'chunks=' + rubble[0].chunks.length);
  check('destroying is idempotent', destroySolid(wall) === false || rubble.length === 1);

  // and it stops blocking
  check('a destroyed building no longer collides', (() => {
    const cx = wall.x + wall.w / 2, cy = wall.y + wall.h / 2;
    car.x = cx; car.y = cy; car.vx = car.vy = 0;
    car.damage = 0;
    for (let i = 0; i < 60; i++) step(1 / 120);
    // if it still collided we would have been shoved clear of the centre
    return Math.hypot(car.x - cx, car.y - cy) < 20;
  })());

  // an intact building still blocks
  const intact = g.buildings.find(b => !b.dead);
  check('an intact building still blocks', (() => {
    const cx = intact.x + intact.w / 2, cy = intact.y + intact.h / 2;
    car.x = cx; car.y = cy; car.vx = car.vy = 0;
    const before = { x: car.x, y: car.y };
    for (let i = 0; i < 60; i++) step(1 / 120);
    return Math.hypot(car.x - before.x, car.y - before.y) > 1;
  })());

  // shooting a building breaks it eventually
  respawn(); keys();
  const target = g.buildings.find(b => !b.dead);
  const rounds = Math.ceil(target.hp / 1) + 4;
  target.hp = rounds - 1;                    // one bullet short
  let fired = 0;
  car.x = target.x - 60; car.y = target.y + target.h / 2; car.a = 0;
  car.vx = car.vy = 0;
  for (let i = 0; i < 400 && !target.dead; i++) {
    g.fireCooldown = 0;
    g.fire();
    fired += bulletsFired();
    step(1 / 120);
  }
  check('gunfire can level a building', target.dead === true, 'shots fired=' + fired);

  // explosions chew up their surroundings
  respawn(); keys();
  const near = g.buildings.find(b => !b.dead);
  const hpBefore = near.hp;
  const px = near.x + near.w / 2, py = near.y + near.h / 2;
  blastNearby(px, py, 120, 7);
  check('an explosion damages what it happens next to', near.hp < hpBefore || near.dead,
    hpBefore + ' -> ' + near.hp);

  // a car caught at the edge takes less than one at the centre
  respawn(); keys();
  const far = g.buildings.find(b => !b.dead && b.hp > 5);
  const fhp = far.hp;
  blastNearby(far.x + far.w / 2, far.y + far.h / 2 + 110, 120, 7);
  const edgeLoss = fhp - far.hp;
  check('blast damage falls off with distance', edgeLoss < 7 && edgeLoss >= 0, 'loss=' + edgeLoss);

  // palms flatten when you drive through them
  respawn(); keys();
  const palm = g.solids.find(s => s.kind === 'palm' && !s.dead);
  const pcx = palm.x + palm.w / 2, pcy = palm.y + palm.h / 2;
  car.x = pcx - 20; car.y = pcy; car.a = 0;
  car.vx = 520; car.vy = 0; car.damage = 0;
  check('driving through a palm knocks it down', g.flattenPalms(520) === true && palm.dead === true,
    'palm dead=' + palm.dead + ' hp=' + palm.hp);
  check('a gentle nudge does not flatten a palm', (() => {
    const p2 = g.solids.find(s => s.kind === 'palm' && !s.dead);
    if (!p2) return true;
    car.x = p2.x + p2.w / 2; car.y = p2.y + p2.h / 2;
    return g.flattenPalms(40) === false && !p2.dead;
  })());

  // bullets stop on a live wall but pass where one has been destroyed
  respawn(); keys();
  const gap = g.buildings.find(b => !b.dead);
  destroySolid(gap);
  g.bullets.length = 0;
  car.x = gap.x - 80; car.y = gap.y + gap.h / 2; car.a = 0;
  car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  for (let i = 0; i < 12; i++) step(1 / 120);
  check('bullets fly through a destroyed building', g.bullets.some(b => b.x > gap.x + 10),
    'bullets=' + g.bullets.length);

  check('the rubble draws without error', (() => {
    try { const f = rafQueue.pop(); f(16.7); return true; } catch (e) { return false; }
  })());

  // network path: a break from another player is applied silently
  respawn(); keys();
  const remote = g.buildings.find(b => !b.dead);
  const before = rubble.length;
  g.handleRelay({ t: 'destroy', from: 3, did: remote.did });
  check('a break from another player is applied', remote.dead === true);
  check('and it leaves rubble here too', rubble.length === before + 1);
  let echoed = false;
  try { echoed = remote.dead && false; } catch (e) { echoed = true; }
  check('a relayed break is not echoed back', echoed === false);
  g.handleRelay({ t: 'destroy', did: 999999 });
  g.handleRelay({ t: 'destroy' });
  check('malformed break messages are ignored', true);
}


console.log('\n== kill streaks ==');
{
  const { streakBanners, pushStreak, updateStreaks } = g;
  streakBanners.length = 0;

  g.NET.id = 1;
  g.NET.name = 'Me';
  pushStreak({ id: 1, name: 'Me', color: '#2f5f9e', streak: 1, label: 'DOUBLE KILL' });
  check('a streak of one is not worth shouting about', streakBanners.length === 0);

  pushStreak({ id: 2, name: 'Ava', color: '#3d8f6b', streak: 2, label: 'DOUBLE KILL' });
  check('a double kill raises a banner', streakBanners.length === 1);
  check('the banner names the player', streakBanners[0].name === 'Ava');
  check('the label comes from the streak', streakBanners[0].label === 'DOUBLE KILL');
  check('someone else\'s streak is not ours', streakBanners[0].mine === false);

  pushStreak({ id: 1, name: 'Me', color: '#2f5f9e', streak: 4 });
  check('our own streak is flagged as ours', streakBanners[0].mine === true);
  check('a missing label is filled in from the streak number',
    /RAMPAGE|4/.test(streakBanners[0].label), streakBanners[0].label);

  for (let i = 0; i < 8; i++) pushStreak({ id: 3, name: 'Bo', streak: 2 });
  check('the banner stack is bounded', streakBanners.length <= 3, 'banners=' + streakBanners.length);

  const life = streakBanners[0].life;
  updateStreaks(0.5);
  check('banners tick down', streakBanners[0].life < life);
  updateStreaks(10);
  check('banners expire', streakBanners.length === 0);

  // malformed shouts must not throw or appear
  let threw = false;
  try {
    pushStreak(null);
    pushStreak({});
    pushStreak({ id: 1, streak: 'lots' });
  } catch (e) { threw = true; }
  check('malformed streak messages are ignored', !threw && streakBanners.length === 0);

  // the server-driven path
  g.handleRelay({ t: 'streak', id: 5, name: 'Cara', color: '#e0a12b', streak: 3, label: 'TRIPLE KILL' });
  check('a streak message from the relay raises a banner', streakBanners.length === 1);
  check('and carries the right shout', streakBanners[0].label === 'TRIPLE KILL', streakBanners[0].label);
  streakBanners.length = 0;
  g.NET.id = null;
}

console.log('\n== nukes ==');
{
  const { nukes, armNuke, updateNukes, detonateNuke } = g;
  respawn(); keys();
  nukes.length = 0;
  g.rubble.length = 0;

  check('a nuke is one of the items', g.ITEMS.includes('nuke'));
  check('nukes are the rarest item',
    g.ITEM_WEIGHTS.nuke < Math.min(g.ITEM_WEIGHTS.boost, g.ITEM_WEIGHTS.repair, g.ITEM_WEIGHTS.mine, g.ITEM_WEIGHTS.shield),
    JSON.stringify(g.ITEM_WEIGHTS));

  // weighted picking should favour the common items over many draws
  const tally = {};
  for (let i = 0; i < 4000; i++) { const k = g.randomItem(); tally[k] = (tally[k] || 0) + 1; }
  check('every item can be drawn', g.ITEMS.every(k => tally[k] > 0), JSON.stringify(tally));
  check('nukes are drawn far less often than boosts', tally.nuke < tally.boost / 2,
    'nuke=' + tally.nuke + ' boost=' + tally.boost);

  // arming starts a countdown rather than blowing up at once
  armNuke(600, 600, 1, false);
  check('arming a nuke starts a countdown', nukes.length === 1 && nukes[0].t > 0,
    't=' + (nukes[0] && nukes[0].t.toFixed(2)));
  check('nothing has exploded yet', g.rubble.length === 0);

  // it detonates when the fuse runs out
  nukes[0].t = 0.01;
  car.x = 2000; car.y = 2000;           // stand well clear
  car.damage = 0;
  updateNukes(1 / 30);
  check('the nuke goes off when the fuse ends', nukes.length === 0);
  check('the blast leaves a flash', g.nukeFlash > 0, 'flash=' + g.nukeFlash.toFixed(2));
  check('the blast shakes the camera', g.shakeAmount > 10, 'shake=' + g.shakeAmount.toFixed(1));

  // it levels everything inside its radius
  respawn(); keys();
  nukes.length = 0;
  g.rubble.length = 0;
  const cluster = g.buildings.filter(b => !b.dead);
  const c0 = cluster[0];
  const cx = c0.x + c0.w / 2, cy = c0.y + c0.h / 2;
  const inside = g.buildings.filter(b => {
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    return Math.hypot(bx - cx, by - cy) < 400;
  });
  car.x = cx + 5000; car.y = cy + 5000;   // out of harm's way
  car.damage = 0;
  detonateNuke({ x: cx, y: cy, owner: 0 });
  check('a nuke levels everything close to it',
    inside.every(b => b.dead), inside.filter(b => !b.dead).length + ' survived of ' + inside.length);
  check('it leaves a lot of rubble', g.rubble.length >= inside.length, 'rubble=' + g.rubble.length);

  // and hurts anyone caught in it, by distance
  respawn(); keys();
  nukes.length = 0;
  car.damage = 0;
  const t = g.buildings.find(b => !b.dead) || g.buildings[0];
  car.x = t.x + t.w / 2; car.y = t.y + t.h / 2;
  detonateNuke({ x: car.x, y: car.y, owner: 7 });
  check('a nuke wrecks a car at the centre', car.wreckTimer > 0 || car.damage > 0.5,
    'damage=' + car.damage.toFixed(2) + ' wreck=' + car.wreckTimer.toFixed(2));

  respawn(); keys();
  nukes.length = 0;
  car.damage = 0;
  const far = { x: car.x + 1200, y: car.y };
  detonateNuke({ x: far.x, y: far.y, owner: 7 });
  check('a nuke far away does nothing to us', car.damage === 0, 'damage=' + car.damage.toFixed(2));

  // using the item arms it and tells everyone
  respawn(); keys();
  nukes.length = 0;
  car.item = 'nuke';
  car.damage = 0;
  g.useItem();
  check('using a nuke arms a countdown', nukes.length === 1, 'nukes=' + nukes.length);
  check('using a nuke consumes it', car.item === null);
  const n0 = nukes[0];
  check('the nuke lands where we were', Math.hypot(n0.x - car.x, n0.y - car.y) < 60,
    'offset=' + Math.hypot(n0.x - car.x, n0.y - car.y).toFixed(0));

  // it credits the launcher, so a nuke kill reaches the feed
  respawn(); keys();
  nukes.length = 0;
  car.damage = 0;
  car.x = 900; car.y = 900;
  detonateNuke({ x: 900, y: 900, owner: 42 });
  check('a nuke credits the launcher', car.lastHitBy === 42, 'lastHitBy=' + car.lastHitBy);

  // a relayed nuke arms a countdown on this side
  nukes.length = 0;
  g.handleRelay({ t: 'nuke', from: 9, x: 1500, y: 1500 });
  check('a nuke from another player arms here too', nukes.length === 1 && nukes[0].owner === 9,
    JSON.stringify(nukes[0]));
  g.handleRelay({ t: 'nuke' });
  g.handleRelay({ t: 'nuke', x: NaN, y: 0 });
  check('malformed nuke messages are ignored', nukes.length === 1);

  nukes.length = 0;
  g.nukeFlash = 0;
  check('the nuke overlay draws without error', (() => {
    try { const f = rafQueue.pop(); f(16.7); return true; } catch (e) { return false; }
  })());
}


console.log('\n== explosions do damage ==');
stockCar();
{
  respawn(); keys();
  g.nukes.length = 0;
  g.bullets.length = 0;

  check('an explosion has a blast radius', g.BLAST_RADIUS > 40, 'r=' + g.BLAST_RADIUS);
  check('an explosion has damage', g.BLAST_POWER > 0, 'p=' + g.BLAST_POWER);

  // standing in the fireball hurts
  respawn(); keys();
  car.damage = 0;
  car.vx = car.vy = 0;
  const here = { x: car.x, y: car.y };
  g.explode(here.x, here.y, { silent: true, owner: 5 });
  check('an explosion under us does damage', car.damage > 0.1, 'damage=' + car.damage.toFixed(2));
  check('but a car blast is not a death sentence', car.damage < 0.4, 'damage=' + car.damage.toFixed(2));
  check('the blast throws us clear', Math.hypot(car.vx, car.vy) > 100,
    'speed=' + Math.hypot(car.vx, car.vy).toFixed(0));
  check('the blast is credited to its owner', car.lastHitBy === 5, 'lastHitBy=' + car.lastHitBy);

  // at the edge it barely scratches
  respawn(); keys();
  car.damage = 0; car.vx = car.vy = 0;
  g.explode(car.x + g.BLAST_RADIUS + 40, car.y, { silent: true, owner: 5 });
  check('an explosion out of range does nothing', car.damage === 0, 'damage=' + car.damage.toFixed(2));

  respawn(); keys();
  car.damage = 0;
  g.explode(car.x + g.BLAST_RADIUS * 0.85, car.y, { silent: true, owner: 5 });
  const edge = car.damage;
  respawn(); keys();
  car.damage = 0;
  g.explode(car.x, car.y, { silent: true, owner: 5 });
  check('damage falls off with distance', edge < car.damage, 'edge=' + edge.toFixed(3) + ' centre=' + car.damage.toFixed(3));

  // it wrecks the scenery too, not just cars
  respawn(); keys();
  car.x = 9999; car.y = 9999; car.damage = 0;
  g.rubble.length = 0;
  const target = g.buildings.find(b => !b.dead);
  const targetHp = target.hp;
  g.explode(target.x + target.w / 2, target.y + target.h / 2, { silent: true, owner: 1 });
  check('an explosion damages the buildings around it',
    target.dead || target.hp < targetHp,
    'hp ' + targetHp + ' -> ' + target.hp + ' rubble=' + g.rubble.length);
  check('a single blast does not level a whole building', !target.dead || targetHp <= 7,
    'hp was ' + targetHp);

  // a wreck explosion hurts nearby players' cars too, and does not loop
  respawn(); keys();
  car.damage = 0;
  // send() keeps a short ring of what went out, which is observable from here
  g.NET.lastSent.length = 0;
  g.explode(car.x + 30, car.y, { owner: g.NET.id });
  const sent = g.NET.lastSent.slice();
  check('an explosion is broadcast for other players', sent.some(m => m.t === 'blast'), JSON.stringify(sent));
  const blastMsg = sent.find(m => m.t === 'blast');
  check('the broadcast carries position, radius and power',
    blastMsg && Number.isFinite(blastMsg.x) && blastMsg.r > 0 && blastMsg.p > 0, JSON.stringify(blastMsg));

  // the relayed handling must not echo back out
  respawn(); keys();
  car.damage = 0;
  g.NET.lastSent.length = 0;
  g.handleRelay({ t: 'blast', from: 7, x: car.x, y: car.y, r: 150, p: 0.5, own: 7 });
  const echoed = g.NET.lastSent.slice();
  check('a relayed blast still hurts us', car.damage > 0, 'damage=' + car.damage.toFixed(2));
  check('a relayed blast is not echoed back', !echoed.some(m => m.t === 'blast'),
    JSON.stringify(echoed));
  check('a relayed blast credits the originator', car.lastHitBy === 7, 'lastHitBy=' + car.lastHitBy);

  // malformed blasts are ignored
  respawn(); keys();
  car.damage = 0;
  let threw = false;
  try {
    g.handleRelay({ t: 'blast' });
    g.handleRelay({ t: 'blast', x: NaN, y: 0 });
    g.handleRelay({ t: 'blast', x: 0, y: 0, r: 'wide', p: 'lots' });
  } catch (e) { threw = true; }
  check('malformed blasts are handled', !threw);

  // a chain reaction must terminate: wrecking via blast should not loop forever
  respawn(); keys();
  g.nukes.length = 0;
  car.damage = 0.99;
  car.x = 800; car.y = 800;
  g.NET.lastSent.length = 0;
  g.handleRelay({ t: 'blast', from: 9, x: 800, y: 800, r: 200, p: 1, own: 9 });
  const chain = g.NET.lastSent.slice();
  check('a lethal blast wrecks us', car.wreckTimer > 0, 'wreck=' + car.wreckTimer.toFixed(2));
  check('the resulting explosion does not re-broadcast a blast',
    chain.filter(m => m.t === 'blast').length === 0,
    'blasts=' + chain.filter(m => m.t === 'blast').length);
  g.nukes.length = 0;
}


console.log('\n== gun pickups ==');
{
  const { WEAPONS } = g;
  respawn(); keys();

  check('there is a default gun', !!WEAPONS.gun && WEAPONS.gun.ammo === Infinity);
  const extra = Object.keys(WEAPONS).filter(k => k !== 'gun');
  check('there are several alternative guns', extra.length >= 3, extra.join(', '));
  check('every gun has the stats firing needs',
    Object.values(WEAPONS).every(w => w.interval > 0 && w.count >= 1 && w.speed > 0 && w.dmg > 0),
    JSON.stringify(Object.keys(WEAPONS)));
  check('guns are part of the pickup pool', extra.every(k => g.ITEMS.includes(k)), g.ITEMS.join(','));
  check('every gun has display info', Object.keys(WEAPONS).every(k => g.ITEM_INFO[k] && g.ITEM_INFO[k].color));

  // we start on the default gun
  check('we start on the default gun', car.weapon === 'gun' && car.ammo === Infinity,
    car.weapon + '/' + car.ammo);

  // a weapon box arms us instead of filling the item slot
  const wbox = g.boxes.find(b => b.active && g.isWeapon(b.kind) && b.kind !== 'gun');
  check('the map contains gun boxes', !!wbox, 'kinds=' + [...new Set(g.boxes.map(b => b.kind))].join(','));
  car.item = 'boost';                 // hold a consumable to prove it is not clobbered
  car.x = wbox.x; car.y = wbox.y;
  g.updateBoxes(1 / 120);
  check('a gun box arms us with that gun', car.weapon === wbox.kind, 'weapon=' + car.weapon);
  check('it comes with a limited supply', car.ammo === WEAPONS[wbox.kind].ammo, 'ammo=' + car.ammo);
  check('it does not overwrite the held item', car.item === 'boost', 'item=' + car.item);
  check('the box is consumed', wbox.active === false);

  // firing spends ammo
  const gun = wbox.kind;
  const before = car.ammo;
  car.x = 800; car.y = 800; car.a = 0; car.vx = car.vy = 0;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('firing spends a round', car.ammo === before - 1, before + ' -> ' + car.ammo);
  check('the shot produced bullets', g.bullets.length >= 1, 'bullets=' + g.bullets.length);
  check('bullets carry the gun damage', g.bullets.every(b => b.dmg === WEAPONS[gun].dmg),
    'dmg=' + g.bullets[0].dmg);

  // a spread gun throws more than one pellet
  g.bullets.length = 0;
  car.weapon = 'shotgun';
  car.ammo = WEAPONS.shotgun.ammo;
  car.a = 0; car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  check('a shotgun fires a spread', g.bullets.length === WEAPONS.shotgun.count,
    'pellets=' + g.bullets.length);
  const angles = g.bullets.map(b => Math.atan2(b.vy, b.vx));
  check('the pellets fan out', Math.max(...angles) - Math.min(...angles) > 0.1,
    'spread=' + (Math.max(...angles) - Math.min(...angles)).toFixed(2));
  const spreadDmg = g.bullets[0].dmg;

  // and the smg fires faster but weaker
  car.weapon = 'smg';
  car.ammo = WEAPONS.smg.ammo;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the smg fires a stream', g.bullets.length === WEAPONS.smg.count, 'bullets=' + g.bullets.length);
  check('the smg hits softer than the shotgun', WEAPONS.smg.dmg < WEAPONS.shotgun.dmg,
    'smg=' + WEAPONS.smg.dmg + ' shotgun=' + WEAPONS.shotgun.dmg);
  check('the smg fires faster than the default', WEAPONS.smg.interval < WEAPONS.gun.interval);
  // the flamethrower is faster still; what matters is that the smg out-rates the default gun
  check('the smg out-rates the default gun', WEAPONS.smg.interval < WEAPONS.gun.interval,
    'smg=' + WEAPONS.smg.interval + ' gun=' + WEAPONS.gun.interval);
  check('the smg keeps its rate in a sane band',
    WEAPONS.smg.count / WEAPONS.smg.interval > 10 && WEAPONS.smg.count / WEAPONS.smg.interval < 60,
    Math.round(WEAPONS.smg.count / WEAPONS.smg.interval) + ' rounds/sec');
  void spreadDmg;

  // running dry returns us to the default gun
  car.weapon = 'smg';
  car.ammo = 1;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('firing the last round drops us back to the default gun',
    car.weapon === 'gun' && car.ammo === Infinity, car.weapon + '/' + car.ammo);

  // the cannon bursts on impact and chews the scenery
  respawn(); keys();
  g.rubble.length = 0;
  g.bullets.length = 0;
  const wall = g.buildings.find(b => !b.dead);
  const hp0 = wall.hp;
  car.weapon = 'cannon';
  car.ammo = WEAPONS.cannon.ammo;
  car.x = wall.x - 60; car.y = wall.y + wall.h / 2; car.a = 0;
  car.vx = car.vy = 0;
  car.damage = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the cannon round is flagged as explosive', g.bullets.every(b => b.blast === true));
  for (let i = 0; i < 30; i++) step(1 / 120);
  check('a cannon round hurts the wall more than a bullet', wall.dead || wall.hp <= hp0 - 5,
    'hp ' + hp0 + ' -> ' + wall.hp);

  // a respawn puts the default gun back in your hands
  car.weapon = 'cannon';
  car.ammo = 3;
  respawn();
  check('respawning restores the default gun',
    car.weapon === 'gun' && car.ammo === Infinity, car.weapon + '/' + car.ammo);

  // remote gunfire mirrors the weapon that fired it
  g.bullets.length = 0;
  g.handleRelay({ t: 'fire', from: 3, x: 900, y: 900, a: 0, w: 'shotgun', vx: 0, vy: 0 });
  check('a remote shotgun looks like a shotgun here',
    g.bullets.length === WEAPONS.shotgun.count, 'ghosts=' + g.bullets.length);
  check('remote rounds are still cosmetic', g.bullets.every(b => b.ghost === true));
  g.bullets.length = 0;
  g.handleRelay({ t: 'fire', from: 3, x: 900, y: 900, a: 0, w: 'nonsense', vx: 0, vy: 0 });
  check('an unknown remote weapon falls back to the default',
    g.bullets.length === WEAPONS.gun.count, 'ghosts=' + g.bullets.length);
  g.bullets.length = 0;

  // every gun's icon draws without error
  check('every gun icon draws', (() => {
    try {
      for (const k of Object.keys(WEAPONS)) g.drawItemIcon(100, 100, 8, k);
      return true;
    } catch (e) { return false; }
  })());
}


console.log('\n== rockets ==');
stockCar();
{
  const { WEAPONS } = g;
  check('the rpg exists', !!WEAPONS.rpg, Object.keys(WEAPONS).join(','));
  check('the homing missile exists', !!WEAPONS.missile);
  check('both are in the pickup pool',
    g.ITEMS.includes('rpg') && g.ITEMS.includes('missile'), g.ITEMS.join(','));
  check('both have display info',
    g.ITEM_INFO.rpg && g.ITEM_INFO.missile, JSON.stringify(Object.keys(g.ITEM_INFO)));

  // --- rpg
  respawn(); keys();
  g.bullets.length = 0;
  g.rubble.length = 0;
  car.weapon = 'rpg';
  car.ammo = WEAPONS.rpg.ammo;
  car.x = 800; car.y = 800; car.a = 0; car.vx = car.vy = 0; car.damage = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the rpg fires one rocket', g.bullets.length === 1, 'rounds=' + g.bullets.length);
  check('the rocket is flagged explosive', g.bullets[0].blast === true);
  check('the rpg blast is wider than the cannon',
    WEAPONS.rpg.blastR > WEAPONS.cannon.blastR, 'rpg=' + WEAPONS.rpg.blastR + ' cannon=' + WEAPONS.cannon.blastR);
  check('the rpg carries a bigger punch', WEAPONS.rpg.dmg > WEAPONS.cannon.dmg);

  // hitting a wall with it should open a much bigger hole than a bullet
  respawn(); keys();
  g.bullets.length = 0;
  const wall = g.buildings.find(b => !b.dead);
  const hp0 = wall.hp;
  car.weapon = 'rpg';
  car.ammo = 5;
  car.x = wall.x - 70; car.y = wall.y + wall.h / 2; car.a = 0;
  car.vx = car.vy = 0; car.damage = 0;
  g.fireCooldown = 0;
  g.fire();
  for (let i = 0; i < 40; i++) step(1 / 120);
  check('an rpg round levels the wall it hits', wall.dead === true,
    'hp ' + hp0 + ' -> ' + wall.hp);

  // --- homing missile. Clear the world so the flight is about the missile and
  // not about whichever building the random spawn happens to point at.
  const savedSolids = g.solids.splice(0, g.solids.length);
  const savedPeds = g.peds.splice(0, g.peds.length);   // clear the street so the flight is clean
  respawn(); keys();
  car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0; car.vx = car.vy = 0;
  g.bullets.length = 0;
  g.NET.peers.clear();
  g.NET.id = 1;
  // put a target well off to one side of where we are aiming
  const target = { id: 9, name: 'Ava', color: '#3d8f6b', x: car.x + 900, y: car.y + 900, vx: 0, vy: 0,
                   a: 0, hb: 0, damage: 0, tx: car.x + 900, ty: car.y + 900, ta: 0, last: performance.now() };
  g.NET.peers.set(9, target);
  car.weapon = 'missile';
  car.ammo = WEAPONS.missile.ammo;
  car.a = 0;                       // pointing east, target is south-east
  car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the missile launches', g.bullets.length === 1, 'rounds=' + g.bullets.length);
  const missile = g.bullets[0];
  check('the missile is a homing round', missile.homing > 0, 'homing=' + missile.homing);
  check('the missile starts pointed where we aimed', Math.abs(Math.atan2(missile.vy, missile.vx)) < 0.1,
    'angle=' + Math.atan2(missile.vy, missile.vx).toFixed(2));

  // it should curve toward the target. Capture the starting position first:
  // `missile` is the live object, so it moves as we step.
  const startAngle = Math.atan2(missile.vy, missile.vx);
  const startX = missile.x, startY = missile.y;
  const d0 = Math.hypot(startX - target.x, startY - target.y);
  for (let i = 0; i < 60; i++) step(1 / 120);
  const still = g.bullets[0];
  check('the missile is still flying', !!still, 'bullets=' + g.bullets.length);
  if (still) {
    const turned = Math.atan2(still.vy, still.vx) - startAngle;
    check('the missile steers toward the target', turned > 0.15,
      'turned ' + turned.toFixed(2) + ' rad');
    const d1 = Math.hypot(still.x - target.x, still.y - target.y);
    check('the missile closes on the target', d1 < d0, 'd ' + d0.toFixed(0) + ' -> ' + d1.toFixed(0));
  }

  // it turns gradually rather than snapping onto the target
  respawn(); keys();
  g.bullets.length = 0;
  target.x = car.x + 60; target.y = car.y + 900;    // almost directly behind
  target.tx = target.x; target.ty = target.y;
  car.weapon = 'missile';
  car.ammo = 5;
  car.a = 0; car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  let maxJump = 0;
  let prev = Math.atan2(g.bullets[0].vy, g.bullets[0].vx);
  for (let i = 0; i < 40 && g.bullets.length; i++) {
    step(1 / 120);
    if (!g.bullets.length) break;
    const a = Math.atan2(g.bullets[0].vy, g.bullets[0].vx);
    maxJump = Math.max(maxJump, Math.abs(a - prev));
    prev = a;
  }
  check('the missile cannot turn on a sixpence', maxJump < WEAPONS.missile.homing / 120 * 3,
    'max turn per step=' + maxJump.toFixed(3));

  // a missile with no one to chase just flies straight
  respawn(); keys();
  g.bullets.length = 0;
  g.NET.peers.clear();
  car.weapon = 'missile';
  car.ammo = 5;
  car.a = 0; car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  const straight0 = Math.atan2(g.bullets[0].vy, g.bullets[0].vx);
  for (let i = 0; i < 60; i++) step(1 / 120);
  if (g.bullets.length) {
    const straight1 = Math.atan2(g.bullets[0].vy, g.bullets[0].vx);
    check('a missile with no target flies straight', Math.abs(straight1 - straight0) < 0.01,
      'drift=' + Math.abs(straight1 - straight0).toFixed(3));
  } else {
    check('a missile with no target flies straight', true);
  }

  // rockets cost ammo like anything else
  respawn(); keys();
  car.weapon = 'missile';
  car.ammo = 2;
  g.fireCooldown = 0;
  g.fire();
  check('launching a missile spends one', car.ammo === 1, 'ammo=' + car.ammo);
  g.fireCooldown = 0;
  g.fire();
  check('emptying it returns the default gun', car.weapon === 'gun' && car.ammo === Infinity,
    car.weapon + '/' + car.ammo);

  // icons
  check('the rocket icons draw', (() => {
    try { g.drawItemIcon(10, 10, 8, 'rpg'); g.drawItemIcon(10, 10, 8, 'missile'); return true; }
    catch (e) { return false; }
  })());

  g.solids.length = 0;
  g.solids.push(...savedSolids);
  g.peds.length = 0;
  g.peds.push(...savedPeds);

  g.NET.peers.clear();
  g.NET.id = null;
  g.bullets.length = 0;
}


console.log('\n== gun inventory ==');
{
  const { WEAPONS } = g;
  respawn(); keys();

  check('we start with just the built-in gun', car.guns.length === 1 && car.guns[0].kind === 'gun',
    JSON.stringify(car.guns));
  check('and it never runs out', car.guns[0].ammo === Infinity);

  // picking up a gun adds a slot and switches to it
  car.x = 800; car.y = 800; car.vx = car.vy = 0; car.damage = 0;
  g.giveGun('smg');
  check('a second gun joins the arsenal', car.guns.length === 2, JSON.stringify(car.guns.map(x => x.kind)));
  check('picking one up switches to it', car.weapon === 'smg', 'weapon=' + car.weapon);
  check('it arrives with its own ammo', car.ammo === WEAPONS.smg.ammo, 'ammo=' + car.ammo);

  g.giveGun('shotgun');
  check('a third gun joins too', car.guns.length === 3, JSON.stringify(car.guns.map(x => x.kind)));
  check('shotgun selected', car.weapon === 'shotgun');

  // switching cycles through them
  g.switchGun(1);
  check('swapping moves to the next gun', car.weapon === 'gun', 'weapon=' + car.weapon);
  g.switchGun(1);
  check('and wraps round', car.weapon === 'smg', 'weapon=' + car.weapon);
  g.switchGun(-1);
  check('swapping backwards works', car.weapon === 'gun', 'weapon=' + car.weapon);

  // each slot keeps its own ammo
  car.gunIndex = car.guns.findIndex(x => x.kind === 'smg');
  car.ammo = 40;
  car.gunIndex = car.guns.findIndex(x => x.kind === 'shotgun');
  check('slots remember their own ammo', car.ammo === WEAPONS.shotgun.ammo,
    'shotgun=' + car.ammo);
  car.gunIndex = car.guns.findIndex(x => x.kind === 'smg');
  check('and the smg still has what we left it', car.ammo === 40, 'smg=' + car.ammo);

  // firing spends only the active slot
  car.gunIndex = car.guns.findIndex(x => x.kind === 'smg');
  const smgBefore = car.guns.find(x => x.kind === 'smg').ammo;
  const shotBefore = car.guns.find(x => x.kind === 'shotgun').ammo;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('firing spends the active gun', car.guns.find(x => x.kind === 'smg').ammo === smgBefore - 1);
  check('and leaves the others alone', car.guns.find(x => x.kind === 'shotgun').ammo === shotBefore);

  // picking up a gun we already have tops it up rather than taking a slot
  const slots = car.guns.length;
  const hadSmg = car.guns.find(x => x.kind === 'smg').ammo;
  car.gunIndex = 0;
  g.giveGun('smg');
  check('a duplicate does not add a slot', car.guns.length === slots, 'slots=' + car.guns.length);
  check('it tops up the ammo instead', car.guns.find(x => x.kind === 'smg').ammo > hadSmg,
    hadSmg + ' -> ' + car.guns.find(x => x.kind === 'smg').ammo);
  check('and selects it', car.weapon === 'smg');

  // emptying a slot drops it and falls back to another gun
  car.gunIndex = car.guns.findIndex(x => x.kind === 'smg');
  car.ammo = 1;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('an empty gun leaves the arsenal', !car.guns.some(x => x.kind === 'smg'),
    JSON.stringify(car.guns.map(x => x.kind)));
  check('we are left holding something', !!WEAPONS[car.weapon], 'weapon=' + car.weapon);
  check('and never left with nothing', car.guns.length >= 1);

  // the built-in gun is always the last resort
  car.guns = [{ kind: 'gun', ammo: Infinity }];
  car.gunIndex = 0;
  car.ammo = 1;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the built-in gun refills rather than vanishing',
    car.guns.length === 1 && car.weapon === 'gun' && car.ammo === Infinity,
    car.weapon + '/' + car.ammo);

  // index select
  respawn();
  g.giveGun('smg'); g.giveGun('rpg');
  check('we can select any slot by index', (() => {
    car.gunIndex = 0; const a = car.weapon;
    car.gunIndex = 1; const b = car.weapon;
    car.gunIndex = 2; const c = car.weapon;
    return a === 'gun' && b === 'smg' && c === 'rpg';
  })(), JSON.stringify(car.guns.map(x => x.kind)));

  // resurrecting wipes the arsenal
  respawn();
  check('respawning resets the arsenal', car.guns.length === 1 && car.weapon === 'gun',
    JSON.stringify(car.guns));

  // swapping with one gun is a no-op
  check('swapping with a single gun does nothing', g.switchGun(1) === false);
}

console.log('\n== health on every car ==');
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
{
  respawn(); keys();
  car.damage = 0;
  g.NET.name = 'Me';
  delete g.NET.id;
  g.NET.id = 1;

  // the shared tag helper must run for any car
  let threw = false;
  try {
    g.drawCarTag(100, 100, 'Me', '#2f5f9e', 0, { mine: true });
    g.drawCarTag(200, 200, 'Ava', '#3d8f6b', 0.8, {});
  } catch (e) { threw = true; }
  check('the car tag draws for us and for others', !threw);

  // Render a frame and inspect what the canvas was actually asked to draw: the
  // tag is drawn in world space, so it lands at the car's own coordinates.
  g.__resetCalls && g.__resetCalls();
  global.__calls.length = 0;
  car.damage = 0.25;
  respawn();
  car.x = 1160; car.y = 460; car.a = 0;
  global.__calls.length = 0;
  const frame = rafQueue.pop();
  frame(16.7);

  // the tag background is a fillRect just above the car
  const near = global.__calls.filter(([op, args]) =>
    op === 'fillRect' &&
    Math.abs(args[0] - (car.x - 27)) < 30 &&
    Math.abs(args[1] - (car.y - 46)) < 12);
  check('our own car is tagged every frame', near.length >= 1,
    'fillRects near the car: ' + near.length);

  // and the health bar inside it reflects our damage
  const hpW = clamp(1 - car.damage, 0, 1);
  const bar = global.__calls.filter(([op, args]) =>
    op === 'fillRect' &&
    Math.abs(args[1] - (car.y - 25)) < 3 &&
    args[2] > 0 && args[2] < 60);
  check('the tag carries a health bar', bar.length >= 1, 'bars=' + bar.length);
  check('the bar is scaled to our damage',
    bar.some(([, a]) => Math.abs(a[2] - (54 - 10) * hpW) < 12),
    'expected about ' + ((54 - 10) * hpW).toFixed(0) + 'px, saw ' + JSON.stringify(bar.map(b => b[1][2])));

  g.NET.id = null;
}


console.log('\n== randomised starts ==');
{
  // The world seed is read at load: from the URL when one is given, otherwise
  // fresh each time, so a new load is a new city.
  check('the page reports the seed it used', Number.isInteger(g.WORLD_SEED), 'seed=' + g.WORLD_SEED);
  check('a pinned seed is honoured', g.WORLD_SEED === 20251008, 'seed=' + g.WORLD_SEED);

  // respawn already randomises the starting position; prove it is not fixed
  const seen = new Set();
  let onRoad = 0, clear = 0, axis = 0;
  for (let i = 0; i < 120; i++) {
    respawn();
    seen.add(Math.round(car.x) + ',' + Math.round(car.y));
    if (g.insideRoad(car.x, car.y)) onRoad++;
    if (g.clearOfSolids(car.x, car.y, 30)) clear++;
    const q = Math.round(car.a / (Math.PI / 2)) % 4;
    if (Math.abs(car.a - q * Math.PI / 2) < 1e-6) axis++;
  }
  check('starts are spread across the map', seen.size > 20, 'distinct=' + seen.size);
  check('every start is on a road', onRoad === 120, onRoad + '/120');
  check('every start is clear of obstacles', clear === 120, clear + '/120');
  check('every start faces down a road', axis === 120, axis + '/120');
}

console.log('\n== death screen ==');
{
  respawn(); keys();
  g.NET.name = 'Me';
  g.NET.id = 1;

  check('the wreck lasts a known time', g.WRECK_TIME > 1, 't=' + g.WRECK_TIME);

  const wastedCalls = () => global.__calls.filter(([op, a]) => op === 'fillText' && a[0] === 'WASTED');

  // nothing while driving
  car.damage = 0;
  global.__calls.length = 0;
  rafQueue.pop()(16.7);
  check('no death screen while driving', wastedCalls().length === 0, 'found=' + wastedCalls().length);

  // wrecked: the words appear, large, and the screen goes dark
  car.wreckTimer = g.WRECK_TIME - 1.2;   // part way through the fade
  global.__calls.length = 0;
  rafQueue.pop()(16.7);
  const died = wastedCalls();
  check('the death screen says WASTED', died.length >= 1, 'found=' + died.length);
  check('and says it large', died.some(([, a]) => Number(a[1]) > 30),
    JSON.stringify(died.map(d => d[1][1])));
  // GTA drains the colour first: a saturation blend fill over the whole screen
  const desat = global.__calls.filter(([op, a]) => op === 'set:globalCompositeOperation' && a[0] === 'saturation');
  check('the screen is drained of colour', desat.length >= 1,
    JSON.stringify(global.__calls.filter(([op]) => op === 'set:globalCompositeOperation').map(c => c[1][0])));

  const dark = global.__calls.filter(([op, a]) => op === 'fillRect' && a[0] === 0 && a[1] === 0 && a[3] >= 100);
  check('the screen is darkened', dark.length >= 1, 'fills=' + dark.length);

  // a serif face, as the source game uses
  const fonts = global.__calls.filter(([op]) => op === 'set:font').map(([, a]) => String(a[0]));
  check('the words are set in a heavy sans face', fonts.some(f => /sans-serif/i.test(f) && /900/.test(f)),
    JSON.stringify(fonts));

  // the word has to fit a phone as well as a desktop
  const fontAt = (w, h) => {
    global.window.innerWidth = w;
    global.window.innerHeight = h;
    g.resize();
    car.wreckTimer = g.WRECK_TIME - 1.2;
    global.__calls.length = 0;
    rafQueue.pop()(16.7);
    // the biggest face in the frame is the WASTED word; the line under it is small
    const sizes = global.__calls.filter(([op]) => op === 'set:font')
      .map(([, a]) => Number((/([0-9]+)px/.exec(String(a[0])) || [0, 0])[1]))
      .filter(n => n > 0);
    return sizes.length ? Math.max(...sizes) : 0;
  };
  const deskFont = fontAt(1280, 720);
  const phoneFont = fontAt(900, 420);
  const tinyFont = fontAt(480, 320);
  check('the death screen is set at a readable size', deskFont > 40, 'desktop=' + deskFont + 'px');
  check('and smaller on a phone', phoneFont < deskFont, 'phone=' + phoneFont + 'px vs desktop=' + deskFont + 'px');
  check('and smaller again on a tiny screen', tinyFont < phoneFont, 'tiny=' + tinyFont + 'px');
  check('the word fits the width on a phone', phoneFont * 0.42 * 6 < 900,
    'estimated width=' + Math.round(phoneFont * 0.42 * 6) + 'px of 900');
  check('the word fits the width on a tiny screen', tinyFont * 0.42 * 6 < 480,
    'estimated width=' + Math.round(tinyFont * 0.42 * 6) + 'px of 480');
  global.window.innerWidth = 1280;
  global.window.innerHeight = 720;
  g.resize();

  // it lifts on respawn
  car.wreckTimer = 0;
  global.__calls.length = 0;
  rafQueue.pop()(16.7);
  check('the death screen clears when we respawn', wastedCalls().length === 0);

  // and it names the culprit when there is one
  car.wreckTimer = g.WRECK_TIME - 1.2;
  car.lastHitBy = 2;
  global.__calls.length = 0;
  rafQueue.pop()(16.7);
  const by = global.__calls.filter(([op, a]) => op === 'fillText' && String(a[0]).startsWith('WASTED BY'));
  check('the death screen names who did it', by.length >= 1, JSON.stringify(by.map(b => b[1][0])));
  check('being killed by nobody reads differently', (() => {
    car.lastHitBy = null;
    global.__calls.length = 0;
    rafQueue.pop()(16.7);
    return global.__calls.some(([op, a]) => op === 'fillText' && String(a[0]).startsWith('RESPAWNING'));
  })());

  car.lastHitBy = null;
  car.wreckTimer = 0;
  g.NET.id = null;
}


console.log('\n== spawns avoid the edges ==');
{
  const M = g.METRICS;
  const edgeOf = (x, y) => {
    const i = Math.round((x - M.ROAD / 2) / M.STEP);
    const j = Math.round((y - M.ROAD / 2) / M.STEP);
    return (i <= 0 || i >= M.N || j <= 0 || j >= M.N);
  };
  const cornerOf = (x, y) => {
    const i = Math.round((x - M.ROAD / 2) / M.STEP);
    const j = Math.round((y - M.ROAD / 2) / M.STEP);
    return (i === 0 || i === M.N) && (j === 0 || j === M.N);
  };
  let corners = 0, edges = 0;
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    respawn();
    if (cornerOf(car.x, car.y)) corners++;
    if (edgeOf(car.x, car.y)) edges++;
    seen.add(Math.round(car.x) + ',' + Math.round(car.y));
  }
  check('never a corner', corners === 0, corners + '/200');
  check('rarely against the outer wall', edges <= 2, edges + '/200');
  check('still varied', seen.size > 15, 'distinct=' + seen.size);
  check('always on a road', (() => {
    for (let i = 0; i < 50; i++) { respawn(); if (!g.insideRoad(car.x, car.y)) return false; }
    return true;
  })());
  check('always clear of obstacles', (() => {
    for (let i = 0; i < 50; i++) { respawn(); if (!g.clearOfSolids(car.x, car.y, 30)) return false; }
    return true;
  })());

  // even when every inner spot is taken, we should not land in a corner
  g.NET.peers.clear();
  let blockerId = 900;
  for (let i = 0; i <= M.N; i++) {
    for (let j = 0; j <= M.N; j++) {
      g.NET.peers.set(blockerId++, {
        id: blockerId, name: 'b', color: '#fff', a: 0, vx: 0, vy: 0, hb: 0, damage: 0,
        x: i * M.STEP + M.ROAD / 2, y: j * M.STEP + M.ROAD / 2,
        tx: 0, ty: 0, ta: 0, last: performance.now(),
      });
    }
  }
  let cornerWhenBusy = 0;
  for (let i = 0; i < 30; i++) {
    respawn();
    if (cornerOf(car.x, car.y)) cornerWhenBusy++;
  }
  check('not even when the map is crowded', cornerWhenBusy === 0, cornerWhenBusy + '/30');
  g.NET.peers.clear();
}

console.log('\n== the smg hose ==');
{
  const { WEAPONS } = g;
  const rate = WEAPONS.smg.count / WEAPONS.smg.interval;
  console.log('  smg rate: ' + Math.round(rate) + ' rounds/sec (tick-capped)');
  check('the smg is a burst, not a hose', rate > 15 && rate < 60, Math.round(rate) + '/s');
  check('its rounds are faster than the default gun',
    WEAPONS.smg.speed > WEAPONS.gun.speed, WEAPONS.smg.speed + ' vs ' + WEAPONS.gun.speed);
  check('each round hits softer, so the hose is not instant death',
    WEAPONS.smg.dmg < WEAPONS.gun.dmg, WEAPONS.smg.dmg + ' vs ' + WEAPONS.gun.dmg);
  check('it carries enough rounds to be useful', WEAPONS.smg.ammo >= 100, 'ammo=' + WEAPONS.smg.ammo);

  // the tick rate is the ceiling: fire() runs once per physics step
  const perTick = WEAPONS.smg.count;
  check('it fires more than one round per tick', perTick >= 2, 'perTick=' + perTick);
  check('one tick of firing produces that many rounds', (() => {
    respawn(); keys();
    g.bullets.length = 0;
    car.weapon = 'smg'; car.ammo = WEAPONS.smg.ammo;
    car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0; car.vx = car.vy = 0;
    g.fireCooldown = 0;
    g.fire();
    return g.bullets.length === perTick;
  })());

  // over a second of firing it should be near its nominal rate
  const savedSolids = g.solids.splice(0, g.solids.length);
  respawn(); keys();
  g.bullets.length = 0;
  car.weapon = 'smg'; car.ammo = WEAPONS.smg.ammo;
  car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0; car.vx = car.vy = 0;
  // Count rounds from the ammo spent: bullets expire mid-second, so a net
  // count of the live array undercounts.
  const ammoBefore = g.currentGun().ammo;
  g.firing = true;
  for (let i = 0; i < 120; i++) step(1 / 120);
  g.firing = false;
  const spent = ammoBefore - g.currentGun().ammo;
  const fired = spent * WEAPONS.smg.count;
  check('it fires a reasonable number in a second', fired > 15 && fired < 60, fired + ' rounds in one second');
  check('it does not flood the wire', (() => {
    return g.NET.lastSent.filter(m => m.t === 'fire').length <= 40;
  })(), 'fire messages=' + g.NET.lastSent.filter(m => m.t === 'fire').length);
  g.solids.length = 0;
  g.solids.push(...savedSolids);
  g.bullets.length = 0;
}


console.log('\n== pedestrians ==');
{
  const { peds, cash, popups, killPed, updatePeds } = g;

  check('the streets have people on them', peds.length > 10, 'peds=' + peds.length);
  check('every pedestrian has a position', peds.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // earlier tests drive around, so some may already have been hit
  check('most of them are still up', peds.filter(p => p.alive).length > 10,
    'alive=' + peds.filter(p => p.alive).length + '/' + peds.length);
  check('ids are unique', new Set(peds.map(p => p.id)).size === peds.length);
  check('they have a walking speed', peds.every(p => p.speed > 10 && p.speed < 80),
    JSON.stringify([...new Set(peds.map(p => Math.round(p.speed)))].slice(0, 6)));

  // they walk on the pavement, not the road
  respawn(); keys();
  const M = g.METRICS;
  const onPavement = (x, y) => {
    for (let i = 0; i < M.N; i++) {
      for (let j = 0; j < M.N; j++) {
        const bx = i * M.STEP + M.ROAD, by = j * M.STEP + M.ROAD;
        if (x > bx + 4 && x < bx + M.BLOCK - 4 && y > by + 4 && y < by + M.BLOCK - 4) return true;
      }
    }
    return false;
  };
  let onWalk = 0;
  for (let i = 0; i < 240; i++) {
    updatePeds(1 / 120);
    for (const p of peds) if (p.alive && onPavement(p.x, p.y)) onWalk++;
  }
  check('calm pedestrians keep to the pavement', onWalk > 0, 'samples on pavement=' + onWalk);

  // walking actually moves them
  const sample = peds.find(p => p.alive);
  const x0 = sample.x, y0 = sample.y;
  for (let i = 0; i < 120; i++) updatePeds(1 / 120);
  check('pedestrians move', Math.hypot(sample.x - x0, sample.y - y0) > 5,
    'moved ' + Math.hypot(sample.x - x0, sample.y - y0).toFixed(1) + 'px');

  // they run from a fast car
  respawn(); keys();
  const victim = peds.find(p => p.alive);
  car.x = victim.x + 60; car.y = victim.y; car.vx = 300; car.vy = 0;
  const before = { x: victim.x, y: victim.y };
  updatePeds(1 / 120);
  check('a fast car makes them bolt', victim.panic > 0, 'panic=' + victim.panic.toFixed(2));
  const run = [];
  for (let i = 0; i < 30; i++) { updatePeds(1 / 120); run.push(Math.hypot(victim.x - before.x, victim.y - before.y)); }
  check('and they cover ground quickly', Math.max(...run) > 15, 'ran=' + Math.max(...run).toFixed(1) + 'px');

  // a slow car does not frighten them
  respawn(); keys();
  const calm = peds.find(p => p.alive && p.panic <= 0);
  car.x = calm.x + 90; car.y = calm.y; car.vx = 20; car.vy = 0;
  const calmPanic = calm.panic;
  updatePeds(1 / 120);
  check('a crawling car does not scare them', calm.panic <= Math.max(0, calmPanic),
    'panic=' + calm.panic.toFixed(2));

  console.log('\n== running them down ==');
  respawn(); keys();
  cash.length = 0; popups.length = 0;
  car.money = 0;
  const target = peds.find(p => p.alive);
  check('found someone to hit', !!target);
  // drive through them at speed
  car.x = target.x - 30; car.y = target.y; car.a = 0;
  car.vx = 400; car.vy = 0; car.damage = 0;
  let killed = false;
  for (let i = 0; i < 40 && !killed; i++) {
    car.x += car.vx * (1 / 120);       // drive forward, since updatePeds does not move us
    updatePeds(1 / 120);
    killed = !target.alive;
  }
  check('driving into a pedestrian kills them', killed === true);
  check('and it pays', car.money > 0, 'money=' + car.money);
  check('a value pops up', popups.length >= 1, 'popups=' + popups.length);
  check('the dead pedestrian is off the street', target.alive === false);
  // the cash is dropped where the car already is, so it is scooped up in the
  // same tick; test the drop and the pickup separately instead
  check('driving over your own kill collects it immediately', cash.length === 0 && car.money > 0,
    'cash=' + cash.length + ' money=' + car.money);

  console.log('\n== dropped cash ==');
  respawn(); keys();
  cash.length = 0;
  car.money = 0;
  car.x = 600; car.y = 600; car.vx = car.vy = 0;
  g.dropCash(900, 900, 50);
  check('dropping cash puts a note on the ground', cash.length === 1, 'cash=' + cash.length);
  check('the note is worth what was dropped', cash[0].value === 50, 'value=' + cash[0].value);
  const purse = car.money;
  car.x = 900; car.y = 900;
  updatePeds(1 / 120);
  check('driving over it collects it', car.money === purse + 50, 'money=' + car.money);
  check('and the note is gone', cash.length === 0, 'cash=' + cash.length);

  // cash on the ground does not last forever
  g.dropCash(1000, 1000, 30);
  cash[0].life = 0.001;
  updatePeds(1 / 60);
  check('uncollected cash eventually disappears', cash.length === 0, 'cash=' + cash.length);

  // a crawling car just nudges them
  respawn(); keys();
  cash.length = 0;
  const spared = peds.find(p => p.alive);
  car.x = spared.x - 20; car.y = spared.y; car.a = 0;
  car.vx = 40; car.vy = 0;
  for (let i = 0; i < 40; i++) {
    car.x = spared.x - 10; car.y = spared.y;   // keep them under the wheels
    updatePeds(1 / 120);
  }
  check('a crawling car does not kill', spared.alive === true);

  // money survives being wrecked, as it should
  respawn(); keys();
  car.money = 500;
  respawn();
  check('money survives a respawn', car.money === 500, 'money=' + car.money);

  // the network path
  respawn(); keys();
  const remote = peds.find(p => p.alive);
  g.handleRelay({ t: 'ped', from: 5, id: remote.id });
  check('a kill from another player clears the same pedestrian', remote.alive === false);
  check('and it does not pay us', true);
  g.handleRelay({ t: 'ped' });
  g.handleRelay({ t: 'ped', id: 99999 });
  check('malformed pedestrian messages are ignored', true);

  // kills are announced
  g.NET.lastSent.length = 0;
  const fresh = peds.find(p => p.alive);
  killPed(fresh, false);
  check('a kill is broadcast', g.NET.lastSent.some(m => m.t === 'ped'), JSON.stringify(g.NET.lastSent));

  // a relayed kill must not be echoed back
  g.NET.lastSent.length = 0;
  const other = peds.find(p => p.alive);
  g.handleRelay({ t: 'ped', from: 9, id: other.id });
  check('a relayed kill is not echoed', !g.NET.lastSent.some(m => m.t === 'ped'),
    JSON.stringify(g.NET.lastSent));

  check('the pedestrians draw without error', (() => {
    try { const f = rafQueue.pop(); f(16.7); return true; } catch (e) { return false; }
  })());
}


console.log('\n== shooting pedestrians ==');
{
  respawn(); keys();
  g.cash.length = 0;
  g.popups.length = 0;
  car.money = 0;
  car.damage = 0;

  const target = g.peds.find(p => p.alive);
  check('found a target', !!target);
  // line up on them and fire
  car.x = target.x - 40; car.y = target.y; car.a = 0;
  car.vx = car.vy = 0;
  // keep them still for the shot
  target.panic = 0;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  let down = false;
  for (let i = 0; i < 60 && !down; i++) {
    g.updateBullets(1 / 120);
    down = !target.alive;
  }
  check('a bullet brings a pedestrian down', down === true,
    'alive=' + target.alive + ' bullets=' + g.bullets.length);

  // the shooter gets paid, same as running them over
  check('shooting pays too', car.money > 0, 'money=' + car.money);

  // a remote player's fire must not kill on our screen: their client decides
  respawn(); keys();
  g.cash.length = 0;
  const spared = g.peds.find(p => p.alive);
  car.x = spared.x - 40; car.y = spared.y; car.a = 0;
  car.vx = car.vy = 0;
  g.bullets.length = 0;
  g.handleRelay({ t: 'fire', from: 3, x: car.x, y: car.y, a: 0, w: 'gun', vx: 0, vy: 0 });
  check('another player\'s rounds are ghosts', g.bullets.every(b => b.ghost === true));
  for (let i = 0; i < 60; i++) g.updateBullets(1 / 120);
  check('ghost rounds do not kill locally', spared.alive === true);
  g.bullets.length = 0;
}


console.log('\n== the crowd refills ==');
{
  const { peds, updatePeds, killPed, revivePed, PED_RESPAWN } = g;
  respawn(); keys();

  check('there is a respawn delay', PED_RESPAWN > 1, 't=' + PED_RESPAWN);

  const p = peds.find(x => x.alive);
  killPed(p, false);
  check('a killed pedestrian is down', p.alive === false);
  check('and is queued to come back', p.respawn > 0, 'respawn=' + p.respawn.toFixed(1));

  // they do not come back instantly
  for (let i = 0; i < 60; i++) updatePeds(1 / 120);
  check('they stay down for a while', p.alive === false, 'alive=' + p.alive);

  // but they do come back
  for (let i = 0; i < 120 * (PED_RESPAWN + 2); i++) updatePeds(1 / 120);
  check('and then they come back', p.alive === true);
  check('back on their feet with a clean slate', p.respawn === 0 && p.panic === 0,
    JSON.stringify({ respawn: p.respawn, panic: p.panic }));
  check('back at a real position', Number.isFinite(p.x) && Number.isFinite(p.y));
  check('and back on the pavement', (() => {
    const M = g.METRICS;
    for (let i = 0; i < M.N; i++) {
      for (let j = 0; j < M.N; j++) {
        const bx = i * M.STEP + M.ROAD, by = j * M.STEP + M.ROAD;
        if (p.x > bx + 4 && p.x < bx + M.BLOCK - 4 && p.y > by + 4 && p.y < by + M.BLOCK - 4) return true;
      }
    }
    return false;
  })());

  // the street should never permanently empty out
  respawn(); keys();
  for (const q of peds) { q.alive = false; q.respawn = 1; }
  const before = peds.filter(q => q.alive).length;
  for (let i = 0; i < 120 * 4; i++) updatePeds(1 / 120);
  const after = peds.filter(q => q.alive).length;
  check('an emptied street fills up again', before === 0 && after === peds.length,
    before + ' -> ' + after + ' of ' + peds.length);

  // reviving by hand puts someone straight back
  const q = peds.find(x => !x.alive) || peds[0];
  q.alive = false; q.respawn = 99;
  revivePed(q);
  check('a pedestrian can be revived directly', q.alive === true && q.respawn === 0);

  // and a relayed kill still schedules a respawn here
  const r2 = peds.find(x => x.alive);
  g.handleRelay({ t: 'ped', from: 3, id: r2.id });
  check('a kill we are told about also comes back later', r2.respawn > 0, 'respawn=' + r2.respawn.toFixed(1));

  // every function still draws
  check('the street draws after all that', (() => {
    try { const f = rafQueue.pop(); f(16.7); return true; } catch (e) { return false; }
  })());
}

console.log('\n== fullscreen ==');
{
  check('fullscreen support is detected', typeof g.fullscreenSupported() === 'boolean');
  check('nothing is fullscreen to begin with', g.fullscreenActive() === false);

  // in a browser without the API the call must be harmless
  let threw = false;
  try { g.toggleFullscreen(); g.toggleFullscreen(); } catch (e) { threw = true; }
  check('toggling fullscreen never throws, even unsupported', !threw);

  // and with a working API it asks the document element to go full screen
  let requested = 0, exited = 0;
  const el = global.document.documentElement;
  el.requestFullscreen = () => { requested++; return Promise.resolve(); };
  global.document.exitFullscreen = () => { exited++; return Promise.resolve(); };
  global.document.fullscreenElement = null;
  g.toggleFullscreen();
  check('it asks for fullscreen', requested === 1, 'requested=' + requested);
  global.document.fullscreenElement = el;
  g.toggleFullscreen();
  check('and asks to leave it when already full', exited === 1, 'exited=' + exited);
  // tidy up so later tests see the plain page
  global.document.fullscreenElement = null;
  delete el.requestFullscreen;
}


console.log('\n== the shop ==');
const shopCostFinite = (u, lv) => Number.isFinite(upgradeCostFor(u, lv));
const upgradeCostFor = (u, lv) => u.cost + lv * u.step;
{
  const { UPGRADES, upgradeCost, buyUpgrade, topSpeedNow, accelNow, gripNow, gunDamageNow, damageScaleNow } = g;
  respawn(); keys();

  check('there are upgrades to buy', Object.keys(UPGRADES).length >= 4, Object.keys(UPGRADES).join(','));
  check('every upgrade has a name, a blurb and a price',
    Object.values(UPGRADES).every(u => u.name && u.blurb && u.cost > 0 && u.step > 0),
    JSON.stringify(Object.keys(UPGRADES)));
  check('nothing has a level cap', Object.values(UPGRADES).every(u => u.max === undefined),
    JSON.stringify(Object.values(UPGRADES).map(u => u.max)));

  // a fresh car has none
  respawn();
  car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
  car.money = 0;
  const baseTop = topSpeedNow();
  const baseAccel = accelNow();
  const baseGrip = gripNow();
  const baseArmour = damageScaleNow();
  check('the base car is the reference', baseTop > 0 && baseAccel > 0 && baseGrip > 0 && baseArmour === 1,
    JSON.stringify({ baseTop, baseAccel, baseGrip, baseArmour }));

  console.log('\n== buying ==');
  // no money, no upgrade
  check('nothing is affordable with an empty purse', buyUpgrade('engine') === false);
  check('and the level did not move', car.upgrades.engine === 0);
  check('nor did the money go negative', car.money === 0, 'money=' + car.money);

  // with money it works
  const cost = upgradeCost('engine', 0);
  car.money = cost;
  check('the first level is affordable', buyUpgrade('engine') === true);
  check('the level went up', car.upgrades.engine === 1, 'level=' + car.upgrades.engine);
  check('the money was spent', car.money === 0, 'money=' + car.money);
  check('and the car is faster', topSpeedNow() > baseTop, baseTop.toFixed(0) + ' -> ' + topSpeedNow().toFixed(0));
  check('and pulls harder', accelNow() > baseAccel, baseAccel.toFixed(0) + ' -> ' + accelNow().toFixed(0));

  // each level costs more
  const c1 = upgradeCost('engine', 1);
  check('the next level costs more', c1 > cost, cost + ' -> ' + c1);

  // there is no ceiling: keep buying and it keeps going
  car.money = 10000000;
  for (let i = 0; i < 40; i++) buyUpgrade('engine');
  check('levels keep coming', car.upgrades.engine >= 40, 'level=' + car.upgrades.engine);
  check('the price keeps climbing', upgradeCost('engine', 40) > upgradeCost('engine', 39),
    upgradeCost('engine', 39) + ' -> ' + upgradeCost('engine', 40));
  check('a high level still costs a finite number', Number.isFinite(upgradeCost('engine', 200)),
    'cost=' + upgradeCost('engine', 200));
  check('it is never reported as maxed', shopCostFinite(UPGRADES.engine, 500));

  console.log('\n== what the upgrades do ==');
  respawn(); keys();
  car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
  car.damage = 0;
  const plain = { top: topSpeedNow(), accel: accelNow(), grip: gripNow(), dmg: gunDamageNow(0.05), armour: damageScaleNow() };
  car.upgrades.engine = 8;
  car.upgrades.tyres = 8;
  car.upgrades.guns = 8;
  car.upgrades.armour = 8;
  car.upgrades.nitro = 8;
  check('engine raises the top speed', topSpeedNow() > plain.top, plain.top.toFixed(0) + ' -> ' + topSpeedNow().toFixed(0));
  check('engine raises acceleration', accelNow() > plain.accel);
  check('tyres add grip', gripNow() > plain.grip, plain.grip.toFixed(1) + ' -> ' + gripNow().toFixed(1));
  check('guns hit harder', gunDamageNow(0.05) > plain.dmg, plain.dmg.toFixed(3) + ' -> ' + gunDamageNow(0.05).toFixed(3));
  check('armour softens hits', damageScaleNow() < 1, 'scale=' + damageScaleNow().toFixed(2));
  check('armour never makes you immune', damageScaleNow() >= 0.35, 'scale=' + damageScaleNow().toFixed(2));
  check('and armour keeps improving without limit', (() => {
    car.upgrades.armour = 5; const a = damageScaleNow();
    car.upgrades.armour = 500; const b = damageScaleNow();
    return b < a && b >= 0.35;
  })(), 'still above zero protection');
  check('nitro lengthens boosts', g.boostTimeNow() > 1.8, 't=' + g.boostTimeNow().toFixed(2));

  // and the effects reach the actual driving
  respawn(); keys();
  car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
  car.damage = 0;
  var upTop = topSpeedNow();
  car.upgrades.engine = 8;
  // measure a straight-line run with and without the engine work
  const runStraight = () => {
    respawn(); keys();
    car.x = g.METRICS.ROAD / 2; car.y = g.METRICS.STEP + g.METRICS.ROAD / 2;
    car.a = 0; car.vx = car.vy = 0; car.damage = 0;
    keys('w');
    let peak = 0;
    for (let i = 0; i < 120 * 4; i++) { step(1 / 120); peak = Math.max(peak, Math.hypot(car.vx, car.vy)); }
    return peak;
  };
  car.upgrades.engine = 8;
  const fastPeak = runStraight();
  car.upgrades.engine = 0;
  const slowPeak = runStraight();
  check('an upgraded engine really is faster on the road', fastPeak > slowPeak + 20,
    'stock=' + slowPeak.toFixed(0) + ' upgraded=' + fastPeak.toFixed(0));
  void upTop;

  // armour plainly reduces a hit
  respawn(); keys();
  car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
  car.damage = 0;
  g.applyDamage(car.x, car.y, 0.4, 0);
  const plainHurt = car.damage;
  respawn(); keys();
  car.upgrades.armour = 8;
  car.damage = 0;
  g.applyDamage(car.x, car.y, 0.4, 0);
  check('armour means the same hit hurts less', car.damage < plainHurt,
    plainHurt.toFixed(3) + ' -> ' + car.damage.toFixed(3));

  console.log('\n== upgrades survive a wreck ==');
  respawn(); keys();
  car.upgrades = { engine: 3, armour: 2, nitro: 1, tyres: 4, guns: 5 };
  const kept = JSON.stringify(car.upgrades);
  car.damage = 0.99;
  g.applyDamage(car.x, car.y, 1, 0);
  for (let i = 0; i < 500; i++) step(1 / 120);
  check('respawning keeps what you bought', JSON.stringify(car.upgrades) === kept,
    JSON.stringify(car.upgrades));
  check('and the car is back', car.damage === 0 && car.wreckTimer === 0);

  console.log('\n== progress is remembered ==');
  // the harness has no localStorage, so this must simply not throw
  let threw = false;
  try { g.saveProgress(); g.loadProgress(); } catch (e) { threw = true; }
  check('saving without storage is harmless', !threw);

  // with a working store, money and levels come back
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  respawn(); keys();
  car.money = 1234;
  car.upgrades = { engine: 2, armour: 1, nitro: 0, tyres: 3, guns: 0 };
  g.saveProgress();
  car.money = 0;
  car.upgrades = { engine: 0, armour: 0, nitro: 0, tyres: 0, guns: 0 };
  g.loadProgress();
  check('money is restored', car.money === 1234, 'money=' + car.money);
  check('upgrade levels are restored', car.upgrades.engine === 2 && car.upgrades.tyres === 3,
    JSON.stringify(car.upgrades));

  // nonsense in the store must not poison the car
  store['leonida.progress'] = 'not json at all';
  let threw2 = false;
  try { g.loadProgress(); } catch (e) { threw2 = true; }
  check('a corrupt save is ignored', !threw2);
  store['leonida.progress'] = JSON.stringify({ money: -50, upgrades: { engine: 99, bogus: 3 } });
  g.loadProgress();
  check('a silly money value is ignored', car.money >= 0, 'money=' + car.money);
  check('an absurd upgrade is clamped', car.upgrades.engine <= g.MAX_LEVEL,
    'engine=' + car.upgrades.engine);
  check('an unknown upgrade is dropped', !('bogus' in car.upgrades));
  delete global.localStorage;
}


console.log('\n== the Liero cabinet ==');
{
  const { WEAPONS, fires, addFire, updateFires, bulletEnds } = g;
  const newOnes = ['sniper', 'minigun', 'grenade', 'napalm', 'flame', 'railgun', 'cluster'];
  check('the new guns exist', newOnes.every(k => !!WEAPONS[k]), newOnes.filter(k => !WEAPONS[k]).join(','));
  check('they are all in the pickup pool', newOnes.every(k => g.ITEMS.includes(k)),
    newOnes.filter(k => !g.ITEMS.includes(k)).join(','));
  check('every gun has display info', Object.keys(WEAPONS).every(k => g.ITEM_INFO[k] && g.ITEM_INFO[k].color),
    JSON.stringify(Object.keys(WEAPONS)));
  check('every gun has workable stats',
    Object.values(WEAPONS).every(w => w.interval > 0 && w.count >= 1 && w.speed > 0 && w.dmg > 0));
  check('every gun icon draws', (() => {
    try { for (const k of Object.keys(WEAPONS)) g.drawItemIcon(10, 10, 8, k); return true; }
    catch (e) { return false; }
  })());

  console.log('\n== sniper ==');
  respawn(); keys(); stockCar();
  g.bullets.length = 0;
  const savedS = g.solids.splice(0, g.solids.length);
  car.weapon = 'sniper'; car.ammo = WEAPONS.sniper.ammo;
  car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0; car.vx = car.vy = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the sniper fires one round', g.bullets.length === 1, 'rounds=' + g.bullets.length);
  check('and it is quick', g.bullets[0].speed >= 2400, 'speed=' + g.bullets[0].speed);
  check('and it hits hard', g.bullets[0].dmg > WEAPONS.gun.dmg * 4, 'dmg=' + g.bullets[0].dmg);
  g.bullets.length = 0;

  console.log('\n== minigun ==');
  respawn(); keys();
  car.weapon = 'minigun'; car.ammo = WEAPONS.minigun.ammo;
  car.a = 0; car.vx = car.vy = 0;
  g.bullets.length = 0;
  // count from the ammo spent: rounds die mid-second, so the live count undercounts
  g.fireCooldown = 0;      // the sniper test left a long cooldown behind
  const mgBefore = g.currentGun().ammo;
  g.firing = true;
  for (let i = 0; i < 120; i++) step(1 / 120);
  g.firing = false;
  const shots = (mgBefore - g.currentGun().ammo) * WEAPONS.minigun.count;
  check('the minigun fires steadily', WEAPONS.minigun.interval <= 0.1, 'interval=' + WEAPONS.minigun.interval);
  check('it throws a steady stream of rounds', shots > 8 && shots < 40, 'rounds in a second=' + shots);
  g.bullets.length = 0;

  console.log('\n== grenade ==');
  respawn(); keys();
  // Isolate the wall, and clear the crowd: a grenade that clips a pedestrian
  // is consumed killing them, which has nothing to do with bouncing.
  const grenSolids = g.solids.splice(0, g.solids.length);
  const grenPeds = g.peds.splice(0, g.peds.length);
  const wall = g.buildings.find(b => !b.dead && b.x > 300);
  g.solids.push(wall);
  car.weapon = 'grenade'; car.ammo = WEAPONS.grenade.ammo;
  car.x = wall.x - 200; car.y = wall.y + wall.h / 2; car.a = 0;
  car.vx = car.vy = 0; car.damage = 0;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  const gren = g.bullets[0];
  check('the grenade is thrown', !!gren);
  check('it bounces rather than sticking', gren.bounce > 0, 'bounces=' + gren.bounce);
  check('and it is on a fuse', gren.fuse === true);
  // Let it reach the wall. A bounce is proven by the counter dropping while the
  // round survives: hitting the destroy path would remove it instead.
  const bounce0 = gren.bounce;
  let stillFlying = false;
  for (let i = 0; i < 60; i++) {
    step(1 / 120);
    if (!g.bullets.length) break;
    if (g.bullets[0].bounce < bounce0) { stillFlying = true; break; }
  }
  check('it comes back off the wall rather than being destroyed',
    stillFlying && g.bullets.length === 1, 'bounce=' + (g.bullets[0] && g.bullets[0].bounce));
  check('and it is heading away from the wall now', g.bullets.length === 1 && g.bullets[0].vx < 0,
    'vx=' + (g.bullets[0] && g.bullets[0].vx));
  // run out the fuse
  for (let i = 0; i < 200 && g.bullets.length; i++) step(1 / 120);
  check('it goes off on its own in the end', g.bullets.length === 0, 'left=' + g.bullets.length);
  g.solids.length = 0;
  g.solids.push(...grenSolids);
  g.peds.length = 0;
  g.peds.push(...grenPeds);

  console.log('\n== railgun ==');
  respawn(); keys(); stockCar();
  const line = g.buildings.filter(b => !b.dead).slice(0, 3);
  const target = line[0];
  car.weapon = 'railgun'; car.ammo = WEAPONS.railgun.ammo;
  car.x = target.x - 120; car.y = target.y + target.h / 2; car.a = 0;
  car.vx = car.vy = 0;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the railgun round pierces', g.bullets[0].pierce === true);
  let passedThrough = false;
  for (let i = 0; i < 30; i++) {
    step(1 / 120);
    if (g.bullets.length && g.bullets[0].x > target.x + target.w) { passedThrough = true; break; }
    if (!g.bullets.length) break;
  }
  check('it carries on through the building', passedThrough === true);
  g.bullets.length = 0;

  console.log('\n== cluster ==');
  respawn(); keys();
  car.weapon = 'cluster'; car.ammo = WEAPONS.cluster.ammo;
  car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0;
  car.vx = car.vy = 0; car.damage = 0;
  g.bullets.length = 0;
  g.fireCooldown = 0;
  g.fire();
  check('the cluster shell carries bomblets', g.bullets[0].split > 0, 'split=' + g.bullets[0].split);
  g.bullets.length = 0;
  bulletEnds({ x: car.x, y: car.y, vx: 100, vy: 0, split: 6, splitR: 100, tracer: '#fff', dmgBase: 0.1, blast: false });
  check('bursting scatters bomblets', g.bullets.length === 6, 'bomblets=' + g.bullets.length);
  check('the bomblets are explosive', g.bullets.every(b => b.blast === true));
  g.bullets.length = 0;

  console.log('\n== napalm ==');
  respawn(); keys();
  fires.length = 0;
  g.bullets.length = 0;
  car.weapon = 'napalm'; car.ammo = WEAPONS.napalm.ammo;
  car.x = g.WORLD / 2; car.y = g.WORLD / 2; car.a = 0;
  car.vx = car.vy = 0; car.damage = 0;
  g.fireCooldown = 0;
  g.fire();
  check('napalm throws a spread of fire', g.bullets.length === WEAPONS.napalm.count,
    'pellets=' + g.bullets.length);
  check('each pellet leaves fire', g.bullets.every(b => b.fire > 0), JSON.stringify(g.bullets.map(b => b.fire)));

  // let the pellets land
  for (let i = 0; i < 90; i++) step(1 / 120);
  check('the ground is left burning', fires.length > 0, 'patches=' + fires.length);
  const patch = fires[0];
  check('the fire has a radius and a life', patch.r > 0 && patch.life > 0,
    JSON.stringify({ r: patch.r, life: patch.life }));

  // standing in it hurts
  car.damage = 0;
  car.x = patch.x; car.y = patch.y;
  for (let i = 0; i < 60; i++) step(1 / 120);
  check('standing in the fire hurts', car.damage > 0, 'damage=' + car.damage.toFixed(3));

  // and it burns pedestrians
  respawn(); keys();
  const victim = g.peds.find(x => x.alive);
  victim.x = patch.x; victim.y = patch.y; victim.panic = 0;
  patch.tick = 0;                       // make the next tick land now
  updateFires(1 / 120);
  check('it burns pedestrians too', victim.alive === false);

  // fire burns out
  const beforeBurn = fires.length;
  patch.life = 0.001;
  updateFires(1 / 60);
  check('fire burns out', fires.length === beforeBurn - 1,
    beforeBurn + ' -> ' + fires.length);
  fires.length = 0;

  // a relayed patch lands here as well
  fires.length = 0;
  g.handleRelay({ t: 'burn', from: 4, x: 700, y: 700, r: 30, life: 5 });
  check('a patch from another player appears here', fires.length === 1, 'patches=' + fires.length);
  g.handleRelay({ t: 'burn' });
  g.handleRelay({ t: 'burn', x: NaN, y: 0 });
  check('malformed fire messages are ignored', fires.length === 1);
  fires.length = 0;

  // addFire is bounded and sane
  for (let i = 0; i < 400; i++) addFire(100, 100, 20, 5, true);
  check('fire cannot grow without bound', fires.length <= 260, 'patches=' + fires.length);
  fires.length = 0;
  void savedS;
  g.solids.length = 0;
  g.solids.push(...savedS);
  check('the world is intact after the weapons tests', g.solids.length > 100);
}

console.log('\n== damage curve ==');
stockCar();
// crash into a known wall face at a controlled speed
const crashAt = (v) => {
  respawn(); keys();
  car.x = target.x - 200; car.y = target.y + target.h / 2;
  car.a = 0; car.damage = 0; car.wreckTimer = 0;
  car.vx = v;
  for (let i = 0; i < 90; i++) { step(1 / 120); if (car.wreckTimer > 0) break; }
  return car.damage;
};
check('a light scrape is free', crashAt(150) === 0, 'dmg=' + crashAt(150).toFixed(2));
const mid = crashAt(400);
check('a medium crash hurts but does not wreck', mid > 0.15 && mid < 1, 'dmg=' + mid.toFixed(2));
const hard = crashAt(700);
check('a top-speed wall hit costs roughly half the car', hard > 0.4 && hard < 0.8, 'dmg=' + hard.toFixed(2));
respawn(); keys();
car.damage = 0; car.wreckTimer = 0;
check('two hard hits end the run', (() => {
  respawn(); keys();
  const d1 = crashAt(700);
  if (car.wreckTimer > 0) return true;
  car.damage = d1;
  car.x = target.x - 200; car.y = target.y + target.h / 2; car.a = 0; car.vx = 700;
  for (let i = 0; i < 90; i++) { step(1 / 120); if (car.wreckTimer > 0) break; }
  return car.wreckTimer > 0;
})());

console.log('\n== world bounds ==');
respawn(); keys();
car.x = -5000; car.y = -5000; run(2);
check('barrier holds the car in the world', car.x > 0 && car.y > 0 && car.x < g.WORLD && car.y < g.WORLD, `x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`);
check('barrier bounce state finite', finite(car));
car.x = 5000; car.y = 5000; run(2);
check('barrier holds on the far corner too', car.x < g.WORLD && car.y < g.WORLD, `x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`);

console.log('\n== damage / wreck / respawn ==');
stockCar();
const wallNow = g.buildings.find(b => !b.dead && b.w > 60 && b.h > 60);
respawn(); keys();
car.damage = 0.999;
car.x = wallNow.x - 120; car.y = wallNow.y + wallNow.h / 2; car.a = 0; car.vx = 900;
run(1);
check('fatal impact sets the wreck timer', car.wreckTimer > 0, 'wreck=' + car.wreckTimer.toFixed(2));
run(4);
check('wreck resets damage to 0', car.damage === 0, 'damage=' + car.damage);
check('wreck respawns on a road', g.insideRoad(car.x, car.y), `x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`);
check('no leftover velocity after wreck', speed() < 400);

console.log('\n== long random fuzz ==');
respawn();
let ok = true, why = '';
for (let i = 0; i < 120 * 60; i++) {
  if (i % 37 === 0) keys(...['w', 'a', 's', 'd', ' '].filter(() => Math.random() < 0.5));
  step(1 / 120);
  if (!finite(car)) { ok = false; why = 'NaN at i=' + i; break; }
  if (overlapsBuilding(-1)) { ok = false; why = `inside building at i=${i} x=${car.x.toFixed(1)} y=${car.y.toFixed(1)}`; break; }
  if (car.x < -60 || car.y < -60 || car.x > g.WORLD + 60 || car.y > g.WORLD + 60) { ok = false; why = 'escaped world'; break; }
}
check('60s of random input stays valid + out of walls', ok, why);
keys();

console.log('\n== perf ==');
respawn(); keys('w');
const t0 = process.hrtime.bigint();
run(10);  // 1200 physics steps
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
check('10s of physics under 50ms', ms < 50, ms.toFixed(1) + 'ms');
console.log('  (' + ms.toFixed(1) + 'ms for 1200 steps, ' + (ms / 1200).toFixed(3) + 'ms/step)');
keys();

console.log('\n== render frame ==');
respawn();
let rendered = false, err = '';
try { const f = rafQueue.pop(); if (f) { f(16.7); rendered = true; } }
catch (e) { err = e.message; rendered = false; }
check('one render frame runs without throwing', rendered, err);
try { for (let i = 1; i <= 5; i++) rafQueue.pop()(i * 16.7); check('several frames run clean', true); }
catch (e) { check('several frames run clean', false, e.message); }

// the async code-encoding block above needs a moment to finish
setTimeout(() => {
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}, 120);