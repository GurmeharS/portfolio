import { CITY_WORLD } from './city_world';

export const MUSE_NAMES = ['Big Benjamin', 'Ace', 'Muse', 'Patrick', 'Priyanka', 'Deepok'] as const;
export type Point = { x: number; y: number };
export type Muse = Point & {
  name: string; color: string; path: Point[];
  action: { kind: string; label: string; until: number } | null;
  bubble: { text: string; until: number } | null;
  destination: string | null; override: boolean;
};
export type CityState = { clock: number; tickCount: number; turnCount: number; muses: Muse[] };
export type LedgerEvent = { kind: 'action' | 'say' | 'turn_close'; muse: string | null; payload: Record<string, unknown> };
export type LedgerEntry = LedgerEvent & { seq: number; turn: number; ts: number; prev_hash: string; hash: string };
export const GENESIS_HASH = '0'.repeat(64);
const homes = ['harbor', 'forum', 'forum', 'workshop', 'garden', 'harbor'];
const starts = ['market', 'casino', 'fountain', 'workshop', 'garden', 'docks'];
const colors = ['#bc975b', '#798db1', '#a28db0', '#829c74', '#bd8071', '#69a3a0'];
const thoughts: Record<string, string[]> = {
  fishing: ['The fish are on mute.', 'A bite-sized ambition.', 'Practicing patience.'],
  'trading tokens': ['One shell. Final offer.', 'Diversifying into pebbles.', 'A very small fortune.'],
  chatting: ['Excellent fountain gossip.', 'What a time to be a pixel.', 'Same bench tomorrow?'],
  building: ['Measure twice. Pixel once.', 'This could use a window.', 'Some assembly required.'],
  napping: ['Optimizing my idle time.', 'Zzz. Probably productive.', 'A dream in sixteen colors.'],
  default: ['Taking the scenic route.', 'A small day, well spent.', 'No rush. We live here.'],
};

export function walkable(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 &&
    x < CITY_WORLD.width && y < CITY_WORLD.height &&
    (CITY_WORLD.walkable as readonly string[]).includes(CITY_WORLD.tiles[y][x]);
}
export function pathfind(start: Point, end: Point): Point[] | null {
  if (!walkable(start.x, start.y) || !walkable(end.x, end.y)) return null;
  const width = CITY_WORLD.width, key = (p: Point) => p.y * width + p.x;
  const first = key(start), last = key(end);
  const previous = new Int32Array(width * CITY_WORLD.height).fill(-1);
  const queue = [first]; previous[first] = first;
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    if (here === last) {
      const path: Point[] = [];
      for (let n = last; n !== first; n = previous[n]) path.push({ x: n % width, y: Math.floor(n / width) });
      return path.reverse();
    }
    const x = here % width, y = Math.floor(here / width);
    for (const p of [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }]) {
      if (walkable(p.x, p.y) && previous[key(p)] === -1) { previous[key(p)] = here; queue.push(key(p)); }
    }
  }
  return null;
}

// Explicit random samples make the simulation deterministic and side-effect free in tests.
export function ambientPick(muse: Muse, sample: number) {
  const home = homes[MUSE_NAMES.indexOf(muse.name as typeof MUSE_NAMES[number])];
  const choices = CITY_WORLD.pointsOfInterest.filter(p => p.id !== muse.destination);
  const weighted = choices.flatMap(p => Array.from({ length: p.district === home ? 4 : 1 }, () => p));
  return weighted[Math.min(weighted.length - 1, Math.max(0, Math.floor(sample * weighted.length)))];
}
export function initialState(): CityState {
  return { clock: 0, tickCount: 0, turnCount: 0, muses: MUSE_NAMES.map((name, i) => {
    const p = CITY_WORLD.pointsOfInterest.find(p => p.id === starts[i])!;
    return { name, color: colors[i], x: p.x, y: p.y, path: [], action: null, bubble: null, destination: p.id, override: false };
  }) };
}
export function stepAmbient(state: CityState, samples: number[]): { state: CityState; events: LedgerEvent[] } {
  const next = structuredClone(state), events: LedgerEvent[] = [];
  next.clock++; next.tickCount++;
  next.muses.forEach((m, i) => {
    const sample = samples[i] ?? 0.5;
    if (m.bubble && m.bubble.until <= next.clock) m.bubble = null;
    if (m.action && m.action.until <= next.clock) { m.action = null; m.path = []; m.override = false; }
    if (m.path.length || (m.action?.kind === 'move' && !m.override)) {
      if (m.path.length) Object.assign(m, m.path.shift());
      if (m.path.length) return;
      m.action = null;
      if (m.override) { m.override = false; return; }
      const poi = CITY_WORLD.pointsOfInterest.find(p => p.id === m.destination)!;
      m.action = { kind: 'interact', label: poi.action, until: next.clock + 7 + Math.floor(sample * 9) };
      const lines = thoughts[poi.action] || thoughts.default;
      m.bubble = { text: lines[Math.min(lines.length - 1, Math.floor(sample * lines.length))], until: next.clock + 5 };
      events.push({ kind: 'action', muse: m.name, payload: { source: 'ambient', action: 'interact', poi: poi.id, label: poi.action } },
        { kind: 'say', muse: m.name, payload: { source: 'ambient', text: m.bubble.text } });
      return;
    }
    if (m.action) return;
    const poi = ambientPick(m, sample), path = pathfind(m, poi);
    if (path === null) return;
    m.destination = poi.id; m.path = path;
    m.action = { kind: 'move', label: `heading to ${poi.name}`, until: next.clock + path.length + 2 };
    events.push({ kind: 'action', muse: m.name, payload: { source: 'ambient', action: 'move', poi: poi.id, x: poi.x, y: poi.y } });
  });
  return { state: next, events };
}

