// node workers/musebook/tests/city.mjs (Node 24+). No network or Workers runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { moduleURL } from './load-worker.mjs';
const city = await import(moduleURL(new URL('../src/city.ts', import.meta.url)));
const { CITY_WORLD } = await import(moduleURL(new URL('../src/city_world.ts', import.meta.url)));
const worker = (await import(moduleURL(new URL('../src/index.ts', import.meta.url)))).default;
const source = JSON.parse(readFileSync(new URL('../../../public/agent-city/world.json', import.meta.url)));
for (const key of Object.keys(CITY_WORLD)) assert.deepEqual(CITY_WORLD[key], source[key]);
for (const start of CITY_WORLD.pointsOfInterest) for (const end of CITY_WORLD.pointsOfInterest) {
  const path = city.pathfind(start, end); assert(path);
  let previous = start;
  for (const tile of path) {
    assert(city.walkable(tile.x, tile.y));
    assert.equal(Math.abs(tile.x - previous.x) + Math.abs(tile.y - previous.y), 1); previous = tile;
  }
  assert.equal(previous.x, end.x); assert.equal(previous.y, end.y);
}
assert.equal(city.pathfind({ x: -1, y: 0 }, { x: 7, y: 11 }), null);
let state = city.initialState(), eventCount = 0, head = city.GENESIS_HASH, seq = 0;
for (let tick = 0; tick < 200; tick++) {
  const before = structuredClone(state);
  const result = city.stepAmbient(state, city.MUSE_NAMES.map((_, i) => ((tick * 31 + i * 17) % 100) / 100));
  assert.deepEqual(state, before); state = result.state;
  for (const m of state.muses) assert(city.walkable(m.x, m.y));
  for (const event of result.events) {
    const entry = { ...event, seq: ++seq, turn: Math.floor(tick / 60) + 1, ts: tick * 1000, prev_hash: head };
    head = await city.hashEntry(entry); assert.match(head, /^[a-f0-9]{64}$/); eventCount++;
  }
}
assert.equal(state.clock, 200); assert(eventCount > 30);
assert.equal(city.canonicalJSON({ z: [2, { b: 1, a: 0 }], a: true }), '{"a":true,"z":[2,{"a":0,"b":1}]}');
const ace = city.initialState().muses[1];
for (const text of ['https://example.com', 'www.test.ca', 'example.org', 'shit', 'a'.repeat(141), '', 'hi\nthere']) assert.equal(city.validateAction(ace, 'say', { text }).ok, false);
assert(city.validateAction(ace, 'say', { text: '🌱'.repeat(140) }).ok);
assert.equal(city.validateAction(ace, 'move', { x: 1.5, y: 1 }).ok, false);
assert.equal(city.validateAction(ace, 'interact', { poi: 'garden' }).ok, false);
assert(city.validateAction(ace, 'interact', { poi: 'casino' }).ok);
assert.equal(city.validateAction(ace, 'mint', {}).ok, false);
let overridden = city.initialState();
overridden.muses[1] = city.applyAction(ace, { kind: 'say', text: 'A small day.' }, 0);
for (let i = 0; i < 8; i++) overridden = city.stepAmbient(overridden, Array(6).fill(.2)).state;
assert.equal(overridden.muses[1].override, false); assert.equal(overridden.muses[1].action.kind, 'move');

// Economy: pure settlement math.
assert.equal(city.varietyMint(['move', 'say', 'move', 'interact']), 3);
assert.equal(city.varietyMint(['a', 'b', 'c', 'd', 'e', 'f']), 5);
assert.equal(city.varietyMint([]), 0);
assert.equal(city.workPayout('fish', 1), 2);
assert.equal(city.workPayout('fish', 2), 1); // escalation: the Nth identical earn pays less
assert.equal(city.workPayout('busk', 3), 0); // floored at zero
assert.equal(city.workPayout('craft', 1, true), 4); // claim owner bonus
assert.equal(city.capBurn(100), 0); assert.equal(city.capBurn(130), 30);
assert.equal(city.districtAt({ x: 7, y: 11 }), 'harbor');
assert.equal(city.districtAt({ x: 44, y: 22 }), 'forum');
assert.equal(city.districtAt({ x: 10, y: 40 }), 'workshop');
assert.equal(city.districtAt({ x: 50, y: 40 }), 'garden');
const root1 = await city.merkleRoot([{ a: 1 }]);
assert.equal(root1, await city.merkleRoot([{ a: 1 }]));
assert.notEqual(root1, await city.merkleRoot([{ a: 2 }]));
assert.match(await city.merkleRoot([]), /^[a-f0-9]{64}$/);

