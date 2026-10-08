#!/usr/bin/env node
'use strict';
/*
 * Leonida — game host and relay.
 *
 * Serves the game and relays each player's car to everyone else over
 * WebSockets. No peer-to-peer, no signalling, no room codes: whoever opens
 * the page lands in the same game.
 *
 *   node server.js              # port 80
 *   PORT=8080 node server.js    # any other port
 *   HOST=0.0.0.0 node server.js # force IPv4
 *
 * Port 80 usually needs root on Linux/macOS:
 *   sudo node server.js
 *
 * Listening with no host binds the IPv6 unspecified address (::), which on
 * Linux and macOS accepts IPv4 connections too.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Hardening knobs. The defaults are safe; the env vars are for tuning.
const PORT = Number(process.env.PORT || 80);
const RELOAD_TOKEN = process.env.TOKEN || crypto.randomBytes(4).toString('hex');
const TLS_KEY = process.env.TLS_KEY || null;
const TLS_CERT = process.env.TLS_CERT || null;
const RATE_PER_SEC = 90;      // a client sends ~20 state packets a second
const RATE_BURST = 180;
const PER_IP_MAX = 4;         // connections from one address
const RELOAD_WINDOW_MS = 2000;  // at most one forced reload every two seconds
const HOST = process.env.HOST || undefined;
const ROOT = __dirname;
const MAX_PLAYERS = 16;
const MAX_MSG = 8 * 1024;          // state packets are ~120 bytes; be strict
const PING_INTERVAL = 25000;
const PING_TIMEOUT = 70000;

// Loopback requests are the operator sitting at the machine. They get the
// console conveniences; the internet does not.
// The token can be given as a bearer header or a query parameter, whichever
// is easier from a script.
function hasToken(req, url) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const query = url && url.searchParams ? url.searchParams.get('token') : null;
  return (bearer && timingSafeEqual(bearer, RELOAD_TOKEN)) ||
         (query && timingSafeEqual(query, RELOAD_TOKEN));
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch (err) { return false; }
}

function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost';
}

// ---------------------------------------------------------------- static files
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Only these reach the network. Everything else in the folder stays private
// even though it sits in the served directory: the relay source, the tests,
// dotfiles, notes.
const SERVE_EXT = new Set(['.html', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.css']);
const SERVE_NAME = new Set(['index.html']);

function serveStatic(req, res) {
  // A malformed request target must never take the process down. `new URL`
  // and `decodeURIComponent` both throw on input a client controls.
  let rel;
  try {
    const url = new URL(req.url, 'http://localhost');
    rel = decodeURIComponent(url.pathname);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  // keep requests inside the served directory
  const target = path.resolve(ROOT, '.' + rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  const base = path.basename(target);
  const ext = path.extname(target).toLowerCase();
  if (base.startsWith('.') || (!SERVE_NAME.has(base.toLowerCase()) && !SERVE_EXT.has(ext))) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---------------------------------------------------------------- tiny websocket
// Just what this needs: handshake, text frames, ping/pong, close. No
// dependencies, so it runs on a bare node install.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.closed = false;
    this.lastPong = Date.now();
    this.fragParts = null;    // partial message being reassembled
    this.fragOpcode = null;
    this.fragSize = 0;
    this.tokens = RATE_BURST; // message budget
    this.tokenAt = Date.now();
    this.strikes = 0;
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      // A hostile frame must not be able to take the process down the way a
      // malformed URL once could.
      try {
        this.drain();
      } catch (err) {
        console.warn('  ! bad frame from a client: ' + err.message);
        this.close();
      }
    });
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  drain() {
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 0x8) { this.close(); return; }
      if (frame.opcode === 0x9) { this.sendFrame(0xA, frame.payload); continue; }  // ping -> pong
      if (frame.opcode === 0xA) { this.lastPong = Date.now(); continue; }         // pong

      // A message can arrive in pieces. Accumulate them until the final frame
      // rather than dropping the continuation frames on the floor.
      if (frame.opcode === 0x1) {
        if (frame.fin) {
          if (this.onMessage) this.onMessage(frame.payload.toString('utf8'));
        } else {
          this.fragOpcode = 0x1;
          this.fragParts = [frame.payload];
          this.fragSize = frame.payload.length;
        }
        continue;
      }
      if (frame.opcode === 0x0) {
        if (!this.fragParts) { this.close(); return; }   // continuation with nothing to continue
        this.fragSize += frame.payload.length;
        if (this.fragSize > MAX_MSG) { this.close(); return; }
        this.fragParts.push(frame.payload);
        if (frame.fin) {
          const whole = Buffer.concat(this.fragParts);
          const wasOpcode = this.fragOpcode;
          this.fragParts = null; this.fragOpcode = null; this.fragSize = 0;
          if (wasOpcode === 0x1 && this.onMessage) this.onMessage(whole.toString('utf8'));
        }
        continue;
      }
      // binary and anything else we do not speak: ignore it
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    // No extensions are negotiated, so the reserved bits must be clear, and
    // RFC 6455 requires every client-to-server frame to be masked. A server
    // that accepts unmasked frames is trusting input it should not.
    if (rsv !== 0 || !masked) { this.close(); return null; }
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || len > 125)) { this.close(); return null; }
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_MSG)) { this.close(); return null; }
      len = Number(big); off += 8;
    }
    if (len > MAX_MSG) { this.close(); return null; }
    if (b.length < off + 4) return null;
    const mask = b.subarray(off, off + 4); off += 4;
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { opcode, payload, fin };
  }

  sendFrame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (err) { this.destroy(); }
  }

  send(text) { this.sendFrame(0x1, Buffer.from(text, 'utf8')); }
  ping() { this.sendFrame(0x9, Buffer.alloc(0)); }

  close() {
    if (!this.open) return;
    try { this.sendFrame(0x8, Buffer.alloc(0)); } catch (err) { /* ignore */ }
    this.open = false;
    try { this.socket.end(); } catch (err) { /* ignore */ }
    this.destroy();
  }

  // Fires onClose exactly once. Kept separate from `open` so close() can clear
  // `open` first without suppressing the departure notification.
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    const f = this.onClose;
    this.onClose = null;
    if (f) f();
  }
}

