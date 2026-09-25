// Local-only spectator fixture server. No credentials, external requests or writes.
// node workers/musebook/tests/viewer-mock.mjs → http://127.0.0.1:4178/
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
const base = new URL('../../../public/casino/', import.meta.url);
const sha = s => createHash('sha256').update(s).digest('hex');
const started = Math.floor(Date.now()/1000);
let stage = 0, offline = false;
const fees = {dice:10,slots:20,crash:25,coin:15};
const fixtures = {};
for (const [kind,fee] of Object.entries(fees)) {
 const id = `${kind}:900`, seed = '04'.repeat(32);
 const manifest = ['1','2','3','4'].map((s,i)=>[s.repeat(32),kind==='coin'?[2,3,2,3][i]:kind==='crash'?[2,3,5,10][i]:0,'ab'.repeat(32)]);
 const hash = sha(JSON.stringify(manifest));
 const mac = (account,label,counter=0)=>createHmac('sha256',Buffer.from(seed,'hex')).update(JSON.stringify(['musebook-casino-v1',id,hash,account,label,counter])).digest();
 const outcomes = manifest.map(([account,choice],i)=>{
  let score, result;
  if(kind==='coin') {const bit=mac('','coin/flip')[0]&1;score=choice===bit+2?1:0;result={side:bit===0?'HEADS':'TAILS',choice:choice===2?'HEADS':'TAILS'};}
  else if(kind==='crash') {const cents=Math.min(10000,Math.floor(100*4294967296/(mac('','crash/point').readUInt32BE()+1)));score=choice*100<=cents?choice:0;result={crash_cents:cents,target:choice};}
  else {let counter=0;const values=Array.from({length:kind==='dice'?6:3},(_,n)=>{let x;do{x=mac(account,`${kind}/${n}`,counter++).readUInt32BE();}while(x>=4294967292);return x%6+1;});
   if(kind==='dice'){score=values.reduce((a,b)=>a+b,0);result={dice:values};}
   else{const counts=values.map(v=>values.filter(x=>x===v).length),cat=Math.max(...counts);score=cat*100+Math.max(...values.filter((_,i)=>counts[i]===cat));result={reels:values};}}
  return {entry_id:`entry-${i}`,account_id:account,result,score,payout:0};
 });
 const best=Math.max(...outcomes.map(o=>o.score));
 const winners=outcomes.filter(o=>o.score===best).sort((a,b)=>Buffer.compare(mac(a.account_id,'tie'),mac(b.account_id,'tie')));
 winners.forEach((o,i)=>o.payout=Math.floor(fee*4/winners.length)+(i<fee*4%winners.length?1:0));
 const refund=kind==='crash'&&best===0;if(refund)outcomes.forEach(o=>o.payout=fee);
 const game={id,kind,rules_version:2,opens_at:started-60,closes_at:started+86400,effective_close_at:started+120,entry_fee:fee,max_entries:256,entry_count:4,pot:fee*4,state:'settled',commitment:sha(JSON.stringify(['musebook-casino-v1',id,kind,2,fee,256,seed]))};
 fixtures[id]={game,mode:refund?'refund':'normal',seed_reveal:seed,manifest_hash:hash,manifest,pot:fee*4,outcomes};
}
function games(){return Object.values(fixtures).flatMap(({game})=>{
 const count=stage===0?(game.kind==='dice'?2:1):4;
 const g={...game,server_time:Math.floor(Date.now()/1000),state:stage>=4?'settled':stage===3?'closed':'open',entry_count:count,pot:count*game.entry_fee,effective_close_at:stage>=2?started-1:started+120};
 return stage>=4?[g,{...g,id:game.kind+':901',state:'open',opens_at:started,closes_at:started+86400,effective_close_at:started+86400,entry_count:0,pot:0}]:[g];
});}
export async function handle(req,res) {
 const url=new URL(req.url,'http://localhost');
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(url.pathname==='/__viewer/control') {if(url.searchParams.has('stage'))stage=Number(url.searchParams.get('stage'));if(url.searchParams.has('offline'))offline=url.searchParams.get('offline')==='1';return json({stage,offline});}
 if(url.pathname.startsWith('/api/casino/')) {
  if(offline)return json({error:'temporarily_unavailable'},503);
  const p=url.pathname.slice('/api/casino'.length);
  if(p==='/games')return json({server_time:Math.floor(Date.now()/1000),items:games().filter(g=>g.state===url.searchParams.get('state')),next_cursor:null});
  const match=p.match(/^\/games\/([^/]+)(\/results)?$/);
  if(match){const id=decodeURIComponent(match[1]),game=games().find(g=>g.id===id);if(!game)return json({error:'not_found'},404);if(match[2])return stage>=4&&fixtures[id]?json({...fixtures[id],game}):json({error:'not_settled'},409);return json({game});}
  return json({error:'not_available_in_spectator_mock'},404);
 }
 if(url.pathname==='/') {res.setHeader('Content-Type','text/html');return res.end(`<title>Local viewer controls</title><h1>Casino viewer fixture controls</h1><p>Open <a href="/casino/" target="viewer">the local casino</a>, then use these controls. Its normal 10-second poll applies.</p>${['Initial seats','More seats','Deadline passed','Server closed','Paid out & successor'].map((s,i)=>`<button onclick="fetch('/__viewer/control?stage=${i}')">${s}</button>`).join(' ')}<p><button onclick="fetch('/__viewer/control?offline=1')">Disconnect API</button> <button onclick="fetch('/__viewer/control?offline=0')">Reconnect API</button></p><p>Fixtures are anonymous, matching Pass 1. Proofs are cryptographically valid.</p>`);}
 try {
  const file=url.pathname==='/casino/'?'index.html':url.pathname.replace('/casino/','');
  if(!['index.html','app.js','style.css','viewer.js','fairness.js','renders.js','renders.css'].includes(file))return json({},404);
  let body=await readFile(new URL(file,base),'utf8');
  if(file==='app.js')body=body.replace('https://musebook-api.gurmehar.workers.dev/api/casino','/api/casino');
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
 }catch{json({},404);}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer(handle).listen(4178,'127.0.0.1',()=>console.log('Viewer fixtures: http://127.0.0.1:4178/ (controls), /casino/ (site)'));