let eco = city.initialEconomy();
assert.deepEqual(Object.values(eco.balances), [10, 10, 10, 10, 10, 10]);
let r = city.planSettlement(eco, { turn: 1,
  work: [{ muse: 'Ace', poi: 'docks' }, { muse: 'Ace', poi: 'docks' }],
  claims: [{ muse: 'Ace', poi: 'docks' }], variety: { Ace: 3 } });
// 10 - 5 (claim) + 3 (first fish, owner bonus) + 2 (second fish, escalated) + 3 (variety) - 1 (upkeep) = 12
assert.equal(r.economy.balances['Ace'], 12);
assert.equal(r.economy.claims['docks'].muse, 'Ace');
assert(r.entries.some(e => e.kind === 'mint' && e.payload.reason === 'work' && e.payload.ordinal === 2 && e.payload.amount === 2));
assert(r.entries.every(e => e.payload.settlement_turn === 1));
r = city.planSettlement(r.economy, { turn: 2, work: [], claims: [], variety: {} });
assert.equal(r.economy.balances['Ace'], 11); // upkeep
r.economy.balances['Ace'] = 0;
r = city.planSettlement(r.economy, { turn: 3, work: [], claims: [], variety: {} });
assert(!r.economy.claims['docks']); // missed upkeep releases the claim
assert(r.entries.some(e => e.kind === 'claim_release'));
r = city.planSettlement(r.economy, { turn: 4, work: [],
  claims: [{ muse: 'Muse', poi: 'market' }, { muse: 'Patrick', poi: 'market' }], variety: {} });
