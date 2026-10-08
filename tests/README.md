# Tests

Every suite runs the real `index.html` — nothing is mocked out except the DOM
and canvas, for the suites that run under node.

    node tests/run-all.js              # everything
    node tests/run-all.js harness      # just the ones matching "harness"
    node tests/harness.js              # a single suite

The runner extracts the script out of `index.html` into `.game.js`, starts
`server.js` on port 8099 with a fixed seed, then walks the suites in order:
the node ones first (fast, catch the logic), then the browser ones (slower, but
they drive real Chrome over the DevTools protocol and catch rendering, input and
layout).

| suite | what it covers |
|---|---|
| harness.js | world generation, physics, collision, damage, items, guns, the shop, spawning |
| harness-net.js | the multiplayer wire format, peer state, interpolation, bumps |
| input.js | the real keyboard listener path into the physics |
| render.js | the draw calls never receive NaN, at several sizes and pixel ratios |
| relay.js | server.js: joining, the roster, relaying state, fire, kills and the scoreboard |
| browser*.js | the page in real Chrome: day/night, items, destruction, nukes, streaks, the leaderboard, mobile controls and the shop |

Screenshots from the browser suites land in `tests/shots/`.
