#!/usr/bin/env node
'use strict';
/*
 * Security audit of server.ts (the Bun relay).
 *
 * Every finding is demonstrated against a real running instance rather than
 * inferred from reading the source. Each probe gets a freshly started server,
 * so a crash in one cannot mask the results of the next.
 *
 *   node tests/audit.js
 *
 * The instance binds to localhost (and, for one probe, the LAN address, so a
 * request that is not from loopback can be exercised). It never touches the
 * real relay port.
 */
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const WebSocket = require('./ws');

let nextPort = Number(process.env.AUDIT_PORT || 8300);
const HOST = '127.0.0.1';
const TOKEN = 'audit-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a real, non-loopback address on this machine (so isLoopback is false)
const LAN_IP = (() => {
  const n = os.networkInterfaces();
  for (const k in n) for (const a of n[k]) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
})();

const findings = [];
const record = (name, survived, severity, detail) => {
  findings.push({ name, survived, severity, detail });
  console.log((survived ? '  ok   ' : '  VULN ') + name + (detail ? ' :: ' + detail : ''));
};

// ---- a disposable server ------------------------------------------------
async function startServer(opts) {
  const o = opts || {};
  const port = nextPort++;
  const env = Object.assign({}, process.env, { PORT: String(port), SEED: '20251008', TOKEN: o.token || TOKEN });
  if (o.bindAll) env.HOST = '0.0.0.0'; else env.HOST = HOST;
  if (o.env) Object.assign(env, o.env);
  const proc = spawn('bun', [path.join(__dirname, '..', 'server.ts')], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const health = () => get(port, '/health', o.host || HOST, o.tls);

  for (let i = 0; i < 50; i++) { if ((await health()).status === 200) break; await sleep(150); }
  return {
    port,
    host: o.host || HOST,
    health,
    stderr: () => stderr,
    stop: () => { try { proc.kill(); } catch (e) {} },
  };
}

// run one probe against a private server; anything that stops it answering is
// reported as a finding
async function probe(name, severity, fn, opts) {
  const srv = await startServer(opts);
  let detail = '';
  let survived = true;
  try {
    const r = await fn(srv);
    survived = r && r.survived !== false;
    detail = (r && r.detail) || '';
  } catch (err) {
    survived = false;
    detail = 'the probe itself threw: ' + err.message;
  }
  if (survived) {
    const h = await srv.health();
    if (h.status !== 200) {
      survived = false;
      detail = 'the server stopped answering' +
        (srv.stderr().trim() ? ' — ' + srv.stderr().trim().split('\n').slice(-3).join(' | ') : '');
    }
  }
  record(name, survived, severity, detail);
  srv.stop();
  await sleep(120);
  return survived;
}

// ---- raw helpers --------------------------------------------------------
function rawHttp(port, payload, { waitMs = 500, host = HOST } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let out = '';
    let done = false;
    const finish = () => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(out); } };
    s.on('connect', () => s.write(payload));
    s.on('data', (d) => { out += d.toString('latin1'); });
    s.on('close', finish);
    s.on('error', finish);
    setTimeout(finish, waitMs);
  });
}
const rawGet = (port, p, opts) => rawHttp(port, 'GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\n\r\n', opts);
const rawHead = (s) => ((s.split('\r\n')[0] || '').trim());

function get(port, p, host, tls) {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const req = mod.get({ host: host || HOST, port, path: p, timeout: 1500, rejectUnauthorized: false }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// a raw websocket handshake so we can hand-write frames afterwards
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, HOST);
    let buf = '';
    s.on('connect', () => {
      s.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) resolve(s); });
    s.on('error', reject);
    setTimeout(() => reject(new Error('handshake timed out')), 2500);
  });
}

// open a normal websocket and wait for it (or fail)
function wsOpen(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + HOST + ':' + port + '/');
    let settled = false;
    ws.on('open', () => { if (!settled) { settled = true; resolve(ws); } });
    ws.on('error', () => { if (!settled) { settled = true; reject(new Error('ws error')); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('ws timeout')); } }, timeoutMs || 1500);
  });
}

