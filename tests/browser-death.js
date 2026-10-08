const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('./ws');
const wsSend = (ws) => WebSocket.prototype.send.bind(ws);
const RELAY = Number(process.env.RELAY_PORT || 8099);
const CDP = 9243;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu', '--mute-audio',
  '--hide-scrollbars', '--window-size=900,420', ('--user-data-dir=' + path.join(__dirname, 'chrome-profile')),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' });
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
(async () => {
  for (let i = 0; i < 80; i++) { try { await getJSON('/json/version'); break; } catch { await sleep(250); } }
  const t = (await getJSON('/json/list')).find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256*1024*1024 });
  await new Promise(r => ws.once('open', r));
  const raw = wsSend(ws);
  let seq=0; const pend=new Map();
  ws.on('message', (m)=>{ const d=JSON.parse(m.toString()); if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id);} });
  const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,(m)=>(m.error?rej(new Error(JSON.stringify(m.error))):res(m.result)));raw(JSON.stringify({id,method,params}));});
  const js=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:900,height:420,deviceScaleFactor:2,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await send('Page.navigate',{url:`http://127.0.0.1:${RELAY}/?seed=20251008&audio=0`});
  await sleep(1900);
  await js(`(() => { const g = window.__game; g.car.wreckTimer = g.WRECK_TIME - 1.0; g.car.lastHitBy = 42; return true; })()`);
  await sleep(150);
  const r = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('47-death-mobile.png', Buffer.from(r.data,'base64'));
  const info = await js(`(() => { const W = window.innerWidth, H = window.innerHeight;
    const size = Math.round(Math.min(W, H) * 0.17);
    return { W, H, size, widthFrac: (size * 0.62 * 6) / W }; })()`);
  console.log('viewport', info.W + 'x' + info.H, 'font', info.size + 'px', 'estimated text width fraction', info.widthFrac.toFixed(2));
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error(e.message);chrome.kill();process.exit(1);});
