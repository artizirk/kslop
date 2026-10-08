# Tests

Every suite runs the real `index.html` — nothing is mocked out except the DOM
and canvas, for the suites that run under node.

    node tests/run-all.js              # everything
    node tests/run-all.js harness      # just the ones matching "harness"
    node tests/harness.js              # a single suite

The runner extracts the script out of `index.html` into `.game.js`, starts
`server.ts` with `bun` on port 8099 with a fixed seed, then walks the suites in
order: the node ones first (fast, catch the logic), then the browser ones
(slower, but they drive real Chrome over the DevTools protocol and catch
rendering, input and layout). Bun must be on your `PATH`.

| suite | what it covers |
|---|---|
| harness.js | world generation, physics, collision, damage, items, guns, the shop, spawning |
| harness-net.js | the multiplayer wire format, peer state, interpolation, bumps |
| input.js | the real keyboard listener path into the physics |
| render.js | the draw calls never receive NaN, at several sizes and pixel ratios |
| relay.js | the Bun relay: joining, the roster, relaying state, fire, kills and the scoreboard |
| audit.js | the relay under attack: malformed URLs and paths, framing, floods, connection and address limits, forged kills, the reload token, and that no file but the page is reachable |
| browser*.js | the page in real Chrome: day/night, items, destruction, nukes, streaks, the leaderboard, mobile controls and the shop |

`audit.js` is a security audit, not a game test. Each probe starts a throwaway
relay on its own port (8300+) and tries to break it, then reports what the server
survived. It does not use the 8099 relay, so it can run on its own:

    node tests/audit.js

Screenshots from the browser suites land in `tests/shots/`.
