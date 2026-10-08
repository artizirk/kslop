#!/usr/bin/env bun
/*
 * Leonida — game host and relay (Bun edition).
 *
 * Serves the single-page game and relays each player's car to everyone else,
 * using Bun's built-in WebSocket server. No dependencies, no build step, no
 * node_modules:
 *
 *   bun server.ts                 # port 8080 on all interfaces
 *   PORT=9000 bun server.ts
 *   HOST=127.0.0.1 bun server.ts  # loopback only
 *   SEED=123 bun server.ts        # a fixed city
 *
 * There is deliberately no file server: the game is one self-contained
 * index.html, so every path (except /health and /reload) returns that page.
 * WebSocket framing, masking, fragmentation, control frames and flow control
 * are all handled by Bun's native implementation.
 */

// ---------------------------------------------------------------------------
// Minimal Bun typings. Declared here so the tree needs no @types/bun — the
// project stays dependency-free. If you later add @types/bun, delete this.
// ---------------------------------------------------------------------------
interface WsData {
  id: number;
  name: string;
  color: string;
  ip: string;
  tokens: number;
  tokenAt: number;
  strikes: number;
  lastHitBy: number | null;
}
interface Ws {
  data: WsData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  readonly remoteAddress: string;
}
interface Address {
  address: string;
  family: string;
  port: number;
}
interface Serve {
  readonly port: number;
  readonly hostname: string;
  upgrade(req: Request, opts?: { data?: WsData }): boolean;
  requestIP(req: Request): Address | null;
  stop(): void;
}
interface ServeOptions {
  port: number;
  hostname: string;
  fetch(req: Request, server: Serve): Response | undefined;
  websocket: {
    maxPayloadLength?: number;
    idleTimeout?: number;
    open?(ws: Ws): void;
    message?(ws: Ws, message: string | Uint8Array): void;
    close?(ws: Ws, code: number, reason: string): void;
    drain?(ws: Ws): void;
  };
}
declare const Bun: { serve(opts: ServeOptions): Serve };

import { readFileSync, statSync, watch } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = import.meta.dir;
const PAGE_FILE = `${ROOT}/index.html`;

const RELOAD_TOKEN = process.env.TOKEN || randomBytes(16).toString('hex');
const RATE_PER_SEC = 90;   // a client sends ~20 state packets a second
const RATE_BURST = 180;
const MAX_PLAYERS = 16;
const PER_IP_MAX = Math.max(1, Number(process.env.PER_IP_MAX) || 4);
const RELOAD_WINDOW_MS = 2000;

// Addresses allowed to name the real client in X-Real-IP / X-Forwarded-For.
// Loopback is always trusted (a proxy on the same host); list the proxy when it
// runs elsewhere, e.g. another container: TRUSTED_PROXY=172.18.0.4 or 172.16.0.0/12.
const TRUSTED_PROXY = String(process.env.TRUSTED_PROXY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
function isLoopbackAddress(a: string): boolean {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost';
}

// Fold ::ffff:a.b.c.d to a.b.c.d, so one client cannot double its connection
// budget by arriving over both families, and an IPv4 proxy still matches an
// IPv4 TRUSTED_PROXY entry.
function normalizeAddress(a: unknown): string {
  const v = String(a ?? '').trim().toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : v;
}

// A literal IPv4/IPv6 address to { bits, n }, or null. Used for CIDR tests.
function ipToBigInt(addr: string): { bits: number; n: bigint } | null {
  const v = normalizeAddress(addr);
  const is4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
  if (is4) {
    let n = 0n;
    for (const o of v.split('.')) {
      const octet = Number(o);
      if (octet > 255) return null;
      n = (n << 8n) | BigInt(octet);
    }
    return { bits: 32, n };
  }
  if (!v.includes(':')) return null;
  let host = v.includes('%') ? v.slice(0, v.indexOf('%')) : v;
  let groups: string[];
  if (host.includes('::')) {
    const [head, tail] = host.split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const mid = 8 - a.length - b.length;
    if (mid < 0) return null;
    groups = [...a, ...Array(mid).fill('0'), ...b];
  } else {
    groups = host.split(':');
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt('0x' + g);
  }
  return { bits: 128, n };
}

function inCidr(addr: string, cidr: string): boolean {
  const ip = ipToBigInt(addr);
  if (!ip) return false;
  const slash = cidr.indexOf('/');
  const netAddr = ipToBigInt(slash < 0 ? cidr : cidr.slice(0, slash));
  if (!netAddr || netAddr.bits !== ip.bits) return false;
  if (slash < 0) return ip.n === netAddr.n;
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > netAddr.bits) return false;
  const shift = BigInt(netAddr.bits - prefix);
  return (ip.n >> shift) === (netAddr.n >> shift);
}

