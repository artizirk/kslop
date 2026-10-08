const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');
const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9244;
const SHOT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (n, c, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (!c && extra ? ' :: ' + extra : '')); if (!c) failures++; };
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu', '--mute-audio',
  '--hide-scrollbars', '--window-size=900,420', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' });
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
    let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});
  }).on('error', rej);
});
(async () => {
  for (let i=0;i<80;i++){try{await getJSON('/json/version');break;}catch{await sleep(250);}}
  const t=(await getJSON('/json/list')).find(x=>x.type==='page');
  const ws=new WebSocket(t.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
  await new Promise(r=>ws.once('open',r));
  const raw=wsSend(ws); let seq=0; const pend=new Map(); const errors=[];
  ws.on('message',(m)=>{const d=JSON.parse(m.toString());
    if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);}
    if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,(m)=>(m.error?rej(new Error(JSON.stringify(m.error))):res(m.result)));raw(JSON.stringify({id,method,params}));});
  const js=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const shot=async(n)=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(SHOT, n + '.png'),Buffer.from(r.data,'base64'));console.log('  wrote '+n+'.png');};
  const tap=async(x,y)=>{await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await sleep(60);await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(250);};
  const centre=async(sel)=>js(`(()=>{const b=document.querySelector('${sel}');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:900,height:420,deviceScaleFactor:2,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await send('Page.navigate',{url:`http://127.0.0.1:${RELAY}/?seed=20251008&audio=0`});
  await sleep(1900);

  console.log('\n== the shop opens ==');
  const btn = await centre('#touch .tbtn.shop');
  check('there is a shop button', !!btn && btn.w >= 60, JSON.stringify(btn));
  await tap(btn.x, btn.y);
  check('tapping it opens the shop', await js("!document.getElementById('shop').classList.contains('hidden')"));
  const rows = await js("[...document.querySelectorAll('#shopList .urow')].map(r => r.querySelector('.uname').textContent)");
  check('every upgrade is listed', rows.length >= 4, JSON.stringify(rows));
  console.log('  ' + rows.join(', '));
  await shot('48-shop-empty');

  console.log('\n== buying ==');
  await js('(() => { __game.car.money = 0; __game.renderShop(); return true; })()');
  const disabled = await js("[...document.querySelectorAll('#shopList button')].every(b => b.disabled)");
  check('nothing is buyable with an empty purse', disabled === true);

  await js('(() => { __game.car.money = 5000; __game.renderShop(); return true; })()');
  const enabled = await js("[...document.querySelectorAll('#shopList button')].some(b => !b.disabled)");
  check('with money the buttons come alive', enabled === true);
  await shot('49-shop-money');
  // and a shot with a few levels on the clock
  await js('(() => { __game.car.money = 9000; for (let i=0;i<7;i++) __game.buyUpgrade("engine"); for (let i=0;i<3;i++) __game.buyUpgrade("tyres"); __game.renderShop(); return true; })()');
  await sleep(200);
  await shot('50-shop-levels');

  const before = await js('({ money: __game.car.money, engine: __game.car.upgrades.engine, top: __game.topSpeedNow() })');
  // click the first buy button for real
  const buyBtn = await centre('#shopList button');
  await tap(buyBtn.x, buyBtn.y);
  const after = await js('({ money: __game.car.money, engine: __game.car.upgrades.engine, top: __game.topSpeedNow() })');
  check('the click buys an upgrade', after.engine === before.engine + 1, JSON.stringify(after));
  check('money was spent', after.money < before.money, before.money + ' -> ' + after.money);
  check('and the car got faster', after.top > before.top, before.top.toFixed(0) + ' -> ' + after.top.toFixed(0));

  // there is no ceiling: keep buying and the level keeps climbing
  await js('(() => { __game.car.money = 1000000; for (let i = 0; i < 25; i++) __game.buyUpgrade("engine"); __game.renderShop(); return true; })()');
  const deep = await js(`(() => {
    const row = [...document.querySelectorAll('#shopList .urow')][0];
    return { lvl: row.querySelector('.ulvl').textContent, label: row.querySelector('button').textContent,
             disabled: row.querySelector('button').disabled, level: __game.car.upgrades.engine };
  })()`);
  check('levels keep going past the old cap', deep.level > 5, 'level=' + deep.level);
  check('the row shows the level', /LV\s+\d+/.test(deep.lvl), deep.lvl);
  check('it never reads MAX', deep.label !== 'MAX', deep.label);
  check('and stays buyable', deep.disabled === false, JSON.stringify(deep));

  // the price keeps rising, so it is a real grind
  const costs = await js('(() => [__game.upgradeCost("engine", 0), __game.upgradeCost("engine", 10), __game.upgradeCost("engine", 100)])()');
  check('the price climbs with every level', costs[0] < costs[1] && costs[1] < costs[2], JSON.stringify(costs));
  check('and is always a real number', costs.every(c => Number.isFinite(c)), JSON.stringify(costs));

  console.log('\n== progress survives a reload ==');
  await js('(() => { __game.car.money = 777; __game.car.upgrades.tyres = 2; __game.saveProgress(); return true; })()');
  await send('Page.reload');
  await sleep(1900);
  const kept = await js('({ money: __game.car.money, tyres: __game.car.upgrades.tyres })');
  check('money comes back', kept.money === 777, 'money=' + kept.money);
  check('upgrades come back', kept.tyres === 2, 'tyres=' + kept.tyres);

  console.log('\n== resetting ==');
  await tap(btn.x, btn.y);
  const resetBtn = await centre('#shopReset');
  await tap(resetBtn.x, resetBtn.y);
  const fresh = await js('({ money: __game.car.money, engine: __game.car.upgrades.engine })');
  check('reset clears the money', fresh.money === 0, 'money=' + fresh.money);
  check('and the upgrades', fresh.engine === 0, 'engine=' + fresh.engine);

  console.log('\n== the shop closes ==');
  const closeBtn = await centre('#shopClose');
  await tap(closeBtn.x, closeBtn.y);
  check('the close button shuts the shop', await js("document.getElementById('shop').classList.contains('hidden')"));
  await tap(btn.x, btn.y);
  check('and it reopens', await js("!document.getElementById('shop').classList.contains('hidden')"));
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))");
  await sleep(200);
  check('B toggles it too', await js("document.getElementById('shop').classList.contains('hidden')"));

  console.log('\n== errors ==');
  check('no page errors', errors.filter(e=>!/favicon/.test(e)).length === 0, errors.join(' | ').slice(0,200));
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  ws.close(); chrome.kill(); process.exit(failures === 0 ? 0 : 1);
})().catch(e=>{console.error('HARNESS ERROR: '+e.message);chrome.kill();process.exit(1);});
