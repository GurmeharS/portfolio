// Run: node workers/musebook/tests/multigame.mjs (Node 24+, no added dependencies).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { verify } from '../../../public/casino/fairness.js';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source+'\nexport {casinoAdvance,settleRound,provisionRollingRound,diceCommitment,sealSeed,gameDraws};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const w=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
let now=1900000000;
Date.now=()=>now*1000;
const sql=new DatabaseSync(':memory:');
sql.exec('PRAGMA foreign_keys=ON; CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,created_at INTEGER,expires_at INTEGER);');
sql.function('unixepoch',()=>now);
for(const file of ['0004_casino.sql','0005_rolling.sql','0006_rolling_guards.sql','0007_relax_game_constraints.sql']) sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
class Statement {
 constructor(query,args=[]){this.query=query;this.args=args;}
 bind(...args){return new Statement(this.query,args);}
 async first(){return sql.prepare(this.query).get(...this.args)??null;}
 async all(){return {results:sql.prepare(this.query).all(...this.args)};}
 async run(){const r=sql.prepare(this.query).run(...this.args);return {meta:{changes:Number(r.changes)}};}
}
const db={prepare:q=>new Statement(q),async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements){const r=sql.prepare(s.query).run(...s.args);out.push({meta:{changes:Number(r.changes)}});}sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const env={MUSEBOOK_DB:db,CASINO_SEED_KEY:'a'.repeat(64)};
const sha=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
const accounts=['1','2','3'].map(x=>x.repeat(32));
for(const [i,id] of accounts.entries()){
 sql.prepare("INSERT INTO casino_accounts(id,kind,handle,created_at) VALUES (?,'muse',?,?)").run(id,'muse_'+i,now);
 sql.prepare("INSERT INTO casino_ledger(id,kind,dst,amount,created_at) VALUES (?,'mint',?,500,?)").run('grant:'+id,id,now);
 const hash=await sha('local-test-session-'+i);
 sql.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash,now*1000,(now+864000)*1000);
 sql.prepare('INSERT INTO casino_sessions VALUES (?,?,1)').run(hash,id);
}
// Exercise legacy v1 settlement and populated migration preservation.
const seed=new Uint8Array(32).fill(4), seedHex=Buffer.from(seed).toString('hex');
const legacy='dice:test-legacy', opens=now-100, closes=now+86300;
const sealed=await w.sealSeed(env.CASINO_SEED_KEY,seed,legacy);
const commitment=await w.diceCommitment(legacy,1,opens,closes,10,seedHex);
sql.prepare("INSERT INTO casino_accounts(id,kind,created_at) VALUES (?,'escrow',?)").run('escrow:'+legacy,now-4000);
sql.prepare("INSERT INTO casino_games(id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,commitment,seed_box) VALUES (?,'dice',1,?,?,?,?,10,?,?)").run(legacy,'escrow:'+legacy,opens,closes,now-4000,commitment,JSON.stringify({kid:'v1',...sealed}));
async function request(path,method='GET',body,i=0){const res=await w.default.fetch(new Request('https://local/api/casino'+path,{method,headers:{Origin:'https://gurmehar.ca',Authorization:'Bearer local-test-session-'+i,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);return {status:res.status,body:await res.json()};}
let sequence=0;
const entryBody=choice=>({request_id:'local_request_'+String(++sequence).padStart(8,'0'),nonce:'b'.repeat(64),choice});
async function enter(id,i,choice=0){const body=entryBody(choice);const res=await request('/games/'+id+'/entries','POST',body,i);assert.equal(res.status,201,JSON.stringify(res));return body;}
await enter(legacy,0);await enter(legacy,1);
// Before 0008, worker relies on trigger for acceleration, so set legacy fixture explicitly.
sql.prepare('UPDATE casino_games SET accelerated_close_at=? WHERE id=?').run(now+120,legacy);
now+=120;await w.casinoAdvance(db,env,now);
const legacyProof=(await request('/games/'+legacy+'/results')).body;
assert((await verify(legacyProof,legacy)).every(c=>c.ok));
const tables=['casino_accounts','casino_entries','casino_resolutions','casino_outcomes','casino_ledger'];
const before=tables.map(t=>JSON.stringify(sql.prepare('SELECT * FROM '+t).all()));
sql.exec(readFileSync(new URL('../migrations/0008_parallel_tables.sql',import.meta.url),'utf8'));
assert.deepEqual(tables.map(t=>JSON.stringify(sql.prepare('SELECT * FROM '+t).all())),before);
assert.equal(sql.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
// 0009 must preserve populated games, child rows, balances, audit and requests.
const preserve=['casino_games',...tables,'casino_audit','casino_requests'];
const triggerNames=()=>sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(t=>t.name);
const originalTriggers=triggerNames();
const snapshot=preserve.map(t=>JSON.stringify(sql.prepare('SELECT * FROM '+t).all()));
sql.exec('BEGIN');
try { sql.exec(readFileSync(new URL('../migrations/0009_coin.sql',import.meta.url),'utf8')); sql.exec('COMMIT'); }
catch(e) {sql.exec('ROLLBACK');throw e;}
assert.deepEqual(triggerNames(),originalTriggers);
assert.deepEqual(preserve.map(t=>JSON.stringify(sql.prepare('SELECT * FROM '+t).all())),snapshot);
assert.equal(sql.prepare('PRAGMA foreign_key_check').all().length,0);
await Promise.all([w.casinoAdvance(db,env,now),w.casinoAdvance(db,env,now)]);
const live=sql.prepare("SELECT * FROM casino_games WHERE state='open' AND opens_at<=? AND id NOT LIKE '%test%'").all(now);
assert.equal(live.length,4);
for(const g of live){
 assert.match(g.id,new RegExp('^'+g.kind+':\\d+$'));
 const body=await enter(g.id,0,g.kind==='coin'?2:g.kind==='crash'?2:0);
 assert.equal((await request('/games/'+g.id+'/entries','POST',body,0)).status,201,'idempotent entry replay');
 assert.equal((await request('/games/'+g.id+'/entries','POST',{...body,choice:g.kind==='coin'?3:g.kind==='crash'?3:2},0)).status,409,'payload conflict');
 await enter(g.id,1,g.kind==='coin'?3:g.kind==='crash'?10:0);
 if(g.kind==='coin')assert.throws(()=>sql.prepare('INSERT INTO casino_entries VALUES (?,?,?,?,?,?)').run('invalid-coin-choice',g.id,accounts[2],0,'c'.repeat(64),now),/entry_rejected/);
 assert.equal(sql.prepare('SELECT accelerated_close_at FROM casino_games WHERE id=?').get(g.id).accelerated_close_at,now+120);
 assert.equal((await request('/games/'+g.id+'/entries','POST',entryBody(g.kind==='coin'?0:g.kind==='crash'?0:2),2)).status,409);
}
// At the exact effective close, HTTP and the database both refuse entry.
now+=120;
for(const g of live){
 assert.equal((await request('/games/'+g.id+'/entries','POST',entryBody(g.kind==='crash'?3:0),2)).status,409);
 assert.throws(()=>sql.prepare('INSERT INTO casino_entries VALUES (?,?,?,?,?,?)').run('late:'+g.id,g.id,accounts[2],g.kind==='crash'?3:0,'c'.repeat(64),now),/entry_rejected/);
}
await Promise.all([w.casinoAdvance(db,env,now),w.casinoAdvance(db,env,now)]);
for(const g of live){
 const result=await request('/games/'+g.id+'/results');assert.equal(result.status,200);
 const checks=await verify(result.body,g.id);assert(checks.every(c=>c.ok),JSON.stringify(checks));
 const bad=structuredClone(result.body);bad.outcomes[0].payout++;assert((await verify(bad,g.id)).some(c=>!c.ok));
 const badSeed=structuredClone(result.body);badSeed.seed_reveal='0'.repeat(64);assert((await verify(badSeed,g.id)).some(c=>!c.ok));
 assert.equal(sql.prepare('SELECT balance FROM casino_balances WHERE account_id=?').get(g.escrow_id).balance,0);
 const count=sql.prepare("SELECT COUNT(*) n FROM casino_ledger WHERE game_id=? AND kind='payout'").get(g.id).n;
 await w.settleRound(db,env,g.id,now);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM casino_ledger WHERE game_id=? AND kind='payout'").get(g.id).n,count);
}
assert.equal(sql.prepare("SELECT COUNT(*) n FROM casino_games WHERE state='open' AND opens_at<=? AND id NOT LIKE '%test%'").get(now).n,4);
// Empty and singleton refunds for every game, and floor rollback.
now++;
for(const kind of ['dice','slots','crash','coin']){
 const active=sql.prepare("SELECT * FROM casino_games WHERE kind=? AND state='open' AND opens_at<=?").get(kind,now);
 await enter(active.id,2,kind==='coin'?2:kind==='crash'?5:0);
}
now+=86400;await w.casinoAdvance(db,env,now);
const refunds=sql.prepare("SELECT game_id FROM casino_resolutions WHERE mode='refund'").all();
for(const r of refunds)assert((await verify((await request('/games/'+r.game_id+'/results')).body,r.game_id)).every(c=>c.ok));
// Every empty table settles and reveals too.
now+=86400;await w.casinoAdvance(db,env,now);
for(const r of sql.prepare('SELECT game_id FROM casino_resolutions WHERE entry_count=0').all())
 assert((await verify((await request('/games/'+r.game_id+'/results')).body,r.game_id)).every(c=>c.ok));
// Deterministic shared crash point below 2x: every target busts, everyone refunded.
now++;
const bustId='crash:test-bust';
const mh=await sha(JSON.stringify(accounts.slice(0,2).map((id,i)=>[id,i===0?2:10,'b'.repeat(64)])));
let bustSeed;
for(let i=0;i<256;i++){
 const candidate=new Uint8Array(32).fill(i);
 if((await w.gameDraws(candidate,bustId,mh,accounts[0],'crash',2)).score===0){bustSeed=candidate;break;}
}
assert(bustSeed);
const box=await w.sealSeed(env.CASINO_SEED_KEY,bustSeed,bustId);
sql.prepare("INSERT INTO casino_accounts(id,kind,created_at) VALUES (?,'escrow',?)").run('escrow:'+bustId,now);
sql.prepare("INSERT INTO casino_games(id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,commitment,seed_box) VALUES (?,'crash',2,?,?,?,?,25,?,?)").run(bustId,'escrow:'+bustId,now,now+86400,now,await w.diceCommitment(bustId,2,now,now+86400,25,Buffer.from(bustSeed).toString('hex'),'crash'),JSON.stringify({kid:'v1',...box}));
await enter(bustId,0,2);await enter(bustId,1,10);
assert.throws(()=>sql.prepare('UPDATE casino_games SET accelerated_close_at=? WHERE id=?').run(now+121,bustId),/invalid_acceleration/);
now+=120;await w.default.scheduled({},env,{});
const bustProof=(await request('/games/'+bustId+'/results')).body;
assert.equal(bustProof.mode,'refund');assert(bustProof.outcomes.every(o=>o.payout===25 && o.score===0));
assert((await verify(bustProof,bustId)).every(c=>c.ok));
// Floor: synthetic committed bets under immediate foreign keys, in one open test round each.
for(let i=0;i<40;i++){
 now+=61;
 const id='dice:test-floor-'+i;
 const box=await w.sealSeed(env.CASINO_SEED_KEY,seed,id);
 sql.prepare("INSERT INTO casino_accounts(id,kind,created_at) VALUES (?,'escrow',?)").run('escrow:'+id,now);
 sql.prepare("INSERT INTO casino_games(id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,commitment,seed_box) VALUES (?,'dice',2,?,?,?,?,10,?,?)").run(id,'escrow:'+id,now,now+86400,now,await w.diceCommitment(id,2,now,now+86400,10,seedHex),JSON.stringify({kid:'v1',...box}));
 now++;
 await enter(id,2);
}
assert.equal(sql.prepare('SELECT balance FROM casino_balances WHERE account_id=?').get(accounts[2]).balance,100);
const next=sql.prepare("SELECT id FROM casino_games WHERE kind='slots' AND state='open' AND opens_at<=?").get(now);
assert.equal((await request('/games/'+next.id+'/entries','POST',entryBody(0),2)).status,409);
// Bypass HTTP: the floor still aborts the complete entry/bet transaction.
const floorEntry='floor-rejected';
await assert.rejects(db.batch([
 db.prepare('INSERT INTO casino_entries VALUES (?,?,?,?,?,?)').bind(floorEntry,next.id,accounts[2],0,'c'.repeat(64),now),
 db.prepare("INSERT INTO casino_ledger(id,kind,src,dst,amount,game_id,entry_id,created_at) SELECT ?, 'bet', ?, escrow_id,entry_fee,id,?,? FROM casino_games WHERE id=?").bind('bet:'+floorEntry,accounts[2],floorEntry,now,next.id)
]),/bankroll_floor/);
assert.equal(sql.prepare('SELECT COUNT(*) n FROM casino_entries WHERE id=?').get(floorEntry).n,0);

// Controlled coin fixtures: both sides, exact split, odd remainder, empty side,
// singleton and empty refund, plus immutable choices and tampered shared draws.
const extra='4'.repeat(32);
accounts.push(extra);
sql.prepare("INSERT INTO casino_accounts(id,kind,handle,created_at) VALUES (?,'muse','coin_guest',?)").run(extra,now);
sql.prepare("INSERT INTO casino_ledger(id,kind,dst,amount,created_at) VALUES ('grant:coin_guest','mint',?,500,?)").run(extra,now);
const extraHash=await sha('local-test-session-3');
sql.prepare('INSERT INTO sessions VALUES (?,?,?)').run(extraHash,now*1000,(now+864000)*1000);
sql.prepare('INSERT INTO casino_sessions VALUES (?,?,1)').run(extraHash,extra);
for(const [label,players,choices,bit] of [
 ['both',[0,1],[2,3],0], ['tie',[0,1,3],[2,2,3],0],
 ['one-side',[0,1],[2,2],1], ['solo',[0],[3],0], ['empty',[],[],1]
]){
 now+=61;
 const id='coin:test-'+label;
 const manifest=players.map((p,i)=>[accounts[p],choices[i],'b'.repeat(64)]).sort((a,b)=>a[0].localeCompare(b[0]));
 const hash=await sha(JSON.stringify(manifest));
 let chosen;
 for(let n=0;n<256;n++){
  const candidate=new Uint8Array(32).fill(n);
  const draw=await w.gameDraws(candidate,id,hash,accounts[0],'coin',2);
  if(draw.result.side===(bit===0?'HEADS':'TAILS')){chosen=candidate;break;}
 }
 assert(chosen);
 const sealed=await w.sealSeed(env.CASINO_SEED_KEY,chosen,id);
 sql.prepare("INSERT INTO casino_accounts(id,kind,created_at) VALUES (?,'escrow',?)").run('escrow:'+id,now);
 sql.prepare("INSERT INTO casino_games(id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,commitment,seed_box) VALUES (?,'coin',2,?,?,?,?,15,?,?)").run(id,'escrow:'+id,now,now+120,now,await w.diceCommitment(id,2,now,now+120,15,Buffer.from(chosen).toString('hex'),'coin'),JSON.stringify({kid:'v1',...sealed}));
 for(let i=0;i<players.length;i++)await enter(id,players[i],choices[i]);
 if(players.length){
  assert.equal((await request('/games/'+id+'/entries','POST',entryBody(choices[0]===2?3:2),players[0])).status,409);
  assert.throws(()=>sql.prepare('UPDATE casino_entries SET choice=3 WHERE game_id=?').run(id),/immutable/);
 }
 now+=120;await w.casinoAdvance(db,env,now);
 const result=(await request('/games/'+id+'/results')).body;
 assert((await verify(result,id)).every(c=>c.ok),JSON.stringify(result));
 assert.equal(result.mode,label==='empty'?'refund':'normal');
 assert.equal(result.outcomes.reduce((n,o)=>n+o.payout,0),players.length*15);
 assert(result.outcomes.every(o=>o.result.side===(bit===0?'HEADS':'TAILS')));
 if(label==='both')assert.deepEqual(result.outcomes.map(o=>o.payout).sort((a,b)=>a-b),[0,30]);
 if(label==='tie')assert.deepEqual(result.outcomes.map(o=>o.payout).sort((a,b)=>a-b),[0,22,23]);
 if(label==='one-side')assert(result.outcomes.every(o=>o.payout===15 && o.score===0));
 if(label==='solo')assert.equal(result.outcomes[0].payout,15);
 if(players.length){
  const bad=structuredClone(result);bad.outcomes[0].result.side=bit===0?'TAILS':'HEADS';
  assert((await verify(bad,id)).some(c=>!c.ok));
  const choiceBad=structuredClone(result);choiceBad.manifest[0][1]=10;
  assert((await verify(choiceBad,id)).some(c=>!c.ok));
 }
 const ledger=JSON.stringify(sql.prepare('SELECT * FROM casino_ledger WHERE game_id=?').all(id));
 await w.settleRound(db,env,id,now);
 assert.equal(JSON.stringify(sql.prepare('SELECT * FROM casino_ledger WHERE game_id=?').all(id)),ledger);
 assert.equal(sql.prepare('SELECT balance FROM casino_balances WHERE account_id=?').get('escrow:'+id).balance,0);
}

// The server freezes a mismatched sealed seed/commitment; it never rerolls.
now+=61;
const tamperId='coin:test-bad-commitment';
const tamperBox=await w.sealSeed(env.CASINO_SEED_KEY,seed,tamperId);
sql.prepare("INSERT INTO casino_accounts(id,kind,created_at) VALUES (?,'escrow',?)").run('escrow:'+tamperId,now);
sql.prepare("INSERT INTO casino_games(id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,commitment,seed_box) VALUES (?,'coin',2,?,?,?,?,15,?,?)").run(tamperId,'escrow:'+tamperId,now,now+120,now,'f'.repeat(64),JSON.stringify({kid:'v1',...tamperBox}));
now+=120;
sql.prepare("UPDATE casino_games SET state='closed' WHERE id=?").run(tamperId);
await assert.rejects(w.settleRound(db,env,tamperId,now),/commitment_mismatch/);
assert.equal(sql.prepare('SELECT state FROM casino_games WHERE id=?').get(tamperId).state,'closed');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM casino_resolutions WHERE game_id=?').get(tamperId).n,0);
assert.equal(sql.prepare('PRAGMA foreign_key_check').all().length,0);
assert.equal(sql.prepare('SELECT SUM(balance) n FROM casino_balances').get().n,2000);
console.log('PASS: v1/v2 dice, parallel slots/crash/coin (both sides, empty side, singleton, zero-entry refund, odd tie split), populated migration, acceleration boundary, choice guards, entry replay, concurrent advances, settlement replay, refunds, client proof/tamper checks, 100-token floor, FK integrity and conservation.');