function isTrustedProxy(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (isLoopbackAddress(a)) return true;
  return TRUSTED_PROXY.some((c) => inCidr(a, c));
}

// The address a request really came from, for the per-address limiter. Only a
// trusted peer may name it. Prefer X-Real-IP (nginx sets it from $remote_addr),
// otherwise the LAST X-Forwarded-For hop: earlier hops are client-supplied.
function clientAddress(peer: string, headers: Headers): string {
  if (!isTrustedProxy(peer)) return normalizeAddress(peer);
  const isIp = (v: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || v.includes(':');
  const real = headers.get('x-real-ip');
  if (real && isIp(real.trim())) return normalizeAddress(real.trim());
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((x) => x.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last && isIp(last)) return normalizeAddress(last);
  }
  return normalizeAddress(peer);
}

// Capacity is per resolved client address, so one host cannot take the lobby.
const perIp = new Map<string, number>();
const holdIp = (ip: string) => perIp.set(ip, (perIp.get(ip) || 0) + 1);
function releaseIp(ip: string): void {
  const n = (perIp.get(ip) || 0) - 1;
  if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
}

// ---------------------------------------------------------------------------
// Colour per nickname (FNV-1a), so everyone is visibly different
// ---------------------------------------------------------------------------
function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number): string => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function colourForName(name: string): string {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '#c8453a';
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let h2 = h;
  h2 ^= h2 >>> 13; h2 = Math.imul(h2, 2246822519) >>> 0; h2 ^= h2 >>> 15;
  return hslToHex((h % 360) / 360, (58 + (h2 % 22)) / 100, (45 + ((h2 >>> 8) % 16)) / 100);
}

// ---------------------------------------------------------------------------
// Build + world seed
// ---------------------------------------------------------------------------
function buildId(): string {
  try { return String(statSync(PAGE_FILE).mtimeMs); } catch { return '0'; }
}
let BUILD = buildId();

const WORLD_SEED = process.env.SEED && Number.isFinite(Number(process.env.SEED))
  ? (Number(process.env.SEED) >>> 0)
  : ((Math.random() * 0x7fffffff) >>> 0);

// The page itself, read once into memory. Reloaded by reloadAll on file change.
let PAGE = '';
function loadPage(): void {
  try { PAGE = readFileSync(PAGE_FILE, 'utf8'); }
  catch (err) { console.error('  ! could not read ' + PAGE_FILE + ': ' + (err as Error).message); }
}
loadPage();

// ---------------------------------------------------------------------------
// One shared game
// ---------------------------------------------------------------------------
interface Player { ws: Ws; name: string; color: string; joined: number; }
interface Score { kills: number; deaths: number; streak: number; best: number; }

const players = new Map<number, Player>();
const scores = new Map<number, Score>();
let nextId = 1;

const jsonSend = (ws: Ws, obj: unknown): void => {
  try { ws.send(JSON.stringify(obj)); } catch { /* peer vanished mid-send */ }
};

const STREAK_LABELS: Record<number, string> = {
  2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'RAMPAGE',
  5: 'DOMINATING', 6: 'UNSTOPPABLE', 8: 'LEGENDARY',
};
const streakLabel = (n: number): string | null => STREAK_LABELS[n] || null;

function scoreFor(id: number): Score {
  let sc = scores.get(id);
  if (!sc) { sc = { kills: 0, deaths: 0, streak: 0, best: 0 }; scores.set(id, sc); }
  return sc;
}

const roster = () => [...players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color }));