// A stable colour per nickname, so everyone is visibly different and a name
// always looks the same to everybody. FNV-1a over the lowercased name picks
// the hue; the lightness is nudged by a second hash so names that land on
// similar hues still separate.
function colourForName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '#c8453a';
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let h2 = h;
  h2 ^= h2 >>> 13; h2 = Math.imul(h2, 2246822519) >>> 0; h2 ^= h2 >>> 15;

  const hue = h % 360;
  const sat = 58 + (h2 % 22);            // 58-79%
  const light = 45 + ((h2 >>> 8) % 16);  // 45-60%
  return hslToHex(hue / 360, sat / 100, light / 100);
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

// ---------------------------------------------------------------- build + reload
// The relay knows when the page on disk changes, so it can push every open
// client to reload instead of making people refresh by hand.
const PAGE_FILE = path.join(__dirname, 'index.html');

function buildId() {
  try { return String(fs.statSync(PAGE_FILE).mtimeMs); } catch (err) { return '0'; }
}
let BUILD = buildId();

// One city per server run: every client builds the same map from this, and a
// client that arrives with a different one is sent back to reload with it.
const WORLD_SEED = Number.isFinite(Number(process.env.SEED)) && process.env.SEED
  ? (Number(process.env.SEED) >>> 0)
  : ((Math.random() * 0x7fffffff) >>> 0);   // SEED=123 node server.js for a fixed city

// ---------------------------------------------------------------- one shared game
const players = new Map();     // id -> { conn, name, color, joined }
let nextId = 1;

const jsonSend = (conn, obj) => {
  try { conn.send(JSON.stringify(obj)); } catch (err) { /* peer vanished mid-send */ }
};

