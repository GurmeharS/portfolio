// Exercise the real connection adapter with a fake browser; no WebGL/network needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../../public/agent-city/city.js', import.meta.url), 'utf8');
const names = ['Big Benjamin', 'Ace', 'Muse', 'Patrick', 'Priyanka', 'Deepok'];
let id = 0, fetchBody;
const timers = new Map(), sockets = [];
class Socket {
  listeners = {};
  constructor(url) { assert.equal(url, 'wss://musebook-api.gurmehar.workers.dev/api/city/stream'); sockets.push(this); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  sendState(state) { this.listeners.message({ data: JSON.stringify(state) }); }
  close() { this.closed = true; this.listeners.close?.(); }
}
const muses = names.map(name => ({ name, x: 1, y: 1, path: [], controlled: false }));
const context = vm.createContext({
  URLSearchParams, params: new URLSearchParams('drive=Ace'), window: {},
  palettes: names.map(name => ({ name })), muses,
  localStorage: { getItem() { return 'browser-test-key'; } },
  world: { dayLengthSeconds: 180, pointsOfInterest: [] }, worldTime: 0,
  walkable: (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0,
  dispatch() {}, updateHUD() {}, WebSocket: Socket,
  setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, delay }); return key; },
  clearTimeout(key) { timers.delete(key); },
  async fetch(url, options) { assert.equal(url, 'https://musebook-api.gurmehar.workers.dev/api/city/action'); fetchBody = JSON.parse(options.body); return { json: async () => ({ ok: true }) }; }
});
vm.runInContext(source.slice(source.indexOf('const CITY_API'), source.indexOf('function walkable')), context);
vm.runInContext('connectCity()', context);
const snap = { clock: 61, muses: names.map(name => ({ name, x: 4, y: 5, path: [], action: { kind: 'say', label: 'chatting', until: 68 }, bubble: { text: 'Shared world.', until: 68 }, override: true })) };
sockets[0].sendState({}); assert.equal(vm.runInContext('serverLive', context), false);
sockets[0].sendState(snap); assert.equal(vm.runInContext('serverLive', context), true);
assert.equal(context.worldTime, 123); assert.equal(muses[1].x, 4); assert.equal(muses[1].bubbleTimer, 7);
await context.window.cityAction('say', { text: 'Hi.' });
assert.deepEqual(fetchBody, { key: 'browser-test-key', action: 'say', params: { text: 'Hi.' } });
sockets[0].listeners.error(); assert.equal(vm.runInContext('serverLive', context), false);
assert.equal(muses[1].controlled, false); assert.equal(muses[1].state, 'idle');
let retry = [...timers.values()].find(t => t.delay === 1000); assert(retry); retry.fn();
sockets[1].close(); retry = [...timers.values()].find(t => t.delay === 2000); assert(retry); retry.fn();
sockets[2].sendState(snap); assert.equal(vm.runInContext('serverLive', context), true);
const watchdog = [...timers.values()].find(t => t.delay === 15000); watchdog.fn();
assert.equal(vm.runInContext('serverLive', context), false);
sockets[2].sendState(snap); assert.equal(vm.runInContext('serverLive', context), false); // late message cannot revive failed socket
console.log('City browser passed: snapshot mapping, authenticated POST, close/error fallback, backoff, reconnection, stale-stream watchdog.');