function scoreboard() {
  return [...players.entries()]
    .map(([id, p]) => {
      const sc = scoreFor(id);
      return { id, name: p.name, color: p.color, kills: sc.kills, deaths: sc.deaths, streak: sc.streak, best: sc.best };
    })
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.id - b.id));
}

function broadcast(obj: unknown, exceptId?: number): void {
  const text = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    try { p.ws.send(text); } catch { /* slow or gone; Bun drops under backpressure */ }
  }
}

let lastReload = 0;

function reloadAll(reason: string): void {
  loadPage();
  BUILD = buildId();
  broadcast({ t: 'reload', build: BUILD, why: reason });
  console.log(`  ~ reloading ${players.size} client${players.size === 1 ? '' : 's'} (${reason})`);
}

function dropPlayer(id: number): void {
  if (!players.has(id)) return;
  players.delete(id);
  scores.delete(id);
  broadcast({ t: 'peer-left', id });
  broadcast({ t: 'scores', scores: scoreboard() });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleMessage(ws: Ws, msg: any): void {
  const conn = ws.data;
  if (!players.has(conn.id)) return;

  if (msg.t === 'hello') {
    // Strip anything that could be markup or a control character.
    const clean = String(msg.name || '').replace(/[<>&"'`\\]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
    conn.name = clean.slice(0, 16) || ('racer' + conn.id);
    conn.color = colourForName(conn.name);
    const entry = players.get(conn.id);
    if (entry) { entry.name = conn.name; entry.color = conn.color; }
    broadcast({ t: 'roster', roster: roster() });
    return;
  }

  if (msg.t === 'state') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.a !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.a)) return;
    broadcast({
      t: 'state', from: conn.id,
      x: Math.round(msg.x), y: Math.round(msg.y), a: msg.a,
      n: conn.name, c: conn.color,
      hb: msg.hb ? 1 : 0,
      d: typeof msg.d === 'number' ? msg.d : 0,
      sk: msg.sk ? 1 : 0,
      sx0: msg.sx0, sy0: msg.sy0, sx1: msg.sx1, sy1: msg.sy1,
      bo: msg.bo ? 1 : 0,
      sh: msg.sh ? 1 : 0,
      it: typeof msg.it === 'string' && msg.it.length < 16 ? msg.it : null,
    }, conn.id);
    return;
  }

  if (msg.t === 'bump') {
    const to = players.get(Number(msg.to));
    if (to) {
      to.ws.data.lastHitBy = conn.id;
      jsonSend(to.ws, { t: 'bump', from: conn.id, vx: Number(msg.vx) || 0, vy: Number(msg.vy) || 0 });
    }
    return;
  }

  if (msg.t === 'fire') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number' || typeof msg.a !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.a)) return;
    broadcast({
      t: 'fire', from: conn.id,
      x: Math.round(msg.x), y: Math.round(msg.y), a: msg.a,
      w: typeof msg.w === 'string' && msg.w.length < 16 ? msg.w : 'gun',
      vx: Number.isFinite(msg.vx) ? Math.round(msg.vx) : 0,
      vy: Number.isFinite(msg.vy) ? Math.round(msg.vy) : 0,
    }, conn.id);
    return;
  }

  if (msg.t === 'bang') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'bang', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn.id);
    return;
  }

  if (msg.t === 'kill') {
    const entry = players.get(conn.id);
    // Prefer whoever the relay saw hit this player; blast and fire damage is
    // applied on the victim's client and never passes through here, so fall
    // back to the name the victim supplies. Best-effort, not verified.
    const claimed = Number(msg.by);
    const byId = (Number.isFinite(conn.lastHitBy as number) && conn.lastHitBy !== conn.id)
      ? conn.lastHitBy
      : (Number.isFinite(claimed) && claimed !== conn.id && players.has(claimed) ? claimed : null);
    const killer = byId !== null ? players.get(byId) : null;
    let shout: any = null;
    if (killer && byId !== conn.id) {
      const ks = scoreFor(byId);
      ks.kills++;
      ks.streak++;
      if (ks.streak > ks.best) ks.best = ks.streak;
      const label = streakLabel(ks.streak);
      if (label) shout = { id: byId, name: killer.name, color: killer.color, streak: ks.streak, label };
    }
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

  if (msg.t === 'item') {
    const id = Number(msg.id);
    if (!Number.isFinite(id)) return;
    const kind = typeof msg.kind === 'string' && msg.kind.length < 16 ? msg.kind : null;
    broadcast({ t: 'item', from: conn.id, id, kind }, conn.id);
    return;
  }

  if (msg.t === 'destroy') {
    const did = Number(msg.did);
    if (!Number.isFinite(did)) return;
    broadcast({ t: 'destroy', from: conn.id, did }, conn.id);
    return;
  }

  if (msg.t === 'blast') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    const r = Math.max(20, Math.min(900, Number(msg.r) || 150));
    const p = Math.max(0, Math.min(1, Number(msg.p) || 0.5));
    const own = Number.isFinite(Number(msg.own)) ? Number(msg.own) : conn.id;
    broadcast({ t: 'blast', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y), r, p, own }, conn.id);
    return;
  }

  if (msg.t === 'nuke') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'nuke', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn.id);
    console.log(`  * player ${conn.id} launched a nuke`);
    return;
  }

  if (msg.t === 'mine') {
    if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
    broadcast({ t: 'mine', from: conn.id, x: Math.round(msg.x), y: Math.round(msg.y) }, conn.id);
    return;
  }

  if (msg.t === 'use') {
    const kind = typeof msg.kind === 'string' && msg.kind.length < 16 ? msg.kind : null;
    if (!kind) return;
    broadcast({ t: 'use', from: conn.id, kind }, conn.id);
    return;
  }

  if (msg.t === 'hit') {
    const to = players.get(Number(msg.to));
    if (!to) return;
    const dmg = Number(msg.dmg);
    if (!Number.isFinite(dmg) || dmg <= 0) return;
    to.ws.data.lastHitBy = conn.id;
    jsonSend(to.ws, { t: 'hit', from: conn.id, dmg: Math.min(dmg, 0.25) });
    return;
  }

  if (msg.t === 'leave') ws.close();
}