// Scoreboard: the relay is the only party that sees every wreck, so it keeps
// the tallies rather than trusting clients to report their own.
const scores = new Map();     // id -> { kills, deaths, streak, best }

// Consecutive kills without being wrecked, and the shout for each level.
const STREAK_LABELS = {
  2: 'DOUBLE KILL',
  3: 'TRIPLE KILL',
  4: 'RAMPAGE',
  5: 'DOMINATING',
  6: 'UNSTOPPABLE',
  8: 'LEGENDARY',
};
const streakLabel = (n) => STREAK_LABELS[n] || null;

const scoreFor = (id) => {
  let sc = scores.get(id);
  if (!sc) { sc = { kills: 0, deaths: 0, streak: 0, best: 0 }; scores.set(id, sc); }
  return sc;
};

function scoreboard() {
  return [...players.entries()]
    .map(([id, p]) => {
      const sc = scoreFor(id);
      return {
        id, name: p.name, color: p.color,
        kills: sc.kills, deaths: sc.deaths,
        streak: sc.streak, best: sc.best,
      };
    })
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.id - b.id));
}

const roster = () => [...players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color }));

function broadcast(obj, exceptConn) {
  const text = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.conn !== exceptConn && p.conn.open) {
      try { p.conn.send(text); } catch (err) { /* ignore */ }
    }
  }
}

let lastReload = 0;

function reloadAll(reason) {
  BUILD = buildId();
  const n = players.size;
  broadcast({ t: "reload", build: BUILD, why: reason });
  console.log(`  ~ reloading ${n} client${n === 1 ? "" : "s"} (${reason})`);
}

function dropPlayer(id) {
  if (!players.has(id)) return;
  players.delete(id);
  scores.delete(id);
  broadcast({ t: 'peer-left', id });
  broadcast({ t: 'scores', scores: scoreboard() });
}

