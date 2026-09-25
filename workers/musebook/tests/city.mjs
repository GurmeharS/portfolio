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

const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../migrations/0011_city.sql', import.meta.url), 'utf8'));
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
sql.prepare('UPDATE city_keys SET revoked_at = ?').run(now);
assert.equal((await act('emote', { emote: 'wave' })).status, 401);
Date.now = originalNow; globalThis.Response = NativeResponse; delete globalThis.WebSocketPair;
console.log(`City passed: 121 POI paths, 200 pure ticks, validation, auth, concurrent limits, recovery/replay, ${rows.length} verified ledger rows.`);