assert.equal(r.economy.claims['market'].muse, 'Muse');
assert(r.entries.some(e => e.kind === 'claim' && e.payload.status === 'failed')); // already claimed
eco = city.initialEconomy();
eco.trades['t1'] = { id: 't1', from: 'Ace', to: 'Muse', amount: 4, status: 'accepted', created_turn: 1, expires_turn: 6, settle_turn: 5 };
r = city.planSettlement(eco, { turn: 5, work: [], claims: [], variety: {} });
assert.equal(r.economy.balances['Ace'], 6); assert.equal(r.economy.balances['Muse'], 14);
assert(r.entries.some(e => e.kind === 'transfer' && e.payload.status === 'settled'));
eco = city.initialEconomy();
eco.trades['t2'] = { id: 't2', from: 'Ace', to: 'Muse', amount: 99, status: 'accepted', created_turn: 1, expires_turn: 6, settle_turn: 5 };
r = city.planSettlement(eco, { turn: 5, work: [], claims: [], variety: {} });
assert(r.entries.some(e => e.kind === 'transfer' && e.payload.status === 'failed')); // revalidated at settle time
assert.equal(r.economy.balances['Ace'], 10);
eco = city.initialEconomy();
eco.trades['t3'] = { id: 't3', from: 'Ace', to: 'Muse', amount: 2, status: 'pending', created_turn: 1, expires_turn: 5 };
r = city.planSettlement(eco, { turn: 5, work: [], claims: [], variety: {} });
assert.equal(r.economy.trades['t3'].status, 'expired');
eco = city.initialEconomy(); eco.balances['Ace'] = 105;
r = city.planSettlement(eco, { turn: 1, work: [], claims: [], variety: {} });
assert.equal(r.economy.balances['Ace'], 100); // stockpile cap
assert(r.entries.some(e => e.kind === 'burn' && e.payload.amount === -5));

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../migrations/0011_city.sql', import.meta.url), 'utf8'));
sql.exec(readFileSync(new URL('../migrations/0012_city_economy.sql', import.meta.url), 'utf8'));
class Statement {
  constructor(query, args = []) { this.query = query; this.args = args; }
  bind(...args) { return new Statement(this.query, args); }
  async first() { return sql.prepare(this.query).get(...this.args) ?? null; }
  async all() { return { results: sql.prepare(this.query).all(...this.args) }; }
  async run() { return sql.prepare(this.query).run(...this.args); }
}
let batches = 0, failBatch = false;
const db = { prepare: q => new Statement(q), async batch(statements) {
  batches++; if (failBatch) throw Error('D1 offline');
  sql.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; }
  catch (error) { sql.exec('ROLLBACK'); throw error; }
} };
let stored, alarmAt, writes = 0;
const ctx = { storage: {
  async get() { return structuredClone(stored); },
  async put(key, value) { writes++; stored = structuredClone(value); },
  async getAlarm() { return alarmAt ?? null; }, async setAlarm(value) { alarmAt = value; },
}, blockConcurrencyWhile(fn) { return fn(); } };
let room = new city.CityRoom(ctx, { MUSEBOOK_DB: db });
// Node does not implement Workers' 101 Response extension; emulate only that boundary.
const NativeResponse = globalThis.Response;
globalThis.Response = class extends NativeResponse {
  constructor(body, init) { super(body, init?.status === 101 ? { ...init, status: 200 } : init); this.webSocket = init?.webSocket; }
  get status() { return this.webSocket ? 101 : super.status; }
};
const pairs = [];
class FakeSocket {
  messages = []; listeners = {}; fail = false;
  accept() { this.accepted = true; }
  send(message) { if (this.fail) throw Error('Dead socket'); this.messages.push(JSON.parse(message)); }
  close() { this.listeners.close?.(); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
}
globalThis.WebSocketPair = class {
  constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); pairs.push(this); }
};
assert.equal((await room.fetch(new Request('https://city.internal/stream'))).status, 426);
const upgrade = await room.fetch(new Request('https://city.internal/stream', { headers: { Upgrade: 'websocket' } }));
assert.equal(upgrade.status, 101); assert(pairs[0][1].accepted); assert.equal(pairs[0][1].messages[0].muses.length, 6);
const originalNow = Date.now; let now = 1900000000000; Date.now = () => now;
const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
const owner = 'test-owner', env = { MUSEBOOK_DB: db, CITY_OWNER_KEY: await sha(owner), CITY_ROOM: {
  idFromName(name) { assert.equal(name, 'main'); return name; }, get() { return { fetch: (url, init) => room.fetch(new Request(url, init)) }; }
} };
async function request(path, body, bearer) {
  const res = await worker.fetch(new Request('https://local/api/city/' + path, { method: body ? 'POST' : 'GET',
    headers: { Origin: 'https://gurmehar.ca', 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://gurmehar.ca');
  return { status: res.status, body: await res.json() };
}
assert.equal((await request('admin/keys', { muse: 'Ace' })).status, 401);
assert.equal((await request('admin/keys', { muse: 'Unknown' }, owner)).status, 400);
const issued = await request('admin/keys', { muse: 'Ace', label: 'test' }, owner);
assert.equal(issued.status, 201); assert.match(issued.body.key, /^[a-f0-9]{64}$/);
const key = issued.body.key;
assert.equal(sql.prepare('SELECT key_hash FROM city_keys').get().key_hash, await sha(key));
assert.equal((await request('action', { key: 'x'.repeat(64), action: 'say', params: { text: 'Hi' } })).status, 401);
assert.equal((await request('action', { key, action: 'say', params: { text: 'https://bad.test' } })).status, 400);
const act = (action, params) => request('action', { key, action, params, muse: 'Muse' });
assert.equal((await act('say', { text: 'Hello, tiles.' })).status, 200);
assert.equal(pairs[0][1].messages.at(-1).muses[1].bubble.text, 'Hello, tiles.');
pairs[0][1].fail = true;
assert.equal((await act('say', { text: 'Hello again.' })).status, 200);
assert.equal((await act('say', { text: 'Too chatty.' })).status, 429);
let snapshot = (await request('state')).body;
assert.equal(snapshot.muses[1].bubble.text, 'Hello again.'); assert.equal(snapshot.muses[2].override, false);
room = new city.CityRoom(ctx, { MUSEBOOK_DB: db });
assert.equal((await act('say', { text: 'Restart bypass?' })).status, 429);
const concurrent = await Promise.all(Array.from({ length: 10 }, () => act('emote', { emote: 'wave' })));
assert.equal(concurrent.filter(r => r.status === 200).length, 8);
assert.equal(concurrent.filter(r => r.status === 429).length, 2);
for (let i = 0; i < 59; i++) { now += 1000; await room.alarm(); }
assert.equal(batches, 0);
failBatch = true; now += 1000;
await assert.rejects(room.alarm(), /D1 offline/); assert(alarmAt > now); assert(stored.closing);
// Restart with the durable outbox, retry, and continue the chain.
room = new city.CityRoom(ctx, { MUSEBOOK_DB: db }); failBatch = false; now += 1000; await room.alarm();
assert.equal(stored.closing, false);
// Simulate a crash after D1 commit but before marking the outbox flushed.
const saved = structuredClone(stored);
stored.pending = sql.prepare('SELECT * FROM city_ledger ORDER BY seq').all().map(e => ({ ...e, payload: JSON.parse(e.payload) }));
stored.closing = true;
room = new city.CityRoom(ctx, { MUSEBOOK_DB: db }); await room.alarm();
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM city_ledger').get().n, stored.seq);
assert.equal(stored.seq, saved.seq);
for (let i = 0; i < 140; i++) { now += 1000; await room.alarm(); }
const rows = sql.prepare('SELECT * FROM city_ledger ORDER BY seq').all(); head = city.GENESIS_HASH;
let entriesThisTurn = 0;
for (const row of rows) {
  const { hash, ...entry } = { ...row, payload: JSON.parse(row.payload) };
  assert.equal(entry.prev_hash, head); assert.equal(hash, await city.hashEntry(entry)); head = hash;
  if (entry.kind === 'turn_close') { assert.equal(entry.payload.entry_count, entriesThisTurn); entriesThisTurn = 0; }
  else entriesThisTurn++;
}
assert.equal(rows.filter(r => r.kind === 'turn_close').length, 3);
assert(!JSON.stringify(rows).includes(key));
assert.equal((await request('ledger?limit=2')).body.entries.length, 2);
// Economy end-to-end: trade offer -> accept settles only when a district stamps the turn.
const museKey = (await request('admin/keys', { muse: 'Muse' }, owner)).body.key;
assert.equal((await request('trade', { key, to: 'Muse', amount: 3, id: 'e2e-1' })).status, 200);
assert.equal((await request('trade', { key, to: 'Muse', amount: 3, id: 'e2e-1' })).status, 400); // duplicate id
assert.equal((await request('trade', { key, to: 'Ace', amount: 1, id: 'e2e-2' })).status, 400); // self-trade
assert.equal((await request('trade/accept', { key: museKey, id: 'nope' })).status, 400);
assert.equal((await request('trade/accept', { key, id: 'e2e-1' })).status, 400); // only the counterparty accepts
assert.equal((await request('trade/accept', { key: museKey, id: 'e2e-1' })).status, 200);
assert.equal((await request('buy', { key, item: 'flair', params: { text: 'star' } })).status, 200);
assert.equal((await request('buy', { key, item: 'lantern', params: { color: 'not-a-color' } })).status, 400);
// Without a stamp the settlement waits: run exactly one turn boundary.
const turnBefore = (await request('state')).body.turn;
for (let i = 0; i < 70 && (await request('state')).body.turn === turnBefore; i++) { now += 1000; await room.alarm(); }
const tradeTurn = turnBefore + 1; // the open turn during which the trade was accepted
let st = await request('state');
assert(st.body.pendingTurns.length > 0);
assert(!(await request('ledger?limit=500')).body.entries.some(e => e.kind === 'settlement' && e.payload.turn >= tradeTurn));
assert.equal((await request('stamp', { key, turn: tradeTurn + 99 })).status, 400); // unknown turn
// Stamp every pending turn in order; the trade settles when its own turn is stamped.
for (const p of st.body.pendingTurns.map(p => p.turn).sort((a, b) => a - b))
  assert.equal((await request('stamp', { key, turn: p })).status, 200);
st = await request('state');
assert.equal(st.body.pendingTurns.length, 0);
const settled = (await request('ledger?limit=500')).body.entries;
const turnEntries = settled.filter(e => e.payload.settlement_turn === tradeTurn && e.kind !== 'settlement');
assert.equal(turnEntries.filter(e => e.kind === 'transfer' && e.payload.status === 'settled').length, 2);
assert.equal(turnEntries.filter(e => e.kind === 'transfer').reduce((s, e) => s + e.payload.amount, 0), 0); // -3 and +3
assert(settled.some(e => e.kind === 'buy' && e.muse === 'Ace' && e.payload.item === 'flair' && e.payload.amount === -5));
const settlement = settled.find(e => e.kind === 'settlement' && e.payload.turn === tradeTurn);
assert(settlement); assert.match(settlement.payload.merkle_root, /^[a-f0-9]{64}$/);
const recomputed = await city.merkleRoot(turnEntries.slice().reverse().map(({ kind, muse, payload }) => ({ kind, muse, payload })));
assert.equal(recomputed, settlement.payload.merkle_root);
assert(settled.some(e => e.kind === 'stamp' && e.payload.turn === tradeTurn));
assert(st.body.balances['Ace'] !== undefined && st.body.recent.length > 0);
sql.prepare('UPDATE city_keys SET revoked_at = ?').run(now);
assert.equal((await act('emote', { emote: 'wave' })).status, 401);
Date.now = originalNow; globalThis.Response = NativeResponse; delete globalThis.WebSocketPair;
console.log(`City passed: 121 POI paths, 200 pure ticks, validation, auth, concurrent limits, recovery/replay, ${rows.length} verified ledger rows.`);