function handleMessage(conn, msg) {
  if (msg.t === 'hello') {
    // Strip anything that could be markup or a control character. The page
    // escapes names when it renders them, but a name should not need escaping
    // in the first place.
    const clean = String(msg.name || '').replace(/[<>&"'`\\]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
    conn.name = clean.slice(0, 16) || ('racer' + conn.id);
    conn.color = colourForName(conn.name);
    const entry = players.get(conn.id);
    if (entry) { entry.name = conn.name; entry.color = conn.color; }
    broadcast({ t: 'roster', roster: roster() });
    return;
  }

  // car state: relay to everyone else, stamped with who it came from
  if (msg.t === 'state') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.a !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.a)) return;
    broadcast({
      t: 'state',
      from: conn.id,
      x: Math.round(msg.x), y: Math.round(msg.y), a: msg.a,
      n: conn.name, c: conn.color,
      hb: msg.hb ? 1 : 0,
      d: typeof msg.d === 'number' ? msg.d : 0,
      sk: msg.sk ? 1 : 0,
      sx0: msg.sx0, sy0: msg.sy0, sx1: msg.sx1, sy1: msg.sy1,
      // ability flags, so a remote car can show flames or a shield bubble
      bo: msg.bo ? 1 : 0,
      sh: msg.sh ? 1 : 0,
      it: typeof msg.it === 'string' && msg.it.length < 16 ? msg.it : null,
    }, conn);
    return;
  }

  // collision notice routed to the player who was hit
  if (msg.t === 'bump') {
    const to = players.get(Number(msg.to));
    if (to && to.conn.open) {
      to.conn.lastHitBy = conn.id;
      jsonSend(to.conn, {
        t: 'bump',
        from: conn.id,
        vx: Number(msg.vx) || 0,
        vy: Number(msg.vy) || 0,
      });
    }
    return;
  }

  // gunshot and explosion notices, broadcast so everyone can see and hear
  // them. Purely cosmetic: damage is decided by the shooter's own 'hit'.
  if (msg.t === 'fire') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.a !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.a)) return;
    broadcast({
      t: 'fire', from: conn.id,
      x: Math.round(msg.x), y: Math.round(msg.y), a: msg.a,
      w: typeof msg.w === 'string' && msg.w.length < 16 ? msg.w : 'gun',
      vx: Number.isFinite(msg.vx) ? Math.round(msg.vx) : 0,
      vy: Number.isFinite(msg.vy) ? Math.round(msg.vy) : 0,
    }, conn);
    return;
  }

  if (msg.t === 'bang') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'bang', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn);
    return;
  }

  // a wreck, credited to whoever landed the last hit. Names and colours are
  // filled in from the relay's own records so a client cannot spoof them.
  if (msg.t === 'kill') {
    const entry = players.get(conn.id);
    // Prefer whoever the relay actually saw hit this player. Bullets and bumps
    // are reported by the attacker, so the relay has a record; blast and fire
    // damage is applied on the victim's own client and never passes through
    // here, so fall back to the name the victim supplies. Each car is simulated
    // locally, so this is best-effort attribution, not a verified one: a
    // modified client can still claim a kill that never happened.
    const claimed = Number(msg.by);
    const byId = (Number.isFinite(conn.lastHitBy) && conn.lastHitBy !== conn.id)
      ? conn.lastHitBy
      : (Number.isFinite(claimed) && claimed !== conn.id && players.has(claimed) ? claimed : null);
    const killer = byId !== null ? players.get(byId) : null;
    // tally it: a wreck credited to someone else is their kill and our death
    let shout = null;
    if (killer && byId !== conn.id) {
      const ks = scoreFor(byId);
      ks.kills++;
      ks.streak++;
      if (ks.streak > ks.best) ks.best = ks.streak;
      const label = streakLabel(ks.streak);
      if (label) shout = { id: byId, name: killer.name, color: killer.color, streak: ks.streak, label };
    }
    // dying always ends the victim's run
    const vs = scoreFor(conn.id);
    vs.deaths++;
    vs.streak = 0;
    if (shout) broadcast({ t: 'streak', ...shout });
    broadcast({
      t: 'kill',
      by: killer ? byId : null,
      byName: killer ? killer.name : null,
      byColor: killer ? killer.color : null,
      victim: conn.id,
      victimName: entry ? entry.name : ('racer' + conn.id),
      victimColor: entry ? entry.color : '#c8453a',
      x: Number.isFinite(msg.x) ? Math.round(msg.x) : 0,
      y: Number.isFinite(msg.y) ? Math.round(msg.y) : 0,
    });
    broadcast({ t: 'scores', scores: scoreboard() });
    return;
  }

  // item box taken: everyone hides it too
  if (msg.t === 'item') {
    const id = Number(msg.id);
    if (!Number.isFinite(id)) return;
    const kind = typeof msg.kind === 'string' && msg.kind.length < 16 ? msg.kind : null;
    broadcast({ t: 'item', from: conn.id, id, kind }, conn);
    return;
  }

  // something in the world was destroyed: everyone applies the same break
  if (msg.t === 'destroy') {
    const did = Number(msg.did);
    if (!Number.isFinite(did)) return;
    broadcast({ t: 'destroy', from: conn.id, did }, conn);
    return;
  }

  // an explosion: everyone sees it, and everyone inside it takes the hurt
  if (msg.t === 'blast') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    const r = Math.max(20, Math.min(900, Number(msg.r) || 150));
    const p = Math.max(0, Math.min(1, Number(msg.p) || 0.5));
    const own = Number.isFinite(Number(msg.own)) ? Number(msg.own) : conn.id;
    broadcast({ t: 'blast', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y), r, p, own }, conn);
    return;
  }

  // a nuke launch: everyone arms the same countdown and blast
  if (msg.t === 'nuke') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'nuke', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn);
    console.log(`  * player ${conn.id} launched a nuke`);
    return;
  }

  // a dropped mine: cosmetic and hazardous on every client
  if (msg.t === 'mine') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'mine', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn);
    return;
  }

  if (msg.t === 'use') {
    const kind = typeof msg.kind === 'string' && msg.kind.length < 16 ? msg.kind : null;
    if (!kind) return;
    broadcast({ t: 'use', from: conn.id, kind }, conn);
    return;
  }

  // a bullet that connected, routed to the player it hit
  if (msg.t === 'hit') {
    const to = players.get(Number(msg.to));
    if (!to || !to.conn.open) return;
    const dmg = Number(msg.dmg);
    if (!Number.isFinite(dmg) || dmg <= 0) return;
    to.conn.lastHitBy = conn.id;        // for crediting a kill later
    jsonSend(to.conn, { t: 'hit', from: conn.id, dmg: Math.min(dmg, 0.25) });
    return;
  }

  if (msg.t === 'leave') conn.close();
}

