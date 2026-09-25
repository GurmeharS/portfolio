import { CITY_WORLD } from './city_world';

export const MUSE_NAMES = ['Big Benjamin', 'Ace', 'Muse', 'Patrick', 'Priyanka', 'Deepok'] as const;
export type Point = { x: number; y: number };
export type Muse = Point & {
  name: string; color: string; path: Point[];
  action: { kind: string; label: string; until: number } | null;
  bubble: { text: string; until: number } | null;
  destination: string | null; override: boolean; lantern?: string; flair?: string;
};
export type CityState = { clock: number; tickCount: number; turnCount: number; muses: Muse[] };
export type LedgerEvent = { kind: 'action' | 'say' | 'turn_close' | 'mint' | 'burn' | 'transfer' | 'upkeep' | 'claim' | 'claim_release' | 'buy' | 'stamp' | 'settlement' | 'trade_offer' | 'trade_accept'; muse: string | null; payload: Record<string, unknown> };
export type LedgerEntry = LedgerEvent & { seq: number; turn: number; ts: number; prev_hash: string; hash: string };
export const PAYOUTS: Record<string, number> = { fish: 2, trade: 2, craft: 3, busk: 1, tend: 2 };
export const QUORUM_DISTRICTS = 1;
export const workKind = (poi: string) => ({ docks: 'fish', market: 'trade', exchange: 'trade', workshop: 'craft', benches: 'craft', fountain: 'busk', glasshouse: 'tend' } as Record<string, string>)[poi];
export const varietyMint = (kinds: string[]) => Math.min(5, new Set(kinds).size);
export const workPayout = (kind: string, n: number, owner = false) => Math.max(0, (PAYOUTS[kind] || 0) + Number(owner) - (n - 1));
export const capBurn = (balance: number) => Math.max(0, balance - 100);
export const districtAt = (p: Point) => p.y < 25 ? (p.x < 34 ? 'harbor' : 'forum') : (p.x < 34 ? 'workshop' : 'garden');
export async function merkleRoot(entries: unknown[]): Promise<string> {
  const digest = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
  let level = await Promise.all(entries.map(e => digest(canonicalJSON(e))));
  if (!level.length) return digest('');
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await digest(level[i] + (level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
}
type Trade = { id: string; from: string; to: string; amount: number; status: string; created_turn: number; expires_turn: number; settle_turn?: number };
type Economy = { balances: Record<string, number>; claims: Record<string, { muse: string; claimed_at: number }>; trades: Record<string, Trade>; pioneers: string[] };
type TurnInput = { turn: number; work: { muse: string; poi: string }[]; claims: { muse: string; poi: string }[]; variety: Record<string, number> };
type PendingSettlement = { turn: number; economy: Economy; entries: LedgerEvent[]; stamps: Record<string, string> };
export function initialEconomy(): Economy { return { balances: Object.fromEntries(MUSE_NAMES.map(m => [m, 10])), claims: {}, trades: {}, pioneers: [...MUSE_NAMES] }; }
// A proposal is evaluated against current funds again when signed: purchases can occur while an audit waits.
export function planSettlement(economy: Economy, input: TurnInput): { economy: Economy; entries: LedgerEvent[] } {
  const e = structuredClone(economy), entries: LedgerEvent[] = [];
  const log = (kind: LedgerEvent['kind'], muse: string | null, payload: Record<string, unknown>) => entries.push({ kind, muse, payload: { ...payload, settlement_turn: input.turn } });
  const delta = (kind: LedgerEvent['kind'], muse: string, amount: number, payload: Record<string, unknown>) => { e.balances[muse] += amount; log(kind, muse, { ...payload, amount, balance: e.balances[muse] }); };
  for (const c of input.claims) {
    if (e.claims[c.poi] || Object.values(e.claims).some(v => v.muse === c.muse) || e.balances[c.muse] < 5) log('claim', c.muse, { poi: c.poi, status: 'failed' });
    else { e.claims[c.poi] = { muse: c.muse, claimed_at: input.turn }; delta('claim', c.muse, -5, { poi: c.poi, status: 'claimed' }); }
  }
  const counts: Record<string, number> = {};
  for (const w of input.work) {
    const kind = workKind(w.poi); if (!kind) continue;
    const key = w.muse + ':' + kind, n = counts[key] = (counts[key] || 0) + 1;
    delta('mint', w.muse, workPayout(kind, n, e.claims[w.poi]?.muse === w.muse), { reason: 'work', poi: w.poi, action: kind, ordinal: n });
  }
  for (const muse of MUSE_NAMES) if (input.variety[muse]) delta('mint', muse, input.variety[muse], { reason: 'variety' });
  for (const [poi, claim] of Object.entries(e.claims)) {
    if (e.balances[claim.muse] >= 1) delta('upkeep', claim.muse, -1, { poi });
    else { delete e.claims[poi]; log('claim_release', claim.muse, { poi, reason: 'insufficient_funds' }); }
  }
  for (const trade of Object.values(e.trades)) {
    if (trade.status === 'pending' && trade.expires_turn <= input.turn) { trade.status = 'expired'; log('trade_offer', trade.from, { id: trade.id, status: 'expired' }); }
    if (trade.status !== 'accepted' || trade.settle_turn! > input.turn) continue;
    trade.status = e.balances[trade.from] >= trade.amount ? 'settled' : 'failed';
    if (trade.status === 'failed') log('transfer', trade.from, { id: trade.id, status: 'failed', reason: 'insufficient_funds' });
    else {
      delta('transfer', trade.from, -trade.amount, { id: trade.id, counterparty: trade.to, status: 'settled' });
      delta('transfer', trade.to, trade.amount, { id: trade.id, counterparty: trade.from, status: 'settled' });
    }
  }
  for (const muse of MUSE_NAMES) { const burn = capBurn(e.balances[muse]); if (burn) delta('burn', muse, -burn, { reason: 'stockpile_cap' }); }
  return { economy: e, entries };
}

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
  { kind: 'say'; text: string } | { kind: 'emote'; emote: string } | { kind: 'interact'; poi: string; claim?: boolean };
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
    if (p.claim !== undefined && typeof p.claim !== 'boolean') return bad('claim must be boolean');
    if (p.claim && !('claimable' in poi && poi.claimable)) return bad('POI is not claimable');
    return { ok: true, value: { kind: 'interact', poi: poi.id, claim: p.claim === true } };
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
type Checkpoint = { world: CityState; seq: number; head: string; pending: LedgerEntry[]; closing: boolean; budgets: Record<string, Budget>; economy?: Economy; inputs?: TurnInput[]; history?: Record<string, string[]>; work?: TurnInput['work']; claims?: TurnInput['claims']; turnEntries?: LedgerEntry[]; recent?: LedgerEntry[]; settled?: number; pendingSettlements?: PendingSettlement[] };
export class CityRoom implements DurableObject {
  private data: Checkpoint = { world: initialState(), seq: 0, head: GENESIS_HASH, pending: [], closing: false, budgets: {} };
  private sockets = new Set<WebSocket>();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private ctx: DurableObjectState, private env: { MUSEBOOK_DB: D1Database }) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Checkpoint>('city');
      if (saved) this.data = saved;
      this.data.economy ??= initialEconomy(); this.data.inputs ??= []; this.data.history ??= {};
      this.data.work ??= []; this.data.claims ??= []; this.data.turnEntries ??= [...this.data.pending]; this.data.recent ??= []; this.data.settled ??= 0;
      this.data.pendingSettlements ??= [];
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
  private async append(event: LedgerEvent, turnOverride?: number) {
    const unsigned = { ...event, seq: this.data.seq + 1, turn: turnOverride ?? this.data.world.turnCount + 1, ts: Date.now(), prev_hash: this.data.head };
    const entry = { ...unsigned, hash: await hashEntry(unsigned) };
    this.data.seq = entry.seq; this.data.head = entry.hash; this.data.pending.push(entry); this.data.turnEntries!.push(entry);
    if (!['action', 'say', 'turn_close'].includes(entry.kind)) { this.data.recent!.push(entry); this.data.recent = this.data.recent!.slice(-20); }
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
    const message = JSON.stringify(this.snapshot());
    for (const socket of this.sockets) {
      try { socket.send(message); } catch { this.sockets.delete(socket); try { socket.close(1011, 'Send failed'); } catch {} }
    }
  }
  async alarm(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.flush();
        for (const m of this.data.world.muses) {
          if (m.action?.kind === 'interact' && m.action.until <= this.data.world.clock + 1 && m.destination) {
            this.data.work!.push({ muse: m.name, poi: m.destination });
            this.recordKind(m.name, workKind(m.destination) || m.action.label);
            await this.append({ kind: 'action', muse: m.name, payload: { action: 'complete', poi: m.destination } });
          }
        }
        const result = stepAmbient(this.data.world, MUSE_NAMES.map(() => Math.random()));
        this.data.world = result.state;
        for (const event of result.events) { await this.append(event); if (event.muse && event.payload.action === 'move') this.recordKind(event.muse, 'move'); }
        if (this.data.world.tickCount % 60 === 0) {
          const turn = this.data.world.turnCount + 1;
          const variety = Object.fromEntries(MUSE_NAMES.map(m => [m, varietyMint([turn - 2, turn - 1, turn].flatMap(t => this.data.history![t + ':' + m] || []))]));
          const input = { turn, work: this.data.work!, claims: this.data.claims!, variety };
          this.data.inputs!.push(input); this.data.work = []; this.data.claims = [];
          // Plan the settlement against the latest pending economy so turns chain
          // correctly. It is NOT applied until a district stamps the turn's audit.
          const base = this.data.pendingSettlements!.length ? this.data.pendingSettlements!.at(-1)!.economy : this.data.economy!;
          const planned = planSettlement(base, input);
          this.data.pendingSettlements!.push({ turn, economy: planned.economy, entries: planned.entries, stamps: {} });
          const entries = this.data.turnEntries!;
          await this.append({ kind: 'turn_close', muse: null, payload: { entry_count: entries.length, merkle_root: await merkleRoot(entries) } });
          this.data.turnEntries = [];
          for (const key of Object.keys(this.data.history!)) if (Number(key.split(':')[0]) < turn - 1) delete this.data.history![key];
          this.data.world.turnCount++; this.data.closing = true;
          await this.flush();
        }
        this.broadcast();
      } finally {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }
  private latestEconomy(): Economy {
    const p = this.data.pendingSettlements!;
    return p.length ? p[p.length - 1].economy : this.data.economy!;
  }
  private recordKind(muse: string, kind: string) {
    const key = (this.data.world.turnCount + 1) + ':' + muse;
    (this.data.history![key] ??= []).push(kind);
  }
  private async pioneer(name: string) {
    const eco = this.latestEconomy();
    if (eco.pioneers.includes(name)) return;
    eco.pioneers.push(name);
    eco.balances[name] = (eco.balances[name] ?? 0) + 10;
    await this.append({ kind: 'mint', muse: name, payload: { reason: 'pioneer_grant', amount: 10, balance: eco.balances[name] } });
  }
  private snapshot() {
    // Balances shown are the latest PLANNED figures; pendingTurns tells the
    // viewer which turns are still awaiting a district stamp.
    const latest = this.data.pendingSettlements!.length ? this.data.pendingSettlements!.at(-1)!.economy : this.data.economy!;
    return {
      clock: this.data.world.clock, tick: this.data.world.tickCount, turn: this.data.world.turnCount,
      muses: this.data.world.muses.map(m => ({
        name: m.name, color: m.color, x: m.x, y: m.y, action: m.action, bubble: m.bubble,
        destination: m.destination, override: m.override, lantern: m.lantern, flair: m.flair,
        shells: latest.balances[m.name] ?? 0,
      })),
      balances: { ...latest.balances },
      claims: Object.fromEntries(Object.entries(latest.claims).map(([poi, c]) => [poi, c.muse])),
      pendingTurns: this.data.pendingSettlements!.map(p => ({ turn: p.turn, stamps: { ...p.stamps } })),
      recent: this.data.recent!.slice(-12).reverse(),
    };
  }
  private async applySettlement(p: PendingSettlement) {
    for (const e of p.entries) await this.append(e);
    await this.append({ kind: 'settlement', muse: null, payload: {
      turn: p.turn, entry_count: p.entries.length, merkle_root: await merkleRoot(p.entries), stamps: p.stamps,
    } }, p.turn);
    this.data.economy = p.economy;
    this.data.settled = p.turn;
    await this.persistEconomy();
  }
  // Best-effort D1 mirror of the economic state; the ledger remains the source of truth.
  private async persistEconomy() {
    try {
      const eco = this.data.economy!;
      const stmts = Object.entries(eco.balances).map(([muse, balance]) =>
        this.env.MUSEBOOK_DB.prepare('INSERT INTO city_balances(muse,balance) VALUES (?,?) ON CONFLICT(muse) DO UPDATE SET balance=excluded.balance').bind(muse, balance));
      stmts.push(this.env.MUSEBOOK_DB.prepare('DELETE FROM city_claims').bind());
      for (const [poi, c] of Object.entries(eco.claims))
        stmts.push(this.env.MUSEBOOK_DB.prepare('INSERT INTO city_claims(poi,muse,claimed_at) VALUES (?,?,?)').bind(poi, c.muse, c.claimed_at));
      for (const t of Object.values(eco.trades))
        stmts.push(this.env.MUSEBOOK_DB.prepare("INSERT INTO city_trades(id,from_muse,to_muse,amount,status,created_turn,expires_turn) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status").bind(t.id, t.from, t.to, t.amount, t.status, t.created_turn, t.expires_turn));
      await this.env.MUSEBOOK_DB.batch(stmts);
    } catch (e) { console.log('city economy mirror failed: ' + (e as Error)?.message); }
  }
  // Returns an error string, or null on success.
  private async economicAction(path: string, raw: Record<string, unknown>, muse: Muse): Promise<string | null> {
    const eco = this.latestEconomy();
    const name = muse.name;
    const textParam = (k: string) => {
      const params = raw.params as Record<string, unknown> | undefined;
      const v = params?.[k] ?? raw[k];
      return typeof v === 'string' ? v.trim() : '';
    };
    if (path === '/trade') {
      const to = String(raw.to ?? ''), amount = Number(raw.amount), id = String(raw.id ?? '');
      if (!(MUSE_NAMES as readonly string[]).includes(to) || to === name) return 'Counterparty must be another roster muse';
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100) return 'Amount must be 1-100 shells';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || eco.trades[id]) return 'Trade id must be unique (letters, numbers, _ -)';
      if ((eco.balances[name] ?? 0) < amount) return 'Insufficient shells';
      const turn = this.data.world.turnCount + 1;
      eco.trades[id] = { id, from: name, to, amount, status: 'pending', created_turn: turn, expires_turn: turn + 5 };
      await this.append({ kind: 'trade_offer', muse: name, payload: { id, to, amount, expires_turn: turn + 5 } });
      return null;
    }
    if (path === '/trade/accept') {
      const id = String(raw.id ?? '');
      const trade = eco.trades[id];
      if (!trade || trade.status !== 'pending') return 'Unknown or inactive trade';
      if (trade.to !== name) return 'Only the named counterparty can accept';
      const turn = this.data.world.turnCount + 1;
      if (trade.expires_turn <= turn) {
        trade.status = 'expired';
        await this.append({ kind: 'trade_offer', muse: trade.from, payload: { id, status: 'expired' } });
        return 'Trade expired';
      }
      trade.status = 'accepted'; trade.settle_turn = turn;
      await this.append({ kind: 'trade_accept', muse: name, payload: { id, from: trade.from, amount: trade.amount, settle_turn: turn } });
      return null;
    }
    if (path === '/buy') {
      const item = String(raw.item ?? '');
      const spend = (cost: number) => (eco.balances[name] ?? 0) < cost ? 'Insufficient shells' : (eco.balances[name] -= cost, null);
      if (item === 'lantern') {
        const color = textParam('color');
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) return 'Lantern color must be #rrggbb';
        const err = spend(3); if (err) return err;
        muse.lantern = color;
        await this.append({ kind: 'buy', muse: name, payload: { item, color, amount: -3, balance: eco.balances[name] } });
        return null;
      }
      if (item === 'flair') {
        const text = textParam('text');
        if (Array.from(text).length === 0 || Array.from(text).length > 12) return 'Flair must be 1-12 characters';
        const v = validateAction(muse, 'say', { text });
        if (v.ok === false) return v.reason;
        const err = spend(5); if (err) return err;
        muse.flair = text;
        await this.append({ kind: 'buy', muse: name, payload: { item, text, amount: -5, balance: eco.balances[name] } });
        return null;
      }
      if (item === 'crier') {
        const text = textParam('text');
        const v = validateAction(muse, 'say', { text });
        if (v.ok === false) return v.reason;
        const err = spend(5); if (err) return err;
        await this.append({ kind: 'buy', muse: name, payload: { item, text, amount: -5, balance: eco.balances[name] } });
        return null;
      }
      return 'Unknown item (lantern, flair, crier)';
    }
    if (path === '/stamp') {
      const turn = Number(raw.turn);
      if (!Number.isInteger(turn)) return 'turn must be an integer';
      const p = this.data.pendingSettlements!.find(p => p.turn === turn);
      if (!p) return 'No pending settlement for that turn';
      const district = districtAt(muse);
      if (p.stamps[district]) return `${district} already stamped turn ${turn}`;
      p.stamps[district] = name;
      await this.append({ kind: 'stamp', muse: name, payload: { turn, district } }, turn);
      // Settlements apply strictly in turn order once each reaches quorum.
      while (this.data.pendingSettlements!.length && Object.keys(this.data.pendingSettlements![0].stamps).length >= QUORUM_DISTRICTS)
        await this.applySettlement(this.data.pendingSettlements!.shift()!);
      return null;
    }
    return 'Unknown economy action';
  }
  async fetch(req: Request): Promise<Response> {
    return this.serial(async () => {
      const path = new URL(req.url).pathname;
      if (path === '/state' && req.method === 'GET') return Response.json(this.snapshot());
      if ((path === '/stream' || path === '/api/city/stream') && req.method === 'GET') {
        if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        server.accept(); this.sockets.add(server);
        const drop = () => this.sockets.delete(server);
        server.addEventListener('close', drop); server.addEventListener('error', drop);
        server.send(JSON.stringify(this.snapshot()));
        return new Response(null, { status: 101, webSocket: client });
      }
      if (!['/action', '/trade', '/trade/accept', '/buy', '/stamp'].includes(path) || req.method !== 'POST') return new Response('Not found', { status: 404 });
      const bad = (reason: string, status = 400) => Response.json({ ok: false, reason }, { status });
      const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!raw || typeof raw.key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.key_hash)) return bad('Invalid identity', 401);
      const index = this.data.world.muses.findIndex(m => m.name === raw.muse);
      if (index < 0) return bad('Unknown muse');
      const validated = path === '/action' ? validateAction(this.data.world.muses[index], raw.action, raw.params) : { ok: true as const, value: null };
      if (validated.ok === false) return bad(validated.reason);
      await this.flush();
      const now = Date.now();
      for (const [key, budget] of Object.entries(this.data.budgets)) {
        budget.actions = budget.actions.filter(t => t > now - 60000); budget.says = budget.says.filter(t => t > now - 60000);
        if (!budget.actions.length) delete this.data.budgets[key];
      }
      const budget = this.data.budgets[raw.key_hash] || { actions: [], says: [] };
      if (budget.actions.length >= 10 || ((raw.action === 'say' || (path === '/buy' && raw.item === 'crier')) && budget.says.length >= 2)) return bad('Rate limit exceeded; retry after one minute', 429);
      if (path !== '/action') {
        const error = await this.economicAction(path, raw, this.data.world.muses[index]);
        if (error) return bad(error);
      } else if (validated.value?.kind === 'interact' && validated.value.claim) {
        this.data.claims!.push({ muse: this.data.world.muses[index].name, poi: validated.value.poi });
      }
      budget.actions.push(now); if (raw.action === 'say' || (path === '/buy' && raw.item === 'crier')) budget.says.push(now);
      this.data.budgets[raw.key_hash] = budget;
      await this.pioneer(this.data.world.muses[index].name);
      if (path !== '/action') { this.data.closing = true; await this.flush(); this.broadcast(); return Response.json({ ok: true }); }
      const muse = applyAction(this.data.world.muses[index], validated.value!, this.data.world.clock);
      this.data.world.muses[index] = muse;
      const { kind, ...params } = validated.value!;
      if (kind !== 'interact') this.recordKind(muse.name, kind);
      // Paths and credential hashes are private and never enter the public ledger.
      delete (params as { path?: Point[] }).path;
      await this.append({ kind: kind === 'say' ? 'say' : 'action', muse: muse.name, payload: { source: 'drop-in', action: kind, ...params } });
      // Acknowledged drop-ins survive eviction; ambient-only state is checkpointed per turn.
      await this.checkpoint(); this.broadcast();
      return Response.json({ ok: true });
    });
  }
}