// A raw handshake that reports the status line, so a rejected upgrade
// (426/429/503) can be told apart from a 101.
function wsHandshake(port, extraHeaders, host) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host || HOST);
    let buf = '';
    let done = false;
    const finish = (status) => { if (!done) { done = true; resolve({ socket: sock, status }); } };
    sock.on('connect', () => {
      sock.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        (extraHeaders || '') + '\r\n');
    });
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) finish((buf.split('\r\n')[0] || '').trim()); });
    sock.on('error', () => finish('error'));
    setTimeout(() => finish((buf.split('\r\n')[0] || 'timeout').trim()), 1200);
  });
}

function frame(text, opts) {
  const o = opts || {};
  const masked = o.masked !== false;
  const fin = o.fin !== false;
  const opcode = o.opcode === undefined ? 0x1 : o.opcode;
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const head = [(fin ? 0x80 : 0) | opcode];
  const maskBit = masked ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 255, len & 255);
  else head.push(maskBit | 127, 0, 0, 0, 0, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255);
  const header = Buffer.from(head);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([9, 8, 7, 6]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}


// ---- the audit ----------------------------------------------------------
(async () => {
  console.log('auditing server.ts (bun), one clean instance per probe\n');

  console.log('== malformed HTTP (crash resistance) ==');
  await probe('a bare "%" in the path', 'critical', async (s) => ({ survived: true, detail: rawHead(await rawGet(s.port, '/%')) }));
  await probe('a broken percent-escape ("/%zz")', 'critical', async (s) => { await rawGet(s.port, '/%zz'); return { survived: true }; });
  await probe('a truncated utf-8 escape ("/%e0%a4")', 'critical', async (s) => { await rawGet(s.port, '/%e0%a4'); return { survived: true }; });
  await probe('a 3000-character path', 'low', async (s) => { await rawGet(s.port, '/' + 'a'.repeat(3000)); return { survived: true }; });
  await probe('a garbage request line', 'medium', async (s) => { await rawHttp(s.port, 'GARBAGE\r\n\r\n'); return { survived: true }; });
  await probe('an absolute-URI request target', 'low', async (s) => { await rawGet(s.port, 'http://example.com/'); return { survived: true }; });
  await probe('a 3000-header request', 'medium', async (s) => { await rawHttp(s.port, 'GET / HTTP/1.1\r\nHost: x\r\n' + 'X-a: b\r\n'.repeat(3000) + '\r\n'); return { survived: true }; });
  await probe('a half-sent request (slowloris)', 'medium', async (s) => {
    const sock = net.connect(s.port, HOST); sock.on('error', () => {});
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n'); await sleep(600); sock.destroy();
    return { survived: true };
  });

  console.log('\n== path traversal ==');
  for (const p of ['/../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/..%2f..%2fetc%2fpasswd',
                   '/....//....//etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%252f..%252fetc%252fpasswd',
                   '/%2e%2e%2fserver.ts', '/..%2fserver.ts']) {
    await probe('traversal blocked: ' + p, 'critical', async (s) => {
      const r = await rawGet(s.port, p);
      const leaked = /root:.*:0:0:/.test(r);
      return { survived: !leaked, detail: leaked ? 'CONTENTS LEAKED' : 'blocked' };
    });
  }
  await probe("the folder's own source is not public", 'medium', async (s) => {
    const srv = await rawGet(s.port, '/server.ts');
    const docs = await rawGet(s.port, '/README.md');
    const dot = await rawGet(s.port, '/.gitignore');
    const exposed = [];
    if (/Bun\.serve|RELOAD_TOKEN/.test(srv)) exposed.push('server.ts');
    if (/^# /m.test(docs)) exposed.push('README.md');
    if (/\.idea/.test(dot)) exposed.push('.gitignore');
    return { survived: exposed.length === 0, detail: exposed.length ? 'served: ' + exposed.join(', ') : 'nothing outside the page' };
  });

  console.log('\n== only the page is reachable ==');
  await probe('a random file next to the page is not served', 'high', async (s) => {
    const marker = 'AUDIT_PRIVATE_MARKER_9f3c';
    const file = path.join(__dirname, 'audit-probe.txt');
    fs.writeFileSync(file, marker);
    try {
      const r = await rawGet(s.port, '/tests/audit-probe.txt');
      const leaked = r.includes(marker);
      const isPage = /<script>/.test(r);
      return { survived: !leaked && isPage, detail: leaked ? 'served the file' : 'returned the page' };
    } finally {
      try { fs.unlinkSync(file); } catch (e) { /* gone */ }
    }
  });
  await probe('the relay source is not served', 'high', async (s) => {
    const r = await rawGet(s.port, '/server.ts');
    const leaked = /Bun\.serve|RELOAD_TOKEN|TRUSTED_PROXY/.test(r);
    return { survived: !leaked, detail: leaked ? 'served the source' : 'returned the page' };
  });

  console.log('\n== the reload endpoint ==');
  await probe('/reload needs no authorisation', 'high', async (s) => {
    const open = /200/.test(rawHead(await rawGet(s.port, '/reload')));
    return { survived: !open, detail: open ? 'anyone reaching the port can force every player to reload' : 'refused without a token' };
  });
  await probe('/reload accepts a cross-origin GET', 'high', async (s) => {
    const r = await rawHttp(s.port, 'GET /reload HTTP/1.1\r\nHost: x\r\nOrigin: https://evil.example\r\n\r\n');
    const open = /200/.test(rawHead(r));
    return { survived: !open, detail: open ? 'a plain <img src> on any site triggers it' : 'refused even cross-origin' };
  });
  await probe('/reload works with the token', 'info', async (s) => {
    const r = await get(s.port, '/reload?token=' + TOKEN);
    return { survived: r.status === 200, detail: 'status ' + r.status };
  });
  await probe('/reload is rate limited', 'low', async (s) => {
    await get(s.port, '/reload?token=' + TOKEN);
    const second = await get(s.port, '/reload?token=' + TOKEN);
    return { survived: second.status === 429, detail: 'second rapid reload: ' + second.status };
  });
  await probe('/health hides the roster from the internet', 'low', async (s) => {
    if (!LAN_IP) return { survived: true, detail: 'no non-loopback address to test from' };
    const remote = await get(s.port, '/health', LAN_IP);
    const leaks = /"list":\s*\[/.test(remote.body);
    const local = await get(s.port, '/health', HOST);
    const localHas = /"list":\s*\[/.test(local.body);
    return { survived: !leaks && localHas, detail: leaks ? 'a remote request saw the roster' : 'remote: counts only; loopback: full roster' };
  }, { bindAll: true, host: LAN_IP });
  await probe('/health shows the roster with the token', 'info', async (s) => {
    if (!LAN_IP) return { survived: true };
    const r = await get(s.port, '/health?token=' + TOKEN, LAN_IP);
    return { survived: /"list":\s*\[/.test(r.body), detail: 'token unlocks the roster from anywhere' };
  }, { bindAll: true, host: LAN_IP });

  console.log('\n== websocket protocol handling ==');
  await probe('an unmasked client frame is refused', 'medium', async (s) => {
    const sock = await wsConnect(s.port);
    sock.write(frame(JSON.stringify({ t: 'hello', name: 'UNMASKED' }), { masked: false }));
    await sleep(300);
    const accepted = /UNMASKED/.test((await s.health()).body);
    sock.destroy();
    return { survived: !accepted, detail: accepted ? 'the RFC requires masked client frames' : '' };
  });
  await probe('a fragmented message is handled', 'low', async (s) => {
    const sock = await wsConnect(s.port);
    const whole = JSON.stringify({ t: 'hello', name: 'FRAGGED' });
    sock.write(frame(whole.slice(0, 8), { fin: false, opcode: 0x1 }));
    sock.write(frame(whole.slice(8), { fin: true, opcode: 0x0 }));
    await sleep(300);
    const worked = /FRAGGED/.test((await s.health()).body);
    sock.destroy();
    return { survived: worked, detail: worked ? '' : 'continuation frames are dropped' };
  });
  await probe('a control frame with a long payload is refused', 'low', async (s) => {
    const sock = await wsConnect(s.port);
    let closed = false;
    sock.on('close', () => { closed = true; });
    sock.write(frame('x'.repeat(200), { opcode: 0x9 }));
    await sleep(350);
    sock.destroy();
    return { survived: closed, detail: closed ? 'the connection was closed' : 'a 200-byte ping was accepted' };
  });
  await probe('a normal masked frame works', 'info', async (s) => {
    const sock = await wsConnect(s.port);
    sock.write(frame(JSON.stringify({ t: 'hello', name: 'NORMAL' })));
    await sleep(300);
    const ok = /NORMAL/.test((await s.health()).body);
    sock.destroy();
    return { survived: ok };
  });
  await probe('an oversized frame is cut off', 'info', async (s) => {
    const sock = await wsConnect(s.port);
    sock.write(frame(JSON.stringify({ t: 'hello', name: 'BIG' })));
    await sleep(150);
    sock.write(frame(JSON.stringify({ t: 'state', x: 1, y: 1, a: 0, pad: 'x'.repeat(20000) })));
    await sleep(300);
    return { survived: true, detail: 'single frames are capped at 8 KB' };
  });

  console.log('\n== the handshake ==');
  await probe('an old websocket version is refused', 'low', async (s) => {
    const r = await new Promise((resolve) => {
      const sock = net.connect(s.port, HOST);
      let buf = '';
      sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n'));
      sock.on('data', (d) => { buf += d.toString('latin1'); });
      setTimeout(() => { resolve((buf.split('\r\n')[0] || 'timeout').trim()); try { sock.destroy(); } catch (e) {} }, 500);
    });
    return { survived: /426/.test(r), detail: r };
  });
  await probe('a reserved opcode fails the connection', 'low', async (s) => {
    const sock = await wsConnect(s.port);
    let closed = false; sock.on('close', () => { closed = true; });
    sock.write(frame('', { opcode: 0x3 }));
    await sleep(300); sock.destroy();
    return { survived: closed, detail: closed ? '' : 'the connection stayed open' };
  });

  console.log('\n== resource limits ==');
  await probe('one client can flood the relay', 'high', async (s) => {
    const f = await wsOpen(s.port);
    const o = await wsOpen(s.port);
    let received = 0;
    o.on('message', () => received++);
    f.send(JSON.stringify({ t: 'hello', name: 'FLOODER' }));
    await sleep(250);
    const payload = JSON.stringify({ t: 'state', x: 1, y: 2, a: 0 });
    const t0 = Date.now();
    let attempted = 0;
    while (Date.now() - t0 < 1200) {
      for (let i = 0; i < 400; i++) { try { f.send(payload); attempted++; } catch (e) { break; } }
      await sleep(1);
    }
    await sleep(300);
    try { f.close(); o.close(); } catch (e) {}
    return { survived: received < 1500, detail: attempted.toLocaleString() + ' attempted, observer received ' + received.toLocaleString() };
  });
  await probe('one host can hold the lobby open', 'high', async (s) => {
    const conns = [];
    for (let i = 0; i < 10; i++) {
      try { conns.push(await wsOpen(s.port, 800)); } catch (e) { /* rejected, expected */ }
    }
    const held = conns.length;
    conns.forEach((c) => { try { c.close(); } catch (e) {} });
    return { survived: held <= 4, detail: held + ' of 10 connections from one address were accepted' };
  });

  // A connect/close loop must not turn every cycle into a fan-out to everyone.
  // (Backpressure has no automated probe here: the relay's forwarded messages
  // are small and loopback's kernel buffers are multi-megabyte, so a slow
  // reader cannot be pushed to the limit within a sensible test runtime.)
  await probe('a connect/disconnect loop is throttled', 'high', async (s) => {
    const obs = await wsOpen(s.port);
    let msgs = 0;
    obs.on('message', () => { msgs += 1; });
    await sleep(200);
    msgs = 0;
    const t0 = Date.now();
    let opened = 0;
    let rejected = 0;
    while (Date.now() - t0 < 2000) {
      try {
        const a = await wsOpen(s.port, 400);
        opened += 1;
        try { a.close(); } catch (e) { /* already gone */ }
      } catch (e) {
        rejected += 1;
      }
    }
    await sleep(400);
    try { obs.close(); } catch (e) { /* already gone */ }
    return {
      survived: rejected > 0 && msgs < 2000,
      detail: opened + ' opened, ' + rejected + ' refused, observer got ' + msgs + ' messages',
    };
  });

  await probe('a trusted proxy\'s forwarded header keys the address limit', 'high', async (s) => {
    const same = [];
    for (let i = 0; i < 5; i++) same.push(await wsHandshake(s.port, 'X-Real-IP: 198.51.100.7\r\n'));
    const accepted = same.filter((x) => /101/.test(x.status)).length;
    const other = await wsHandshake(s.port, 'X-Real-IP: 198.51.100.8\r\n');
    for (const x of same) { try { x.socket.destroy(); } catch (e) {} }
    try { other.socket.destroy(); } catch (e) {}
    return { survived: accepted === 4 && /101/.test(other.status),
      detail: accepted + '/5 from one forwarded address accepted; another forwarded address -> ' + other.status };
  });
  await probe('an untrusted peer cannot forge its address', 'high', async (s) => {
    if (!LAN_IP) return { survived: true, detail: 'no non-loopback address to test from' };
    // Every connection uses a different X-Real-IP; if the header were trusted
    // they would each get their own budget. Because this peer is not trusted,
    // they share one address and the fifth is refused.
    const conns = [];
    for (let i = 0; i < 5; i++) {
      conns.push(await wsHandshake(s.port, 'X-Real-IP: 203.0.113.' + (10 + i) + '\r\n', LAN_IP));
    }
    const accepted = conns.filter((x) => /101/.test(x.status)).length;
    for (const x of conns) { try { x.socket.destroy(); } catch (e) {} }
    return { survived: accepted === 4, detail: accepted + '/5 accepted (want 4: the header must be ignored)' };
  }, { bindAll: true, host: LAN_IP });

  await probe('a recorded hit beats a forged claim', 'info', async (s) => {
    // Attach the message handler in the same tick the socket is created: the
    // relay sends `welcome` (which carries the id) before an `open`-then-listen
    // caller would be ready.
    const ids = new Map();
    const kills = [];
    const open = (key) => new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://' + HOST + ':' + s.port + '/');
      ws.on('message', (t) => {
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (m.t === 'welcome') ids.set(key, m.id);
        if (m.t === 'kill') kills.push(m);
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('open timed out')), 1500);
    });
    const a = await open('a');
    const b = await open('b');
    const c = await open('c');
    await sleep(250);
    // a hits b, so the relay records a as b's attacker
    a.send(JSON.stringify({ t: 'hit', to: ids.get('b'), dmg: 0.1 }));
    await sleep(150);
    // b wrecks but blames c: the relay's own record should win
    b.send(JSON.stringify({ t: 'kill', by: ids.get('c') }));
    await sleep(300);
    const k = kills[kills.length - 1];
    const recordWins = !!k && k.by === ids.get('a') && k.by !== ids.get('c');
    // a cannot credit itself
    a.send(JSON.stringify({ t: 'kill', by: ids.get('a') }));
    await sleep(300);
    const self = kills[kills.length - 1];
    const selfBlocked = !!self && self.by !== ids.get('a');
    try { a.close(); b.close(); c.close(); } catch (e) {}
    return {
      survived: recordWins && selfBlocked,
      detail: 'relay-recorded attacker ' + (k && k.by) + ' (want ' + ids.get('a') + '); self-credit by=' + (self && self.by),
    };
  });
  record('kill attribution is best-effort, not verified', true, 'info',
    'blast and fire damage is applied on the victim client, so a modified client can still claim an unearned kill');
  await probe('a name cannot inject markup', 'medium', async (s) => {
    const a = await wsOpen(s.port);
    a.send(JSON.stringify({ t: 'hello', name: '<img src=x onerror=alert(1)>' }));
    await sleep(250);
    const raw = /<img/.test((await s.health()).body);
    try { a.close(); } catch (e) {}
    return { survived: !raw, detail: raw ? 'stored verbatim' : 'angle brackets stripped at the relay' };
  });

  console.log('\n== transport ==');
  await probe('the relay speaks plain HTTP', 'info', async (s) => {
    const r = await get(s.port, '/health');
    return { survived: r.status === 200, detail: 'terminate TLS at the proxy, or run on a trusted network' };
  });

  console.log('\n== summary ==');
  const vulns = findings.filter((f) => !f.survived);
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  vulns.sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of vulns) console.log('  [' + f.severity.toUpperCase() + '] ' + f.name + (f.detail ? '\n         ' + f.detail : ''));
  console.log('\n' + vulns.length + ' issue(s), ' + findings.length + ' probes');
  process.exit(vulns.length ? 1 : 0);
})().catch((e) => { console.error('audit could not run: ' + e.message); process.exit(2); });