function pingAll() {
  const now = Date.now();
  for (const [id, p] of players) {
    if (now - p.conn.lastPong > PING_TIMEOUT) { p.conn.close(); continue; }
    p.conn.ping();
  }
}

// ---------------------------------------------------------------- server
// Watch the page itself. Editors often write in bursts, so debounce.
let watchTimer = null;
try {
  fs.watch(__dirname, (event, filename) => {
    if (filename && filename !== "index.html") return;
    const next = buildId();
    if (next === BUILD) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => reloadAll("index.html changed"), 400);
  });
} catch (err) {
  console.warn("  (file watching unavailable: " + err.message + ")");
}

function handleRequest(req, res) {
  try {
    routeRequest(req, res);
  } catch (err) {
    // A request must never be able to take the process down.
    try {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('server error');
    } catch (e) { /* the socket is already gone */ }
    console.warn('  ! request failed: ' + err.message);
  }
}

function routeRequest(req, res) {
  let url = null;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // The counts are harmless. Who is playing is only for the operator.
    const out = { ok: true, players: players.size, build: BUILD, seed: WORLD_SEED };
    if (isLoopback(req) || hasToken(req, url)) out.list = roster();
    res.end(JSON.stringify(out));
    return;
  }

  // Force every client to reload. This has real consequences for everyone
  // playing, so it needs the token printed at startup: an unauthenticated GET
  // is both a denial-of-service and reachable by any page the operator visits.
  if (url.pathname === '/reload') {
    if (!hasToken(req, url)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'reload needs the token printed at startup' }));
      return;
    }
    const now = Date.now();
    if (now - lastReload < RELOAD_WINDOW_MS) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too many reloads' }));
      return;
    }
    lastReload = now;
    reloadAll('manual request');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, build: BUILD, players: players.size }));
    return;
  }
  serveStatic(req, res);
}

// TLS is optional: set TLS_KEY and TLS_CERT to serve https/wss directly.
// Otherwise put this behind a proxy if the traffic crosses a network you do
// not trust.
const server = (TLS_KEY && TLS_CERT)
  ? require('https').createServer(
      { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) },
      handleRequest)
  : http.createServer(handleRequest);

// Bound the resources a single peer can pin down. Node already caps header
// size; these stop a connection that opens and then goes quiet, and cap the
// total sockets so a flood of half-open connections cannot exhaust the host.
server.maxConnections = 128;
server.headersTimeout = 10000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;