// One token bucket per connection. Exceeding it closes the socket.
function spend(ws: Ws): boolean {
  const d = ws.data;
  const now = Date.now();
  d.tokens = Math.min(RATE_BURST, d.tokens + (now - d.tokenAt) / 1000 * RATE_PER_SEC);
  d.tokenAt = now;
  if (d.tokens < 1) {
    d.strikes += 1;
    if (d.strikes === 41) console.warn('  ! player ' + d.id + ' cut off for flooding');
    if (d.strikes > 40) ws.close(1008, 'flooding');
    return false;
  }
  d.tokens -= 1;
  d.strikes = Math.max(0, d.strikes - 0.02);
  return true;
}

// ---------------------------------------------------------------------------
// HTTP: the page, plus /health and /reload
// ---------------------------------------------------------------------------
function hasToken(req: Request, url: URL): boolean {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const query = url.searchParams.get('token') || '';
  return safeEqual(bearer, RELOAD_TOKEN) || safeEqual(query, RELOAD_TOKEN);
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length || A.length === 0) return false;
  return timingSafeEqual(A, B);
}

function isOperator(req: Request, peer: string): boolean {
  // The operator conveniences are gated on the raw peer, never on a forwarded
  // header a proxy might pass through.
  return isLoopbackAddress(normalizeAddress(peer));
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
  });

function handleRequest(req: Request, server: Serve): Response | undefined {
  let url: URL;
  try { url = new URL(req.url); } catch { return new Response('bad request', { status: 400 }); }

  const addr = server.requestIP(req);
  const peer = addr ? addr.address : '0.0.0.0';

  if (url.pathname === '/health') {
    const out: any = { ok: true, players: players.size, build: BUILD, seed: WORLD_SEED };
    if (isOperator(req, peer) || hasToken(req, url)) out.list = roster();
    return json(out);
  }

  if (url.pathname === '/reload') {
    if (!hasToken(req, url)) return json({ ok: false, error: 'reload needs the token printed at startup' }, 403);
    const now = Date.now();
    if (now - lastReload < RELOAD_WINDOW_MS) return json({ ok: false, error: 'too many reloads' }, 429);
    lastReload = now;
    reloadAll('manual request');
    return json({ ok: true, build: BUILD, players: players.size });
  }

  // Everything else that is not a WebSocket upgrade gets the page.
  const ip = clientAddress(peer, req.headers);
  if (players.size >= MAX_PLAYERS) return new Response('the game is full', { status: 503 });
  if ((perIp.get(ip) || 0) >= PER_IP_MAX) return new Response('too many connections from this address', { status: 429 });

  const data: WsData = {
    id: 0, name: '', color: '', ip,
    tokens: RATE_BURST, tokenAt: Date.now(), strikes: 0, lastHitBy: null,
  };
  if (server.upgrade(req, { data })) { holdIp(ip); return undefined; }

  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  return new Response(req.method === 'HEAD' ? null : PAGE, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' },
  });
}

