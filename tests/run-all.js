#!/usr/bin/env node
'use strict';
// Run every suite in order. Node suites first (fast, they catch the logic),
// then the browser ones (slower, but they drive real Chrome and catch
// rendering, input and layout).
//
//   node tests/run-all.js            everything
//   node tests/run-all.js harness    only suites whose name matches
//
// The relay is started here if one is not already listening, and the script is
// extracted from index.html into tests/.game.js for the node suites.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const DIR = __dirname;
const SUITES = [
  'harness.js', 'harness-net.js', 'input.js', 'render.js',
  'relay.js',
  'browser.js', 'browser-fx.js', 'browser-items.js', 'browser-destroy.js',
  'browser-nuke.js', 'browser-board.js', 'browser-pads.js', 'browser-spawn.js',
  'browser-peds.js', 'browser-mobilefix.js', 'browser-shop.js',
  'audit.js',
];

const PAGE = path.join(DIR, '..', 'index.html');
const GAME = path.join(DIR, '.game.js');
const PORT = Number(process.env.RELAY_PORT || 8099);

function extractGame() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('no <script> block found in ' + PAGE);
  fs.writeFileSync(GAME, m[1]);
}

const healthy = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 800 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

(async () => {
  const only = process.argv.slice(2);
  const wanted = only.length ? SUITES.filter((s) => only.some((o) => s.includes(o))) : SUITES;

  extractGame();
  console.log('extracted the game script to ' + GAME);

  // The relay now needs a token for /reload and for the remote roster. Tests
  // run on loopback, but /reload is token-gated regardless, so hand one out.
  process.env.TOKEN = process.env.TOKEN || 'test-token';

  let server = null;
  const needsServer = wanted.some((s) => s === 'relay.js' || s.startsWith('browser'));
  if (needsServer) {
    if (await healthy()) {
      console.log('using the relay already listening on ' + PORT);
    } else {
      server = spawn('bun', [path.join(DIR, '..', 'server.ts')], {
        env: Object.assign({}, process.env, { PORT: String(PORT), SEED: '20251008', HOST: '127.0.0.1' }),
        stdio: 'ignore',
      });
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { wait(250); up = await healthy(); }
      console.log(up ? 'relay started on ' + PORT : 'WARNING: the relay did not come up');
    }
  }

  const failed = [];
  for (const name of wanted) {
    const file = path.join(DIR, name);
    if (!fs.existsSync(file)) { console.log('\n--- ' + name + ': missing, skipped'); continue; }
    console.log('\n=== ' + name + ' ===');
    const r = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: DIR });
    if (r.status !== 0) failed.push(name);
  }

  if (server) { try { server.kill(); } catch (e) { /* already gone */ } }

  console.log('\n===============================');
  if (failed.length) {
    console.log('FAILED: ' + failed.join(', '));
    process.exit(1);
  }
  console.log('all suites passed');
})();