// Count connections per address so one host cannot take the whole lobby.
const perIp = new Map();
function ipOf(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function holdIp(ip) { perIp.set(ip, (perIp.get(ip) || 0) + 1); }
function releaseIp(ip) {
  const n = (perIp.get(ip) || 0) - 1;
  if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
}

server.on('upgrade', (req, socket) => {
  let ip = null;
  let held = false;
  try {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    if (players.size >= MAX_PLAYERS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    ip = ipOf(req);
    if ((perIp.get(ip) || 0) >= PER_IP_MAX) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    holdIp(ip);
    held = true;

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = new WsConn(socket);
    conn.id = nextId++;
    conn.name = 'racer' + conn.id;
    conn.color = colourForName(conn.name);
    players.set(conn.id, { conn, name: conn.name, color: conn.color, joined: Date.now() });

    // tell the newcomer who they are and who is already playing, then announce them
    jsonSend(conn, { t: 'welcome', id: conn.id, roster: roster(), scores: scoreboard(), build: BUILD, seed: WORLD_SEED });
    broadcast({ t: 'peer-joined', id: conn.id, roster: roster() }, conn);
    broadcast({ t: 'scores', scores: scoreboard() }, conn);
    console.log(`  + player ${conn.id} joined (${players.size} online)`);

    // A token bucket per connection. A client sending state at the intended
    // 20Hz never notices; one trying to flood the relay runs out and is cut off.
    conn.onMessage = (text) => {
      const now = Date.now();
      conn.tokens = Math.min(RATE_BURST, conn.tokens + (now - conn.tokenAt) / 1000 * RATE_PER_SEC);
      conn.tokenAt = now;
      if (conn.tokens < 1) {
        conn.strikes += 1;
        if (conn.strikes > 40) {
          console.warn('  ! player ' + conn.id + ' cut off for flooding');
          conn.close();
        }
        return;
      }
      conn.tokens -= 1;
      conn.strikes = Math.max(0, conn.strikes - 0.02);

      let msg;
      try { msg = JSON.parse(text); } catch (err) { return; }
      if (!msg || typeof msg !== 'object') return;
      handleMessage(conn, msg);
    };
    conn.ip = ip;
    held = false;               // the conn owns the slot now; onClose frees it
    conn.onClose = () => {
      releaseIp(conn.ip);
      dropPlayer(conn.id);
      console.log(`  - player ${conn.id} left (${players.size} online)`);
    };
  } catch (err) {
    console.warn('  ! upgrade failed: ' + err.message);
    if (held && ip) releaseIp(ip);
    try { socket.destroy(); } catch (e) { /* already gone */ }
  }
});

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`\n  Port ${PORT} needs elevated permissions on this machine.`);
    console.error('  Either run with sudo, or pick a different port:\n');
    console.error('      PORT=8080 node server.js\n');
    process.exit(1);
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try PORT=8080 node server.js\n`);
    process.exit(1);
  }
  console.error(err.message);
  process.exit(1);
});

// Press r + Enter on the server to force a reload of every client.
if (process.stdin.isTTY) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const cmd = chunk.trim().toLowerCase();
    if (cmd === "r" || cmd === "reload") reloadAll("console");
  });
}

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (!ni.internal && (ni.family === 'IPv4' || ni.family === 'IPv6')) list.push(ni.address);
    }
  }
  console.log(`\n  Leonida is up on port ${addr.port} (bound to ${addr.address}, ${addr.family})\n`);
  console.log(`    this machine   http://localhost:${addr.port}`);
  for (const a of list) console.log(`    same network   http://${a.includes(':') ? '[' + a + ']' : a}:${addr.port}`);
  if (addr.family === 'IPv6' && addr.address === '::') {
    console.log('\n  Binding :: accepts IPv4 too on Linux/macOS (dual-stack).');
  }
  console.log(`\n  World seed: ${WORLD_SEED} (restart the server for a new city).`);
  console.log('  Everyone who opens that address is in the same game. No codes.');
  console.log('  Editing index.html reloads every open client automatically.');
  console.log('  Reload token: ' + RELOAD_TOKEN + '  (needed for /reload; press r here instead)');
  console.log('  Per connection: ' + RATE_PER_SEC + ' messages/sec, ' + PER_IP_MAX + ' connections per address.');
  console.log(TLS_KEY ? '  Serving over TLS.' : '  Plain HTTP: put this behind a proxy or set TLS_KEY/TLS_CERT for wss.');
  if (PORT !== 80) console.log('\n  Note: the page auto-connects to whatever port served it, so this is fine.');
  console.log('');

  setInterval(pingAll, PING_INTERVAL).unref();
});