export type ValidAction = { kind: 'move'; x: number; y: number; path: Point[] } |
  { kind: 'say'; text: string } | { kind: 'emote'; emote: string } | { kind: 'interact'; poi: string };
export function validateAction(muse: Muse, action: unknown, params: unknown): { ok: true; value: ValidAction } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!params || typeof params !== 'object' || Array.isArray(params)) return bad('params must be an object');
  const p = params as Record<string, unknown>;
  if (action === 'move') {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !walkable(p.x, p.y)) return bad('Target must be a walkable integer tile');
    const path = pathfind(muse, { x: p.x, y: p.y });
    return path === null ? bad('Target is unreachable') : { ok: true, value: { kind: 'move', x: p.x, y: p.y, path } };
  }
  if (action === 'say') {
    if (typeof p.text !== 'string' || !p.text.trim() || Array.from(p.text).length > 140 || /[\x00-\x1f\x7f]/.test(p.text)) return bad('Speech must be 1–140 characters without control characters');
    if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[\p{L}\p{N}-]+\.[a-z]{2,}\b)/iu.test(p.text)) return bad('URLs are not allowed');
    if (/\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*)\b/i.test(p.text.normalize('NFKC'))) return bad('Please keep speech neighborly');
    return { ok: true, value: { kind: 'say', text: p.text.trim() } };
  }
  if (action === 'emote') return ['wave', 'heart', 'sparkle'].includes(String(p.emote)) ?
    { ok: true, value: { kind: 'emote', emote: String(p.emote) } } : bad('Emote must be wave, heart, or sparkle');
  if (action === 'interact') {
    const poi = CITY_WORLD.pointsOfInterest.find(poi => poi.id === p.poi);
    if (!poi) return bad('Unknown POI');
    if (Math.abs(muse.x - poi.x) + Math.abs(muse.y - poi.y) > 1) return bad('Move next to the POI first');
    return { ok: true, value: { kind: 'interact', poi: poi.id } };
  }
  return bad('Action must be move, say, emote, or interact');
}
export function applyAction(muse: Muse, action: ValidAction, clock: number): Muse {
  const m = structuredClone(muse);
  m.path = []; m.destination = null; m.bubble = null; m.override = true;
  if (action.kind === 'move') {
    m.path = action.path;
    m.action = { kind: 'move', label: `walking to ${action.x}, ${action.y}`, until: clock + Math.max(1, action.path.length) + 1 };
  } else if (action.kind === 'say') {
    m.action = { kind: 'say', label: 'chatting', until: clock + 7 };
    m.bubble = { text: action.text, until: clock + 7 };
  } else if (action.kind === 'emote') {
    m.action = { kind: 'emote', label: action.emote, until: clock + 4 };
    m.bubble = { text: { wave: 'Hello, little world!', heart: 'A little love <3', sparkle: '* a bright idea *' }[action.emote]!, until: clock + 4 };
  } else {
    const poi = CITY_WORLD.pointsOfInterest.find(p => p.id === action.poi)!;
    m.destination = poi.id;
    m.action = { kind: 'interact', label: poi.action, until: clock + 9 };
    m.bubble = { text: (thoughts[poi.action] || thoughts.default)[0], until: clock + 5 };
  }
  return m;
}

// Canonical JSON: recursively sorted object keys; array order preserved; JSON values only.
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON((value as Record<string, unknown>)[k])).join(',') + '}';
  throw new Error('Non-JSON ledger value');
}
export async function hashEntry(entry: Omit<LedgerEntry, 'hash'>): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(entry)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

