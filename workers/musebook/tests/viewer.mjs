// DOM integration against the static site's local fixture handler.
// JSDOM_PATH=/path/to/jsdom/lib/api.js node workers/musebook/tests/viewer.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { handle } from './viewer-mock.mjs';
import { createViewer } from '../../../public/casino/viewer.js';
import { createGameRenderer, coinMotion, ascentPath } from '../../../public/casino/renders.js';
import { verify } from '../../../public/casino/fairness.js';
const { JSDOM } = await import(process.env.JSDOM_PATH ? pathToFileURL(process.env.JSDOM_PATH).href : 'jsdom');
const dom = new JSDOM('<main id="main"></main>',{url:'http://localhost/casino/',pretendToBeVisual:true});
globalThis.document = dom.window.document;
globalThis.matchMedia = () => ({matches:true}); // reduced motion; no layout engine
const main = document.querySelector('main');
async function request(url) {
 let body, status=200; await handle({url}, {setHeader(){},writeHead(s){status=s;},end(b){body=b;}});
 return {body,status};
}
const control = query => request('/__viewer/control?'+query);
const api = async path => {const r=await request('/api/casino'+path);if(r.status!==200)throw Error('offline');return JSON.parse(r.body);};
let version=1, clock=Date.now()/1000;
const viewer=createViewer({api,main,nowSeconds:()=>clock,die:n=>`<span class="die">${n}</span>`,isCurrent:v=>v===version});
let load=await viewer.start(version);await load();
assert.equal(main.querySelectorAll('.floor-card').length,4);
assert.match(main.querySelector('#watch').href,/dice%3A900/);
assert.equal(main.querySelectorAll('.seat:not(.open-seat)').length,2);
assert(!main.querySelector('.proof-drawer').open);
assert.equal(main.querySelector('#viewer-pot').textContent,'20');
const originalFeed=main.querySelector('#table-feed').children.length;
await load();assert.equal(main.querySelector('#table-feed').children.length,originalFeed);
await control('stage=1');await load();
assert.equal(main.querySelectorAll('.seat:not(.open-seat)').length,4);
assert.match(main.querySelector('#table-feed').textContent,/2 muses joined the table/);
assert.equal(main.querySelector('#viewer-pot').textContent,'40');
await control('stage=2');await load();
assert.equal(main.querySelector('.felt').dataset.phase,'locked');
assert.match(main.querySelector('#round-next').textContent,/server/);
await control('stage=3');await load();assert.equal(main.querySelector('.felt').dataset.phase,'settling');
await control('offline=1');await load();
assert.match(main.querySelector('#viewer-connection').textContent,/last confirmed/);
assert.equal(main.querySelector('#viewer-pot').textContent,'40');
await control('offline=0&stage=4');await load();
assert.equal(main.querySelector('.felt').dataset.phase,'paid out');
assert.equal(main.querySelectorAll('.result-seat').length,4);
assert.match(main.querySelector('#round-announcement').textContent,/Round settled/);
await main.querySelector('#verify').onclick({currentTarget:main.querySelector('#verify')});
assert.match(main.querySelector('#verification').textContent,/All checks passed/);
main.querySelector('.proof-drawer').open=true;
await load();assert(main.querySelector('.proof-drawer').open);
assert.match(main.querySelector('#verification').textContent,/All checks passed/);
assert.match(main.querySelector('#next-round a').href,/dice%3A901/);
clock+=21;await load();assert.equal(main.querySelectorAll('.open-seat').length,1);
assert.equal(main.querySelector('#viewer-pot').textContent,'0');
for(const kind of ['dice','slots','crash','coin']) {
 version++;load=await viewer.start(version,kind+':900');await load();
 assert.equal(main.querySelectorAll('.result-seat').length,4);
 assert(!main.querySelector('.proof-drawer').open);
 const proof=await api('/games/'+kind+':900/results');
 assert((await verify(proof,kind+':900')).every(c=>c.ok));
 proof.outcomes[0].payout++;
 assert((await verify(proof,kind+':900')).some(c=>!c.ok));
 // Technical identifiers are permitted only within the collapsed proof.
 const clone=main.cloneNode(true);clone.querySelector('.proof-drawer').remove();
 assert(!/[a-f0-9]{32}/.test(clone.textContent));
 assert(!/undefined|NaN/.test(clone.textContent));
}
// Browser animations are captured, so completion and slow motion can be tested
// without substituting a random outcome or needing a layout engine.
let animations=[];
dom.window.Element.prototype.animate=function(frames,timing){
 let finish;
 const finished=new Promise(resolve=>{finish=resolve;});
 const a={frames,timing,finished,rate:1,cancel(){finish();},finish,
  updatePlaybackRate(rate){this.rate=rate;},effect:{updateTiming(){}}};
 animations.push(a);return a;
};
await control('stage=1');version++;load=await viewer.start(version,'dice:900');await load();
globalThis.matchMedia=()=>({matches:false});
await control('stage=4');await load();
assert.equal(main.querySelector('.felt').dataset.phase,'rolling');
assert.equal(main.querySelectorAll('#reveal-art .pip-cube').length,6);
animations.forEach(a=>a.finish());await new Promise(r=>setImmediate(r));
assert.equal(main.querySelector('.felt').dataset.phase,'paid out');
const seen=animations.length;
await load();assert.equal(animations.length,seen,'polls do not replay');
for(const kind of ['coin','dice','slots','crash']){
 version++;load=await viewer.start(version,kind+':900');await load();
 assert.match(main.querySelector('.render-topline').textContent,/VERIFIED REPLAY/);
 animations=[];
 main.querySelector('[data-replay]').click();
 assert(animations.length>0,kind+' animates');
 main.querySelector('[data-slow]').click();
 assert(animations.every(a=>a.rate===.3));
 const stage=main.querySelector('.game-stage');
 if(kind==='coin'){
  assert.equal(stage.querySelectorAll('.coin-face').length,2);
  const proof=await api('/games/coin:900/results');
  const expected=coinMotion(proof.seed_reveal,proof.outcomes[0].result.side);
  assert.deepEqual(animations[0].frames,expected);
  assert.deepEqual(coinMotion(proof.seed_reveal,proof.outcomes[0].result.side),expected);
 } else if(kind==='dice'){
  assert.equal(stage.querySelectorAll('.pip-cube').length,6);
  assert.equal(main.querySelectorAll('[data-draw] option').length,4);
  const select=main.querySelector('[data-draw]');select.value='1';
  select.dispatchEvent(new dom.window.Event('change'));
  assert.match(main.querySelector('.render-caption').textContent,/Seat 2/);
 } else if(kind==='slots'){
  assert.equal(stage.querySelectorAll('.symbol-strip').length,3);
  assert(animations[0].timing.duration<animations[1].timing.duration);
 } else {
  const proof=await api('/games/crash:900/results');
  assert.equal(stage.querySelector('.ascent-curve').getAttribute('d'),ascentPath(proof.outcomes[0].result.crash_cents).path);
 }
 animations.forEach(a=>a.finish());await new Promise(r=>setImmediate(r));
 // Tampering must block playback automatically, without opening the drawer.
 const proof=await api('/games/'+kind+':900/results');proof.outcomes[0].payout++;
 const root=document.createElement('div');main.append(root);
 const renderer=createGameRenderer(root);
 await renderer.show(proof.game,proof,{autoplay:true});
 assert.match(root.textContent,/verification failed/);assert(!root.querySelector('[data-replay]'));
 renderer.destroy();root.remove();
}
// Reduced motion still renders the exact final faces, with no animations.
globalThis.matchMedia=()=>({matches:true});
version++;load=await viewer.start(version,'coin:900');await load();
animations=[];main.querySelector('[data-replay]').click();assert.equal(animations.length,0);
assert(main.querySelector('.landed-side'));
assert.equal(main.querySelector('.felt').dataset.phase,'paid out');
// In-flight navigation cannot write a previous route's snapshot into a new one.
version++;const resolvers=[];
const slow=createViewer({api:()=>new Promise(r=>resolvers.push(r)),main,nowSeconds:()=>clock,die:()=>'',isCurrent:v=>v===version});
const stale=await slow.start(version);const pending=stale();version++;main.innerHTML='new route';
resolvers.forEach(resolve=>resolve({items:[]}));await pending;
assert.equal(main.textContent,'new route');
const served=await request('/casino/app.js');assert(served.body.includes("const API = '/api/casino'"));
assert((await request('/casino/viewer.js')).body.includes('createViewer'));
assert((await request('/casino/renders.js')).body.includes('createGameRenderer'));
assert((await request('/casino/renders.css')).body.includes('.club-coin'));
assert((await request('/casino/index.html')).body.includes('./renders.css'));
viewer.stop();
console.log('PASS: static mock serving, 4-table floor, seat/pot deltas, deduplicated feed, deadline/closed/paid states, stale recovery, successor, retained proof drawer, all 4 proofs and tampering, no spectator hashes. verified game renders, slow motion, replay and reduced motion. DOM-only; no visual layout claim.');