// ---------------------------------------------------------------------------
// Watch index.html; push a reload to every client when it changes
// ---------------------------------------------------------------------------
let watchTimer: ReturnType<typeof setTimeout> | null = null;
try {
  watch(ROOT, (_event, filename) => {
    if (filename && filename !== 'index.html') return;
    if (buildId() === BUILD) return;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => reloadAll('index.html changed'), 400);
  });
} catch (err) {
  console.warn('  (file watching unavailable: ' + (err as Error).message + ')');
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------
let server: Serve;
try {
  server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: handleRequest,
    websocket: {
      maxPayloadLength: 8 * 1024,   // state packets are ~120 bytes; be strict
      idleTimeout: 120,             // clients send state ~20Hz, so never idle
      open(ws) {
        const d = ws.data;
        d.id = nextId++;
        d.name = 'racer' + d.id;
        d.color = colourForName(d.name);
        players.set(d.id, { ws, name: d.name, color: d.color, joined: Date.now() });
        jsonSend(ws, { t: 'welcome', id: d.id, roster: roster(), scores: scoreboard(), build: BUILD, seed: WORLD_SEED });
        broadcast({ t: 'peer-joined', id: d.id, roster: roster() }, d.id);
        broadcast({ t: 'scores', scores: scoreboard() }, d.id);
        console.log(`  + player ${d.id} joined (${players.size} online)`);
      },
      message(ws, message) {
        if (!spend(ws)) return;
        if (typeof message !== 'string') return;
        let msg: unknown;
        try { msg = JSON.parse(message); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        handleMessage(ws, msg);
      },
      close(ws) {
        const d = ws.data;
        releaseIp(d.ip);
        if (players.has(d.id)) {
          dropPlayer(d.id);
          console.log(`  - player ${d.id} left (${players.size} online)`);
        }
      },
      drain() { /* Bun signals the socket can take more; nothing to do */ },
    },
  });
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Try PORT=9000 bun server.ts\n`);
  else if (e.code === 'EACCES') console.error(`\n  Port ${PORT} needs elevated permissions. Try PORT=9000 bun server.ts\n`);
  else console.error(e.message);
  process.exit(1);
}

// Press r + Enter on a terminal to force a reload of every client.
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    const cmd = chunk.trim().toLowerCase();
    if (cmd === 'r' || cmd === 'reload') reloadAll('console');
  });
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
{
  const list: string[] = [];
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const ni of ifaces || []) {
        if (!ni.internal && (ni.family === 'IPv4' || ni.family === 'IPv6')) list.push(ni.address);
      }
    }
  } catch { /* sandboxed: no interface enumeration */ }

  console.log(`\n  Leonida is up on port ${server.port} (bound to ${server.hostname})\n`);
  console.log(`    this machine   http://localhost:${server.port}`);
  for (const a of list) console.log(`    same network   http://${a.includes(':') ? '[' + a + ']' : a}:${server.port}`);
  console.log(`\n  World seed: ${WORLD_SEED} (restart the server for a new city).`);
  console.log('  Everyone who opens that address is in the same game. No codes.');
  console.log('  Editing index.html reloads every open client automatically.');
  console.log('  Reload token: ' + RELOAD_TOKEN + '  (needed for /reload; press r here instead)');
  console.log('  Per connection: ' + RATE_PER_SEC + ' messages/sec, ' + PER_IP_MAX + ' connections per address.');
  console.log('  Plain HTTP: terminate TLS at the proxy, or run it on a trusted network.');
  console.log('');
}