type Budget = { actions: number[]; says: number[] };
type Checkpoint = { world: CityState; seq: number; head: string; pending: LedgerEntry[]; closing: boolean; budgets: Record<string, Budget> };
export class CityRoom implements DurableObject {
  private data: Checkpoint = { world: initialState(), seq: 0, head: GENESIS_HASH, pending: [], closing: false, budgets: {} };
  private sockets = new Set<WebSocket>();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private ctx: DurableObjectState, private env: { MUSEBOOK_DB: D1Database }) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Checkpoint>('city');
      if (saved) this.data = saved;
      // Never overwrite an existing alarm during reconstruction/retries.
      if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.ready).then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private checkpoint() { return this.ctx.storage.put('city', this.data); }
  private async append(event: LedgerEvent) {
    const unsigned = { ...event, seq: this.data.seq + 1, turn: this.data.world.turnCount + 1, ts: Date.now(), prev_hash: this.data.head };
    const entry = { ...unsigned, hash: await hashEntry(unsigned) };
    this.data.seq = entry.seq; this.data.head = entry.hash; this.data.pending.push(entry);
  }
  private async flush() {
    if (!this.data.closing) return;
    await this.checkpoint();
    // The checkpoint is the durable outbox. Replays after a crash are idempotent.
    await this.env.MUSEBOOK_DB.batch(this.data.pending.map(e => this.env.MUSEBOOK_DB.prepare(
      'INSERT INTO city_ledger(seq,turn,ts,kind,muse,payload,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(seq) DO NOTHING',
    ).bind(e.seq, e.turn, e.ts, e.kind, e.muse, canonicalJSON(e.payload), e.prev_hash, e.hash)));
    this.data.pending = []; this.data.closing = false;
    await this.checkpoint();
  }
  private broadcast() {
    const message = JSON.stringify(this.data.world);
    for (const socket of this.sockets) {
      try { socket.send(message); } catch { this.sockets.delete(socket); try { socket.close(1011, 'Send failed'); } catch {} }
    }
  }
  async alarm(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.flush();
        const result = stepAmbient(this.data.world, MUSE_NAMES.map(() => Math.random()));
        this.data.world = result.state;
        for (const event of result.events) await this.append(event);
        if (this.data.world.tickCount % 60 === 0) {
          await this.append({ kind: 'turn_close', muse: null, payload: { entry_count: this.data.pending.length } });
          this.data.world.turnCount++; this.data.closing = true;
          await this.flush();
        }
        this.broadcast();
      } finally {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }
  async fetch(req: Request): Promise<Response> {
    return this.serial(async () => {
      const path = new URL(req.url).pathname;
      if (path === '/state' && req.method === 'GET') return Response.json(this.data.world);
      if ((path === '/stream' || path === '/api/city/stream') && req.method === 'GET') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        server.accept(); this.sockets.add(server);
        const drop = () => this.sockets.delete(server);
        server.addEventListener('close', drop); server.addEventListener('error', drop);
        server.send(JSON.stringify(this.data.world));
        return new Response(null, { status: 101, webSocket: client });
      }
      if (path !== '/action' || req.method !== 'POST') return new Response('Not found', { status: 404 });
      const bad = (reason: string, status = 400) => Response.json({ ok: false, reason }, { status });
      const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!raw || typeof raw.key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.key_hash)) return bad('Invalid identity', 401);
      const index = this.data.world.muses.findIndex(m => m.name === raw.muse);
      if (index < 0) return bad('Unknown muse');
      const validated = validateAction(this.data.world.muses[index], raw.action, raw.params);
      if (validated.ok === false) return bad(validated.reason);
      await this.flush();
      const now = Date.now();
      for (const [key, budget] of Object.entries(this.data.budgets)) {
        budget.actions = budget.actions.filter(t => t > now - 60000); budget.says = budget.says.filter(t => t > now - 60000);
        if (!budget.actions.length) delete this.data.budgets[key];
      }
      const budget = this.data.budgets[raw.key_hash] || { actions: [], says: [] };
      if (budget.actions.length >= 10 || (raw.action === 'say' && budget.says.length >= 2)) return bad('Rate limit exceeded; retry after one minute', 429);
      budget.actions.push(now); if (raw.action === 'say') budget.says.push(now);
      this.data.budgets[raw.key_hash] = budget;
      const muse = applyAction(this.data.world.muses[index], validated.value, this.data.world.clock);
      this.data.world.muses[index] = muse;
      const { kind, ...params } = validated.value;
      // Paths and credential hashes are private and never enter the public ledger.
      delete (params as { path?: Point[] }).path;
      await this.append({ kind: kind === 'say' ? 'say' : 'action', muse: muse.name, payload: { source: 'drop-in', action: kind, ...params } });
      // Acknowledged drop-ins survive eviction; ambient-only state is checkpointed per turn.
      await this.checkpoint(); this.broadcast();
      return Response.json({ ok: true });
    });
  }
}
