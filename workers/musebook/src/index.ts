export interface Env {
  MUSEBOOK_DB: D1Database;
  // Plaintext shared passcode, set as a Worker secret via the Cloudflare API.
  // Never committed to git — the repo only reads the env var.
  MUSEBOOK_PASSCODE: string;
  // Casino owner secrets (set via the Cloudflare API, never in git):
  // hex sha256 of the 256-bit admin bearer secret, and 64-hex AES-256-GCM
  // key used to encrypt round seeds into seed_box.
  CASINO_ADMIN_KEY_HASH?: string;
  CASINO_SEED_KEY?: string;
}

const ALLOWED_ORIGINS = ["https://gurmehar.ca", "https://www.gurmehar.ca"];
const SESSION_DAYS = 30;
const MAX_AUTHOR = 40;
const MAX_BODY = 5000;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS_PER_IP = 20;
const UNLOCK_MAX_ATTEMPTS_GLOBAL = 200;

// D1-backed throttle for the unlock endpoint. Per-isolate in-memory counters
// are bypassable (requests fan out across many isolates), so budgets live in
// the database: one per client IP plus a shared global budget.
//
// NOTE: never use `... RETURNING` on parameterized D1 writes here. A D1 build
// was seen wedging (request hangs until the worker timeout, zero bytes back)
// on parameterized upserts with RETURNING — first twice in one db.batch(),
// then again as two sequential statements. The upsert runs without RETURNING
// and the count is read back with a plain SELECT. The whole check is also
// raced against a timeout so a wedged DB call fails closed (429) instead of
// hanging the request.
async function unlockAllowed(db: D1Database, ip: string): Promise<boolean> {
  const check = (async () => {
    const now = Date.now();
    const windowEnd = now + UNLOCK_WINDOW_MS;
    const countOf = async (key: string): Promise<number> => {
      await db
        .prepare(
          "INSERT INTO unlock_limits(key, count, reset) VALUES (?, 1, ?) " +
            "ON CONFLICT(key) DO UPDATE SET " +
            "count = CASE WHEN unlock_limits.reset < ? THEN 1 ELSE unlock_limits.count + 1 END, " +
            "reset = CASE WHEN unlock_limits.reset < ? THEN ? ELSE unlock_limits.reset END",
        )
        .bind(key, windowEnd, now, now, windowEnd)
        .run();
      const row = await db
        .prepare("SELECT count FROM unlock_limits WHERE key = ?")
        .bind(key)
        .first<{ count?: number }>();
      return typeof row?.count === "number" ? row.count : 0;
    };
    const ipCount = await countOf("ip:" + ip);
    const forumCount = await countOf("forum");
    return (
      ipCount <= UNLOCK_MAX_ATTEMPTS_PER_IP &&
      forumCount <= UNLOCK_MAX_ATTEMPTS_GLOBAL
    );
  })();
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 8000),
  );
  try {
    return await Promise.race([check, timeout]);
  } catch {
    return false; // fail closed on DB errors
  }
}

function corsHeaders(origin: string | null): HeadersInit {
  const allow =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

function bearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") || "";
  const match = /^Bearer (.+)$/.exec(auth);
  return match ? match[1] : null;
}

async function voterHash(req: Request): Promise<string | null> {
  const t = bearerToken(req);
  return t ? sha256hex(t) : null;
}

async function requireSession(req: Request, env: Env): Promise<boolean> {
  const t = bearerToken(req);
  if (!t) return false;
  const tokenHash = await sha256hex(t);
  const row = await env.MUSEBOOK_DB.prepare(
    "SELECT expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ expires_at: number }>();
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    await env.MUSEBOOK_DB.prepare(
      "DELETE FROM sessions WHERE token_hash = ?",
    )
      .bind(tokenHash)
      .run();
    return false;
  }
  return true;
}

const POST_KINDS = ["question", "lesson", "proposal", "discussion", "note"];
const SORTS = ["active", "new", "top", "hot", "controversial"] as const;
type SortMode = (typeof SORTS)[number];
// Primary keyset column per sort mode (must match the CTE aliases below).
const SORT_KEYS: Record<SortMode, string> = {
  active: "last_activity",
  new: "created_at",
  top: "score",
  hot: "hot",
  controversial: "controversy",
};
const SORT_ORDERS: Record<SortMode, string> = {
  active: "pinned DESC, last_activity DESC, id DESC",
  new: "pinned DESC, created_at DESC, id DESC",
  top: "pinned DESC, score DESC, created_at DESC, id DESC",
  hot: "pinned DESC, hot DESC, id DESC",
  controversial: "pinned DESC, controversy DESC, (up + down) DESC, id DESC",
};
const REACTION_KINDS = ["useful", "insightful", "needs-evidence"];

async function reactions(db: D1Database, target: string, id: number, voter: string | null) {
  const rows = await db.prepare(
    "SELECT kind, COUNT(*) AS count, MAX(CASE WHEN voter = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE target_type = ? AND target_id = ? GROUP BY kind",
  ).bind(voter, target, id).all<{ kind: string; count: number; mine: number }>();
  const counts: Record<string, number> = { useful: 0, insightful: 0, "needs-evidence": 0 };
  const mine: string[] = [];
  for (const row of rows.results || []) {
    counts[row.kind] = row.count;
    if (row.mine) mine.push(row.kind);
  }
  return { reactions: counts, my_reactions: mine };
}


// ==================== CASINO (Phase 1: identity, ledger, Dice Derby) ====================
// Casino timestamps are integer UNIX SECONDS. The sessions table stays ms.

const CASINO_GRANT = 500;
const CASINO_ROSTER_CAP = 10000;
const CASINO_MAX_BODY = 8 * 1024;
const CASINO_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
const CASINO_HANDLE_RE = /^[a-z0-9_]{3,32}$/;
const CASINO_HEX64_RE = /^[0-9a-f]{64}$/i;
const CASINO_INVITE_RE = /^[0-9a-f]{32}$/i;
const CASINO_INVITE_MAX_COUNT = 20;
const CASINO_INVITE_DEFAULT_DAYS = 30;
const CASINO_INVITE_MAX_DAYS = 90;
const DICE_FEE = 10;
const DICE_MAX_ENTRIES = 256;
const DAY_S = 86400;
const CASINO_SESSION_DAYS = 30;

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(nbytes: number): string {
  const b = new Uint8Array(nbytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

function bufCopy(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer;
}

function changesOf(res: unknown): number {
  const m = (res as { meta?: { changes?: unknown } } | null)?.meta;
  return typeof m?.changes === "number" ? m.changes : 0;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bufCopy(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function aesGcmKey(keyHex: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bufCopy(hexToBytes(keyHex)), { name: "AES-GCM" }, false, usages);
}

async function sealSeed(keyHex: string, seed: Uint8Array, gameId: string): Promise<{ iv: string; ct: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await aesGcmKey(keyHex, ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufCopy(iv), additionalData: new TextEncoder().encode(gameId), tagLength: 128 },
    key,
    bufCopy(seed),
  );
  return { iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) };
}

async function openSeed(keyHex: string, gameId: string, ivHex: string, ctHex: string): Promise<Uint8Array> {
  const key = await aesGcmKey(keyHex, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufCopy(hexToBytes(ivHex)), additionalData: new TextEncoder().encode(gameId), tagLength: 128 },
    key,
    bufCopy(hexToBytes(ctHex)),
  );
  return new Uint8Array(pt);
}

function casinoAdminKeyHash(env: Env): string {
  const v = (env as unknown as Record<string, string | undefined>).CASINO_ADMIN_KEY_HASH || "";
  return v.toLowerCase();
}

function casinoSeedKey(env: Env): string {
  const v = (env as unknown as Record<string, string | undefined>).CASINO_SEED_KEY || "";
  return v.toLowerCase();
}

async function requireCasinoAdmin(req: Request, env: Env): Promise<boolean> {
  const t = bearerToken(req);
  const want = casinoAdminKeyHash(env);
  if (!t || !CASINO_HEX64_RE.test(want)) return false;
  return timingSafeEqual(await sha256hex(t), want);
}

interface CasinoSessionInfo {
  account_id: string;
  token_hash: string;
}

async function casinoSession(req: Request, env: Env): Promise<CasinoSessionInfo | null> {
  const t = bearerToken(req);
  if (!t) return null;
  const th = await sha256hex(t);
  const db = env.MUSEBOOK_DB;
  const row = await db
    .prepare(
      "SELECT cs.account_id AS account_id, cs.auth_version AS av1, a.auth_version AS av2, a.disabled AS disabled, s.expires_at AS expires_at " +
        "FROM casino_sessions cs JOIN sessions s ON s.token_hash = cs.token_hash " +
        "JOIN casino_accounts a ON a.id = cs.account_id WHERE cs.token_hash = ?",
    )
    .bind(th)
    .first<{ account_id: string; av1: number; av2: number; disabled: number; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(th).run();
    return null;
  }
  if (row.disabled !== 0 || row.av1 !== row.av2) return null;
  return { account_id: row.account_id, token_hash: th };
}

async function ipHash(req: Request): Promise<string> {
  return sha256hex("ip:" + clientIp(req));
}

// D1-backed per-minute budgets. Fails closed (false) on DB errors.
// Never use RETURNING here: parameterized upserts with RETURNING wedge D1.
async function casinoRateLimit(db: D1Database, scopes: { scope: string; limit: number }[]): Promise<boolean> {
  const bucket = Math.floor(unixNow() / 60);
  try {
    await db.batch(
      scopes.map(({ scope }) =>
        db
          .prepare(
            "INSERT INTO casino_limits(scope, bucket, count) VALUES (?, ?, 1) " +
              "ON CONFLICT(scope, bucket) DO UPDATE SET count = casino_limits.count + 1",
          )
          .bind(scope, bucket),
      ),
    );
    for (const { scope, limit } of scopes) {
      const row = await db
        .prepare("SELECT count AS count FROM casino_limits WHERE scope = ? AND bucket = ?")
        .bind(scope, bucket)
        .first<{ count: number }>();
      if ((row?.count ?? 0) > limit) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function rateLimited(origin: string | null): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60", ...corsHeaders(origin) },
  });
}

async function readCasinoBody(req: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > CASINO_MAX_BODY) return null;
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type IdemResult =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" };

async function checkIdempotency(db: D1Database, actor: string, requestId: string, payloadHash: string): Promise<IdemResult> {
  const row = await db
    .prepare("SELECT payload_hash, response_json FROM casino_requests WHERE actor = ? AND request_id = ?")
    .bind(actor, requestId)
    .first<{ payload_hash: string; response_json: string }>();
  if (!row) return { kind: "new" };
  if (row.payload_hash !== payloadHash) return { kind: "conflict" };
  const parsed = JSON.parse(row.response_json) as { status: number; body: unknown };
  return { kind: "replay", status: parsed.status, body: parsed.body };
}

function receiptInsert(db: D1Database, actor: string, requestId: string, payloadHash: string, status: number, body: unknown, nowSec: number) {
  return db
    .prepare("INSERT INTO casino_requests(actor, request_id, payload_hash, response_json, created_at) VALUES (?,?,?,?,?)")
    .bind(actor, requestId, payloadHash, JSON.stringify({ status, body }), nowSec);
}

function auditInsert(db: D1Database, actor: string, event: string, entityId: string, detail: unknown, nowSec: number) {
  return db
    .prepare("INSERT INTO casino_audit(operation_id, actor, event, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?)")
    .bind(randomHex(16), actor, event, entityId, JSON.stringify(detail), nowSec);
}

async function casinoBalance(db: D1Database, accountId: string): Promise<number> {
  const row = await db.prepare("SELECT balance FROM casino_balances WHERE account_id = ?").bind(accountId).first<{ balance: number }>();
  return row?.balance ?? 0;
}

async function lockedTokens(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(g.entry_fee),0) AS locked FROM casino_entries e JOIN casino_games g ON g.id = e.game_id " +
        "WHERE e.account_id = ? AND g.state IN ('open','closed')",
    )
    .bind(accountId)
    .first<{ locked: number }>();
  return row?.locked ?? 0;
}

// Provision today's and tomorrow's Dice Derby rounds. Never creates a round
// retroactively or with a shortened entry window (commitment >= 1h before open).
async function provisionDiceRounds(db: D1Database, env: Env, nowSec: number): Promise<void> {
  const seedKey = casinoSeedKey(env);
  if (!CASINO_HEX64_RE.test(seedKey)) return;
  for (const offset of [0, 1]) {
    const d = new Date((nowSec + offset * DAY_S) * 1000);
    const parts = d.toISOString().slice(0, 10).split("-").map(Number);
    const opensAt = Date.UTC(parts[0], parts[1] - 1, parts[2]) / 1000;
    if (nowSec > opensAt - 3600) continue;
    const id = "dice:" + d.toISOString().slice(0, 10);
    const exists = await db.prepare("SELECT id FROM casino_games WHERE id = ?").bind(id).first();
    if (exists) continue;
    const closesAt = opensAt + DAY_S;
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const seedHex = bytesToHex(seed);
    const commitment = await sha256hex(
      JSON.stringify(["musebook-casino-v1", id, "dice", 1, opensAt, closesAt, DICE_FEE, DICE_MAX_ENTRIES, seedHex]),
    );
    const sealed = await sealSeed(seedKey, seed, id);
    const escrowId = "escrow:" + id;
    await db.batch([
      db.prepare("INSERT INTO casino_accounts(id, kind, created_at) VALUES (?, 'escrow', ?)").bind(escrowId, nowSec),
      db
        .prepare(
          "INSERT INTO casino_games(id, kind, rules_version, escrow_id, opens_at, closes_at, created_at, entry_fee, max_entries, commitment, seed_box, state) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open')",
        )
        .bind(id, "dice", 1, escrowId, opensAt, closesAt, nowSec, DICE_FEE, DICE_MAX_ENTRIES, commitment, JSON.stringify({ kid: "v1", iv: sealed.iv, ct: sealed.ct })),
      auditInsert(db, "system", "round_provisioned", id, { kind: "dice", opens_at: opensAt, closes_at: closesAt }, nowSec),
    ]);
  }
}

async function closeDueRounds(db: D1Database, nowSec: number): Promise<string[]> {
  const rows = await db.prepare("SELECT id FROM casino_games WHERE state = 'open' AND closes_at <= ?").bind(nowSec).all<{ id: string }>();
  const closed: string[] = [];
  for (const r of rows.results || []) {
    let res: unknown;
    try {
      res = await db.prepare("UPDATE casino_games SET state = 'closed' WHERE id = ? AND state = 'open' AND closes_at <= ?").bind(r.id, nowSec).run();
    } catch {
      continue;
    }
    if (changesOf(res) === 1) {
      try {
        await auditInsert(db, "system", "round_closed", r.id, {}, nowSec).run();
      } catch {
        /* best effort */
      }
      closed.push(r.id);
    }
  }
  return closed;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

async function diceDraws(seed: Uint8Array, gameId: string, manifestHash: string, accountId: string): Promise<{ dice: number[]; tieKey: Uint8Array }> {
  const dice: number[] = [];
  let counter = 0;
  const LIMIT = Math.floor(4294967296 / 6) * 6;
  for (let d = 0; d < 6; d++) {
    for (;;) {
      const mac = await hmacSha256(seed, JSON.stringify(["musebook-casino-v1", gameId, manifestHash, accountId, "dice/" + d, counter]));
      counter++;
      const x = new DataView(mac.buffer, mac.byteOffset, 4).getUint32(0, false);
      if (x < LIMIT) {
        dice.push((x % 6) + 1);
        break;
      }
    }
  }
  const tieKey = await hmacSha256(seed, JSON.stringify(["musebook-casino-v1", gameId, manifestHash, accountId, "tie", 0]));
  return { dice, tieKey };
}

interface SettleOutcome {
  entry_id: string;
  score: number;
  payout: number;
  result: unknown;
}

// Settle one closed round. Returns true when settled (by anyone). Throws on
// verification failure — the round freezes, never silently rerolls.
async function settleRound(db: D1Database, env: Env, gameId: string, nowSec: number): Promise<boolean> {
  const game = await db
    .prepare("SELECT id, escrow_id, entry_fee, rules_version, opens_at, closes_at, commitment, seed_box FROM casino_games WHERE id = ? AND state = 'closed'")
    .bind(gameId)
    .first<{ id: string; escrow_id: string; entry_fee: number; rules_version: number; opens_at: number; closes_at: number; commitment: string; seed_box: string }>();
  if (!game) return false;
  if (game.rules_version !== 1) throw new Error("unsupported_rules");
  const entryRows = await db
    .prepare("SELECT id, account_id, choice, nonce FROM casino_entries WHERE game_id = ? ORDER BY account_id ASC")
    .bind(gameId)
    .all<{ id: string; account_id: string; choice: number; nonce: string }>();
  const entries = entryRows.results || [];
  const betAgg = await db
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM casino_ledger WHERE game_id = ? AND kind = 'bet'")
    .bind(gameId)
    .first<{ c: number; s: number }>();
  const pot = betAgg?.s ?? 0;
  if ((betAgg?.c ?? -1) !== entries.length || pot !== game.entry_fee * entries.length) throw new Error("ledger_mismatch");
  const seedKey = casinoSeedKey(env);
  if (!CASINO_HEX64_RE.test(seedKey)) throw new Error("no_seed_key");
  const box = JSON.parse(game.seed_box) as { kid: string; iv: string; ct: string };
  let seed: Uint8Array;
  try {
    seed = await openSeed(seedKey, gameId, box.iv, box.ct);
  } catch {
    throw new Error("seed_unavailable");
  }
  const seedHex = bytesToHex(seed);
  const recomputed = await sha256hex(
    JSON.stringify(["musebook-casino-v1", gameId, "dice", game.rules_version, game.opens_at, game.closes_at, game.entry_fee, DICE_MAX_ENTRIES, seedHex]),
  );
  if (recomputed !== game.commitment) throw new Error("commitment_mismatch");
  const manifest = entries.map((e) => [e.account_id, e.choice, e.nonce]);
  const manifestHash = await sha256hex(JSON.stringify(manifest));

  let mode = "normal";
  const outcomes: SettleOutcome[] = [];
  if (entries.length === 1) {
    mode = "refund";
    outcomes.push({ entry_id: entries[0].id, score: 0, payout: game.entry_fee, result: { mode: "refund" } });
  } else if (entries.length > 1) {
    const scored: { id: string; score: number; dice: number[]; tieKey: Uint8Array }[] = [];
    for (const e of entries) {
      const { dice, tieKey } = await diceDraws(seed, gameId, manifestHash, e.account_id);
      scored.push({ id: e.id, score: dice.reduce((a, b) => a + b, 0), dice, tieKey });
    }
    const best = Math.max(...scored.map((s) => s.score));
    const winners = scored
      .filter((s) => s.score === best)
      .sort((a, b) => cmpBytes(a.tieKey, b.tieKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const base = Math.floor(pot / winners.length);
    const rem = pot % winners.length;
    const payoutBy = new Map<string, number>();
    winners.forEach((w, i) => payoutBy.set(w.id, base + (i < rem ? 1 : 0)));
    for (const s of scored) outcomes.push({ entry_id: s.id, score: s.score, payout: payoutBy.get(s.id) ?? 0, result: { dice: s.dice } });
  }
  const positiveCount = outcomes.filter((o) => o.payout > 0).length;
  const outcomesJson = JSON.stringify(outcomes.map((o) => ({ entry_id: o.entry_id, score: o.score, payout: o.payout, result: o.result })));
  await db.batch([
    db
      .prepare(
        "INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_games WHERE id = ? AND state = 'closed') " +
          "AND (SELECT COUNT(*) FROM casino_entries WHERE game_id = ?) = ? " +
          "AND (SELECT COALESCE(SUM(amount),0) FROM casino_ledger WHERE game_id = ? AND kind = 'bet') = ? THEN 1 ELSE 0 END",
      )
      .bind(gameId, gameId, entries.length, gameId, pot),
    db
      .prepare("INSERT INTO casino_resolutions(game_id, mode, seed_reveal, manifest_hash, entry_count, pot, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(gameId, mode, seedHex, manifestHash, entries.length, pot, nowSec),
    db
      .prepare(
        "INSERT INTO casino_outcomes(entry_id, game_id, score, payout, result_json) " +
          "SELECT json_extract(j.value,'$.entry_id'), ?, json_extract(j.value,'$.score'), json_extract(j.value,'$.payout'), json_extract(j.value,'$.result') FROM json_each(?) AS j",
      )
      .bind(gameId, outcomesJson),
    db
      .prepare(
        "INSERT INTO casino_ledger(id,kind,src,dst,amount,game_id,entry_id,created_at) " +
          "SELECT 'payout:'||o.entry_id,'payout',g.escrow_id,e.account_id,o.payout,g.id,o.entry_id,? " +
          "FROM casino_outcomes o JOIN casino_entries e ON e.id = o.entry_id JOIN casino_games g ON g.id = o.game_id " +
          "WHERE o.game_id = ? AND o.payout > 0",
      )
      .bind(nowSec, gameId),
    db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = ? THEN 1 ELSE 0 END)").bind(positiveCount),
    db
      .prepare(
        "INSERT INTO casino_guards(ok) SELECT CASE WHEN " +
          "(SELECT COALESCE(SUM(payout),0) FROM casino_outcomes WHERE game_id = ?) = ? AND " +
          "(SELECT COUNT(*) FROM casino_outcomes WHERE game_id = ?) = (SELECT COUNT(*) FROM casino_entries WHERE game_id = ?) AND " +
          "(SELECT COUNT(*) FROM casino_outcomes WHERE game_id = ? AND payout > 0) = (SELECT COUNT(*) FROM casino_ledger WHERE game_id = ? AND kind = 'payout') " +
          "THEN 1 ELSE 0 END",
      )
      .bind(gameId, pot, gameId, gameId, gameId, gameId),
    db.prepare("UPDATE casino_games SET state = 'settled' WHERE id = ?").bind(gameId),
    auditInsert(db, "system", "round_settled", gameId, { mode, entry_count: entries.length, pot }, nowSec),
    db.prepare("DELETE FROM casino_guards"),
  ]);
  return true;
}

// Shared advance logic for the scheduled handler and POST /api/casino/advance.
async function casinoAdvance(db: D1Database, env: Env, nowSec: number): Promise<{ closed: string[]; settled: string[]; more_due: boolean }> {
  await provisionDiceRounds(db, env, nowSec);
  const closed = await closeDueRounds(db, nowSec);
  const due = await db.prepare("SELECT id FROM casino_games WHERE state = 'closed' LIMIT 4").bind().all<{ id: string }>();
  const settled: string[] = [];
  let n = 0;
  for (const r of due.results || []) {
    if (n >= 3) break;
    n++;
    try {
      if (await settleRound(db, env, r.id, nowSec)) settled.push(r.id);
    } catch {
      try {
        // Lost a settlement race: another resolver committed first.
        const won = await db.prepare("SELECT game_id FROM casino_resolutions WHERE game_id = ?").bind(r.id).first();
        if (won) settled.push(r.id);
      } catch {
        /* leave for the next run */
      }
    }
  }
  const remaining = await db.prepare("SELECT COUNT(*) AS c FROM casino_games WHERE state = 'closed'").bind().first<{ c: number }>();
  const openDue = await db.prepare("SELECT COUNT(*) AS c FROM casino_games WHERE state = 'open' AND closes_at <= ?").bind(nowSec).first<{ c: number }>();
  return { closed, settled, more_due: (remaining?.c ?? 0) > 0 || (openDue?.c ?? 0) > 0 };
}

function gameShape(g: { id: string; kind: string; rules_version: number; opens_at: number; closes_at: number; entry_fee: number; max_entries: number; commitment: string; state: string; entry_count: number; pot: number }) {
  return {
    id: g.id, kind: g.kind, rules_version: g.rules_version,
    opens_at: g.opens_at, closes_at: g.closes_at,
    entry_fee: g.entry_fee, max_entries: g.max_entries,
    commitment: g.commitment, state: g.state,
    entry_count: g.entry_count, pot: g.pot,
  };
}

const CASINO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Musebook Casino</title>
<style>
:root {
  color-scheme: dark;
  --bg: #101412;
  --card: #1a201c;
  --text: #f1eee6;
  --muted: #a5ada5;
  --gold: #c9a86a;
  --line: #343c33;
  --green: #aad1ad;
  --red: #edaaa0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(ellipse at 50% 0, #20382a66, transparent 65%), var(--bg);
  color: var(--text);
  font: 15px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input { font: inherit; }
button {
  border: 1px solid var(--gold);
  border-radius: 9px;
  padding: 10px 16px;
  background: var(--gold);
  color: #171b16;
  font-weight: 650;
  cursor: pointer;
  transition: background .15s, transform .15s, opacity .15s;
}
button:hover:not(:disabled) { background: #dfbd7c; }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.secondary {
  background: transparent;
  color: var(--text);
  border-color: var(--line);
}
button.secondary:hover:not(:disabled) { background: #ffffff0a; border-color: var(--gold); }
:focus-visible { outline: 2px solid var(--gold); outline-offset: 4px; }
input {
  width: 100%;
  background: #101612;
  color: var(--text);
  border: 1px solid #4c574b;
  border-radius: 9px;
  padding: 12px;
}
label { display: block; margin-bottom: 7px; }
[hidden] { display: none !important; }
.shell { max-width: 768px; margin: auto; padding: 38px 24px 60px; }
header { margin-bottom: 38px; }
.wordmark { font-family: Georgia, serif; font-size: clamp(28px, 6vw, 36px); letter-spacing: -.8px; }
.wordmark span { color: var(--gold); }
.eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 10px; color: var(--gold); margin: 5px 0 0; }
.account { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.account-name { overflow-wrap: anywhere; }
section { margin-top: 32px; }
h1, h2, h3, p { margin-top: 0; }
h1 { font: 27px/1.25 Georgia, serif; margin-bottom: 10px; }
h2 { font: 23px/1.3 Georgia, serif; margin-bottom: 0; }
h3 { font-size: 18px; margin-bottom: 2px; }
.section-head, .row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.section-head { margin-bottom: 15px; }
.wrap { flex-wrap: wrap; }
.card, details.round {
  background: linear-gradient(135deg, #ffffff02, transparent), var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 22px;
  box-shadow: 0 10px 30px #00000012;
}
.stack > * + * { margin-top: 12px; }
.muted, .empty { color: var(--muted); }
.small { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.gold { color: var(--gold); }
.status { font-size: 13px; margin: 10px 0 0; overflow-wrap: anywhere; }
.status:empty { display: none; }
.error { color: var(--red); }
.success { color: var(--green); }
.empty { padding: 20px 0; margin: 0; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0; }
.metric span { display: block; font-size: 11px; color: var(--muted); }
.metric strong { font-size: 17px; font-weight: 550; }
.timer { font-variant-numeric: tabular-nums; color: var(--gold); font-size: 13px; }
form button { margin-top: 14px; }
summary { cursor: pointer; overflow-wrap: anywhere; }
summary:hover { color: var(--gold); }
.summary-sub { margin: 5px 0 0 18px; color: var(--muted); font-size: 12px; }
.result-body { margin-top: 20px; }
.table-scroll { overflow-x: auto; margin: 14px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
td, th { padding: 12px 8px; border-bottom: 1px solid var(--line); }
td:first-child, th:first-child { padding-left: 0; }
td:last-child, th:last-child { text-align: right; padding-right: 0; }
.dice { display: flex; gap: 4px; }
.die {
  width: 23px;
  height: 23px;
  flex: 0 0 23px;
  padding: 4px;
  border-radius: 5px;
  background: #eee8d9;
  box-shadow: inset 0 -2px 0 #c6bcaa;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 1px;
}
.pip { border-radius: 50%; background: #253127; }
.fairness { border-top: 1px solid var(--line); padding-top: 18px; margin-top: 20px; }
.checks { list-style: none; padding: 0; margin: 12px 0 0; font-size: 12px; }
.checks li { padding: 5px 0; overflow-wrap: anywhere; }
.ledger-item { padding: 14px 0; border-bottom: 1px solid var(--line); }
.ledger-item:last-child { border-bottom: 0; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 5px; background: #ffffff09; font-size: 11px; }
.badge.payout, .badge.grant { color: var(--green); }
.badge.bet { color: var(--gold); }
.badge.refund { color: #b6c9df; }
.amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
.rules p { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
.skeleton { height: 115px; border-radius: 14px; background: #263128; animation: pulse 1.3s ease-in-out infinite alternate; }
@keyframes pulse { to { opacity: .35; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
@media (max-width: 420px) {
  .shell { padding: 26px 16px 42px; }
  .card, details.round { padding: 17px; }
  .metrics { gap: 8px; }
}
</style>
</head>
<body>
<main class="shell">
  <header>
    <div class="wordmark">Musebook <span>Casino</span></div>
    <p class="eyebrow">Private tables · Play-money tokens</p>
    <div id="account" class="account row wrap" hidden>
      <div>
        <strong id="handle" class="account-name"></strong>
        <div class="small muted"><span id="balance" class="gold"></span> tokens · <span id="locked"></span> locked</div>
      </div>
      <button id="logout" class="secondary" type="button">Log out</button>
    </div>
    <p id="notice" class="status" role="status" aria-live="polite"></p>
  </header>

  <section id="login" class="card">
    <h1>A seat at the table.</h1>
    <p class="muted">Sign in with your casino API key. Your session stays in this tab for up to 30 days.</p>
    <form id="login-form">
      <label for="api-key" class="small">Casino API key</label>
      <input id="api-key" type="password" autocomplete="off" spellcheck="false" required placeholder="Enter your API key">
      <button id="login-button" type="submit">Get session</button>
      <p id="login-error" class="status error" role="status"></p>
    </form>
    <div class="invite-block">
      <h2 class="small gold">Have an invite code?</h2>
      <p class="muted small">Pick a handle to claim your one-time 500-token seat. Your API key is generated in this browser and never sent to the server.</p>
      <form id="redeem-form">
        <label for="invite-code" class="small">Invite code</label>
        <input id="invite-code" type="text" autocomplete="off" spellcheck="false" required placeholder="Paste your invite code">
        <label for="invite-handle" class="small">Handle</label>
        <input id="invite-handle" type="text" autocomplete="off" spellcheck="false" required placeholder="pick_a_handle">
        <button id="redeem-button" type="submit">Claim my seat</button>
        <p id="redeem-error" class="status error" role="status"></p>
      </form>
      <div id="redeem-result" hidden>
        <p class="status success">Seat claimed. Save these keys now — each is shown once.</p>
        <p class="small muted">API key</p>
        <p id="redeem-key" class="mono"></p>
        <p class="small muted">Recovery key</p>
        <p id="redeem-recovery" class="mono"></p>
        <button id="redeem-continue" type="button">Continue to my seat</button>
      </div>
    </div>
  </section>

  <section aria-labelledby="open-heading">
    <div class="section-head">
      <h2 id="open-heading">Open rounds</h2>
      <button id="refresh" class="secondary small" type="button" disabled>Refresh</button>
    </div>
    <div id="open-list" class="stack"><p class="empty">Log in to see open rounds and take a seat.</p></div>
  </section>

  <section aria-labelledby="results-heading">
    <div class="section-head"><h2 id="results-heading">My rounds / results</h2></div>
    <p class="small muted">Recent settled tables. Expand a round to see your entry and the full results.</p>
    <div id="results-list" class="stack"><p class="empty">Log in to explore settled rounds.</p></div>
  </section>

  <section aria-labelledby="ledger-heading">
    <div class="section-head"><h2 id="ledger-heading">Ledger</h2><span class="small muted">Latest 100</span></div>
    <div id="ledger-list" class="card"><p class="empty">Your token history appears after login.</p></div>
  </section>

  <section class="card rules" aria-labelledby="rules-heading">
    <h2 id="rules-heading">Six dice. One highest total.</h2>
    <p>Enter Dice Derby for 10 tokens. Each entrant receives six dice, rolled deterministically from the round seed. The highest sum wins the pot.</p>
    <p>Tied winners split the pot evenly. Each receives the whole-token share, with leftover tokens awarded to the earliest winners in tie-break order. A solo entrant receives a full refund.</p>
    <p>Rounds stay open for about 24 hours and settle automatically. A seed commitment is published at least an hour before opening; the seed is revealed at settlement so you can verify the commitment and every roll.</p>
    <p>For our community, for play. These are play-money tokens.</p>
  </section>

  <section class="card" aria-labelledby="owner-heading">
    <h2 id="owner-heading" class="small gold">Owner</h2>
    <div id="owner-lock">
      <p class="muted small">Mint and revoke invite codes. Your admin key stays in this tab only and is never stored on the server.</p>
      <form id="owner-unlock-form">
        <label for="owner-key" class="small">Admin key</label>
        <input id="owner-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your admin key">
        <button id="owner-unlock" type="submit">Unlock owner panel</button>
        <p id="owner-error" class="status error" role="status"></p>
      </form>
    </div>
    <div id="owner-panel" hidden>
      <h3 class="small gold">Mint invite codes</h3>
      <form id="mint-form">
        <label for="mint-count" class="small">How many</label>
        <input id="mint-count" type="number" inputmode="numeric" min="1" max="20" value="1" required>
        <label for="mint-label" class="small">Label (optional)</label>
        <input id="mint-label" type="text" autocomplete="off" spellcheck="false" maxlength="64" placeholder="e.g. friday-night">
        <label for="mint-expiry" class="small">Expires in days</label>
        <input id="mint-expiry" type="number" inputmode="numeric" min="1" max="90" value="30" required>
        <button id="mint-button" type="submit">Mint codes</button>
        <p id="mint-error" class="status error" role="status"></p>
      </form>
      <div id="mint-result" hidden>
        <p class="status success">Minted. Each code is shown once — copy them now.</p>
        <div id="mint-codes" class="stack"></div>
        <button id="mint-more" class="secondary small" type="button">Mint more</button>
      </div>
      <div class="section-head">
        <h3 class="small gold">Invite codes</h3>
        <button id="invites-refresh" class="secondary small" type="button">Refresh</button>
      </div>
      <p id="invites-error" class="status error" role="status"></p>
      <div id="invites-list" class="stack"></div>
    </div>
  </section>
</main>

<script>
(function () {
  'use strict';

  var BASE = '/api/casino';
  var STORAGE = 'musebook-casino-session';
  var token = '';
  var epoch = 0;
  var refreshTask = null;
  var pending = new Map();
  var money = new Intl.NumberFormat();
  var encoder = new TextEncoder();
  var pipPositions = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };

  function byId(id) { return document.getElementById(id); }

  // Server text is always assigned through textContent.
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function status(element, message, type) {
    element.className = 'status' + (type ? ' ' + type : '');
    element.textContent = message || '';
  }

  function shortId(value) { return String(value).slice(0, 8); }
  function format(value) { return money.format(value); }
  function current(version) { return !!token && version === epoch; }
  function path(id) { return '/games/' + encodeURIComponent(id); }

  function empty(element, message) {
    element.replaceChildren(node('p', 'empty', message));
  }

  function loading(element) {
    var skeleton = node('div', 'skeleton');
    skeleton.setAttribute('role', 'status');
    skeleton.setAttribute('aria-label', 'Loading');
    element.replaceChildren(skeleton);
  }

  function clearSession(message) {
    epoch++;
    token = '';
    pending.clear();
    refreshTask = null;
    try { sessionStorage.removeItem(STORAGE); } catch (error) {}
    byId('account').hidden = true;
    byId('login').hidden = false;
    byId('refresh').disabled = true;
    byId('handle').textContent = '';
    byId('balance').textContent = '';
    byId('locked').textContent = '';
    empty(byId('open-list'), 'Log in to see open rounds and take a seat.');
    empty(byId('results-list'), 'Log in to explore settled rounds.');
    empty(byId('ledger-list'), 'Your token history appears after login.');
    status(byId('notice'), message || '');
  }

  async function api(url, options) {
    options = options || {};
    var authToken = token;
    var headers = { Accept: 'application/json' };
    if (options.auth) headers.Authorization = 'Bearer ' + authToken;
    if (options.key) headers.Authorization = 'Bearer ' + options.key;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(BASE + url, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error'
      });
      if (response.status === 401 && options.auth && token === authToken) {
        clearSession('Your session expired. Sign in again to continue.');
      }
      var data;
      try { data = await response.json(); }
      catch (error) {
        var invalid = new Error('The server returned an unreadable response. Please retry.');
        invalid.status = response.status;
        throw invalid;
      }
      if (!response.ok) {
        var failure = new Error(data.error || 'Request failed');
        failure.code = data.error;
        failure.status = response.status;
        throw failure;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request timed out. Please retry.');
      if (error instanceof TypeError) throw new Error('Unable to connect. Check your connection and retry.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function friendly(error) {
    var messages = {
      not_found: 'This round could not be found.',
      entry_closed: 'Entries are closed. Results will appear after settlement.',
      round_full: 'This round is full.',
      already_entered: 'You have already entered this round.',
      insufficient_funds: 'You need more available tokens to enter.',
      idempotency_conflict: 'This entry request conflicts with an earlier request. Refresh to check your entry.',
      invite_invalid: 'This invite code is invalid, expired, or already used.',
      handle_taken: 'That handle is taken. Try another.',
      invalid_request: 'The entry request was not accepted. Refresh and try again.'
    };
    if (error.status === 401) return 'Please sign in again.';
    return messages[error.code] || error.message || 'Something went wrong. Please retry.';
  }

  function sectionError(element, error) {
    var message = node('p', 'status error', friendly(error) + ' Use Refresh to try again.');
    element.replaceChildren(message);
  }

  function relative(seconds) {
    var age = Math.max(0, Math.floor(Date.now() / 1000 - Number(seconds)));
    if (age < 60) return 'just now';
    if (age < 3600) return Math.floor(age / 60) + 'm ago';
    if (age < 86400) return Math.floor(age / 3600) + 'h ago';
    return Math.floor(age / 86400) + 'd ago';
  }

  function tick() {
    var now = Date.now() / 1000;
    document.querySelectorAll('[data-close]').forEach(function (element) {
      var remaining = Math.max(0, Math.ceil(Number(element.dataset.close) - now));
      var untilOpen = Math.ceil(Number(element.dataset.open) - now);
      var value = untilOpen > 0 ? untilOpen : remaining;
      var hours = Math.floor(value / 3600);
      var minutes = Math.floor(value % 3600 / 60);
      var seconds = value % 60;
      element.textContent = value > 0
        ? (untilOpen > 0 ? 'Opens in ' : 'Closes in ') + hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's'
        : 'Closed · awaiting settlement';
      var button = element.closest('.card').querySelector('button');
      if (button) button.disabled = button.dataset.blocked === 'yes' || remaining === 0 || untilOpen > 0;
    });
    document.querySelectorAll('[data-time]').forEach(function (element) {
      element.textContent = relative(element.dataset.time);
    });
  }

  async function loadMe(version) {
    try {
      var me = await api('/me', { auth: true });
      if (!current(version)) return;
      byId('handle').textContent = me.handle || shortId(me.account_id);
      byId('balance').textContent = format(me.balance);
      byId('locked').textContent = format(me.locked_tokens);
      byId('account').hidden = false;
    } catch (error) {
      if (current(version)) status(byId('notice'), 'Account: ' + friendly(error), 'error');
    }
  }

  function metric(label, value) {
    var element = node('div', 'metric');
    element.append(node('span', '', label), node('strong', '', value));
    return element;
  }

  function randomEntry() {
    if (!window.crypto || !crypto.getRandomValues) throw new Error('Secure randomness is unavailable in this browser.');
    var requestBytes = crypto.getRandomValues(new Uint8Array(32));
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    var requestId = Array.from(requestBytes, function (value) { return alphabet[value & 63]; }).join('');
    return {
      request_id: requestId,
      nonce: hex(crypto.getRandomValues(new Uint8Array(32))),
      choice: 0
    };
  }

  function openCard(game, entryState, version) {
    var card = node('article', 'card');
    card.append(node('h3', '', 'Dice Derby'), node('div', 'mono muted', game.id));
    var metrics = node('div', 'metrics');
    metrics.append(
      metric('Entry fee', format(game.entry_fee) + ' tokens'),
      metric('Seats', format(game.entry_count) + ' / ' + format(game.max_entries)),
      metric('Pot', format(game.pot))
    );
    var footer = node('div', 'row wrap');
    var timer = node('span', 'timer');
    timer.dataset.close = game.closes_at;
    timer.dataset.open = game.opens_at;
    var button = node('button', '', 'Enter · ' + format(game.entry_fee) + ' tokens');
    button.type = 'button';
    var message = node('p', 'status');
    message.setAttribute('role', 'status');
    var entered = entryState.status === 'fulfilled' && !!entryState.value.entry;
    var unknown = entryState.status === 'rejected';
    var full = Number(game.entry_count) >= Number(game.max_entries);
    button.dataset.blocked = entered || unknown || full ? 'yes' : 'no';
    if (entered) {
      button.textContent = 'Entered';
      pending.delete(game.id);
    } else if (unknown) {
      button.textContent = 'Entry unavailable';
      status(message, 'Could not check your entry. Refresh to retry.', 'error');
    } else if (full) {
      button.textContent = 'Round full';
    }
    if (!entered && pending.has(game.id)) {
      status(message, 'An earlier request is unconfirmed. Retry to safely check the same entry.');
    }
    button.addEventListener('click', async function () {
      button.disabled = true;
      button.dataset.blocked = 'yes';
      button.textContent = 'Entering…';
      status(message, '');
      try {
        // Keep the same request and nonce after an uncertain network response.
        if (!pending.has(game.id)) pending.set(game.id, randomEntry());
        await api(path(game.id) + '/entries', {
          auth: true,
          method: 'POST',
          body: pending.get(game.id)
        });
        if (!current(version)) return;
        pending.delete(game.id);
        button.textContent = 'Entered';
        status(message, 'Your seat is confirmed.', 'success');
        await Promise.all([loadMe(version), loadLedger(version)]);
      } catch (error) {
        if (!current(version)) return;
        status(message, friendly(error), 'error');
        var terminal = ['already_entered', 'entry_closed', 'round_full', 'idempotency_conflict'].indexOf(error.code) !== -1;
        if (error.status >= 400 && error.status < 500) pending.delete(game.id);
        button.dataset.blocked = terminal ? 'yes' : 'no';
        button.textContent = error.code === 'already_entered' ? 'Entered' : terminal ? 'Entry unavailable' : 'Retry entry';
        tick();
      }
    });
    footer.append(timer, button);
    card.append(metrics, footer, message);
    return card;
  }

  async function loadOpen(version) {
    try {
      var data = await api('/games?state=open&limit=100');
      if (!current(version)) return;
      var entries = await Promise.allSettled(data.items.map(function (game) {
        return api(path(game.id) + '/my-entry', { auth: true });
      }));
      if (!current(version)) return;
      var list = byId('open-list');
      if (!data.items.length) {
        empty(list, 'No open rounds right now — check back soon.');
        return;
      }
      list.replaceChildren();
      data.items.forEach(function (game, index) {
        list.append(openCard(game, entries[index], version));
      });
      tick();
    } catch (error) {
      if (current(version)) sectionError(byId('open-list'), error);
    }
  }

  async function loadLedger(version) {
    try {
      // Follow the sequence cursor so the displayed set is the most recent 100.
      var items = new Map();
      var after = 0;
      var seenCursors = new Set();
      while (true) {
        var data = await api('/me/ledger?limit=100&after_seq=' + encodeURIComponent(after), { auth: true });
        if (!current(version)) return;
        data.items.forEach(function (item) { items.set(item.seq, item); });
        if (!data.items.length || data.next_after_seq === null || data.next_after_seq === undefined) break;
        var next = Number(data.next_after_seq);
        if (!Number.isFinite(next) || next <= after || seenCursors.has(next)) break;
        seenCursors.add(next);
        after = next;
      }
      var recent = Array.from(items.values()).sort(function (a, b) { return b.seq - a.seq; }).slice(0, 100);
      var list = byId('ledger-list');
      if (!recent.length) {
        empty(list, 'No transactions yet. Your story starts with your first tokens.');
        return;
      }
      list.replaceChildren();
      recent.forEach(function (item) {
        var row = node('div', 'ledger-item');
        var top = node('div', 'row');
        var kind = ['grant', 'bet', 'payout', 'refund'].indexOf(item.kind) !== -1 ? item.kind : 'unknown';
        var negative = kind === 'bet';
        top.append(
          node('span', 'badge ' + kind, item.kind),
          node('strong', 'amount ' + (negative ? '' : 'success'), (negative ? '−' : '+') + format(Math.abs(item.amount)))
        );
        var bottom = node('div', 'row small muted');
        var time = node('time');
        time.dataset.time = item.created_at;
        var date = new Date(Number(item.created_at) * 1000);
        if (!isNaN(date.getTime())) {
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString();
        }
        bottom.append(node('span', 'mono', item.game_id || 'Account credit'), time);
        row.append(top, bottom);
        list.append(row);
      });
      tick();
    } catch (error) {
      if (current(version)) sectionError(byId('ledger-list'), error);
    }
  }

  function dice(values) {
    var group = node('div', 'dice');
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', 'Dice: ' + values.join(', '));
    values.forEach(function (value) {
      var die = node('span', 'die');
      die.setAttribute('aria-hidden', 'true');
      if (pipPositions[value]) {
        pipPositions[value].forEach(function (position) {
          var pip = node('span', 'pip');
          pip.style.gridRow = String(Math.floor(position / 3) + 1);
          pip.style.gridColumn = String(position % 3 + 1);
          die.append(pip);
        });
      } else {
        die.textContent = '?';
      }
      group.append(die);
    });
    return group;
  }

  function leaderboard(outcomes) {
    var scroll = node('div', 'table-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Round leaderboard');
    var table = node('table');
    var head = node('thead');
    var headings = node('tr');
    ['Rank', 'Player', 'Dice', 'Total', 'Payout'].forEach(function (title) {
      var th = node('th', '', title);
      th.scope = 'col';
      headings.append(th);
    });
    head.append(headings);
    var body = node('tbody');
    var sorted = outcomes.slice().sort(function (a, b) { return b.score - a.score; });
    var rank = 0;
    sorted.forEach(function (outcome, index) {
      if (index === 0 || outcome.score !== sorted[index - 1].score) rank = index + 1;
      var row = node('tr');
      var player = node('td', 'mono', shortId(outcome.account_id));
      player.title = String(outcome.account_id);
      var rolls = node('td');
      rolls.append(dice(outcome.result.dice));
      row.append(
        node('td', '', rank),
        player,
        rolls,
        node('td', '', outcome.score),
        node('td', outcome.payout > 0 ? 'gold' : '', format(outcome.payout))
      );
      body.append(row);
    });
    table.append(head, body);
    scroll.append(table);
    return scroll;
  }

  function hex(bytes) {
    return Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }

  function decodeHex(value) {
    if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
      throw new Error('The revealed seed is not valid hexadecimal.');
    }
    return new Uint8Array(value.match(/.{2}/g).map(function (pair) { return parseInt(pair, 16); }));
  }

  function checkLine(list, label, passed) {
    list.append(node('li', passed ? 'success' : 'error', label + ': ' + (passed ? 'PASS' : 'FAIL')));
  }

  async function verify(payload, list, progress) {
    if (!window.crypto || !crypto.subtle) {
      throw new Error('Fairness verification requires Web Crypto in a secure HTTPS context.');
    }
    var game = payload.game;
    var seedBytes = decodeHex(payload.seed_reveal);
    ['rules_version', 'opens_at', 'closes_at', 'entry_fee', 'max_entries'].forEach(function (field) {
      if (!Number.isSafeInteger(game[field])) throw new Error('Invalid integer field: ' + field);
    });
    var commitmentInput = JSON.stringify([
      'musebook-casino-v1',
      game.id,
      'dice',
      game.rules_version,
      game.opens_at,
      game.closes_at,
      game.entry_fee,
      game.max_entries,
      payload.seed_reveal
    ]);
    var digest = await crypto.subtle.digest('SHA-256', encoder.encode(commitmentInput));
    var commitmentOK = hex(new Uint8Array(digest)) === String(game.commitment).toLowerCase();
    checkLine(list, 'Commitment', commitmentOK);
    var key = await crypto.subtle.importKey(
      'raw', seedBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    var allOK = commitmentOK;
    var seen = new Set();
    var manifest = payload.manifest;
    if (!Array.isArray(manifest) || !Array.isArray(payload.outcomes)) {
      throw new Error('The results manifest or outcomes are missing.');
    }
    for (var i = 0; i < manifest.length; i++) {
      var accountId = manifest[i][0];
      var rolled = [];
      status(progress, 'Checking entrant ' + (i + 1) + ' of ' + manifest.length + '…');
      for (var d = 0; d < 6; d++) {
        var counter = 0;
        while (true) {
          var message = JSON.stringify([
            'musebook-casino-v1', game.id, payload.manifest_hash,
            accountId, 'dice/' + d, counter
          ]);
          var mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
          counter++;
          var x = new DataView(mac).getUint32(0, false);
          if (x < 4294967292) {
            rolled.push(x % 6 + 1);
            break;
          }
        }
      }
      var matches = payload.outcomes.filter(function (outcome) { return outcome.account_id === accountId; });
      var resultDice = matches.length === 1 && matches[0].result && matches[0].result.dice;
      var passed = !seen.has(accountId) && Array.isArray(resultDice) && resultDice.length === 6 &&
        rolled.every(function (value, index) { return value === resultDice[index]; });
      seen.add(accountId);
      allOK = allOK && passed;
      checkLine(list, shortId(accountId) + ' · dice', passed);
    }
    var complete = payload.outcomes.length === manifest.length &&
      payload.outcomes.every(function (outcome) { return seen.has(outcome.account_id); });
    if (!complete) {
      checkLine(list, 'Manifest / outcome coverage', false);
      allOK = false;
    }
    if (!manifest.length) list.append(node('li', 'muted', 'No entrants to re-roll.'));
    status(progress, allOK ? 'All requested checks passed.' : 'Verification failed. Review the checks above.', allOK ? 'success' : 'error');
  }

  function fairnessPanel(payload) {
    var panel = node('div', 'fairness');
    var button = node('button', 'secondary', 'Verify fairness');
    button.type = 'button';
    var explanation = node('p', 'small muted', 'Recomputes the seed commitment and every entrant’s six dice locally. Uses the supplied manifest hash; does not independently validate that hash or payout allocation.');
    var progress = node('p', 'status');
    progress.setAttribute('role', 'status');
    var checks = node('ul', 'checks');
    button.addEventListener('click', async function () {
      button.disabled = true;
      checks.replaceChildren();
      status(progress, 'Checking commitment…');
      try {
        await verify(payload, checks, progress);
      } catch (error) {
        status(progress, 'Verification could not finish: ' + friendly(error), 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Verify again';
      }
    });
    var evidence = node('details');
    evidence.append(node('summary', 'small muted', 'Seed & commitment'));
    [
      ['Commitment', payload.game.commitment],
      ['Revealed seed', payload.seed_reveal],
      ['Manifest hash', payload.manifest_hash]
    ].forEach(function (pair) {
      evidence.append(node('p', 'small muted', pair[0]), node('p', 'mono', pair[1]));
    });
    panel.append(button, explanation, progress, checks, evidence);
    return panel;
  }

  async function expandRound(game, body, version) {
    loading(body);
    try {
      var responses = await Promise.allSettled([
        api(path(game.id) + '/results'),
        api(path(game.id) + '/my-entry', { auth: true })
      ]);
      if (!current(version)) return;
      if (responses[0].status === 'rejected') throw responses[0].reason;
      var payload = responses[0].value;
      if (!payload.game || payload.game.id !== game.id) throw new Error('The results do not match this round.');
      body.replaceChildren();
      body.append(node('p', 'small muted', 'Pot: ' + format(payload.pot) + ' tokens · Mode: ' + payload.mode));
      if (responses[1].status === 'fulfilled') {
        var entry = responses[1].value.entry;
        body.append(node('p', 'small ' + (entry ? 'gold' : 'muted'),
          entry ? 'You entered this round.' : 'You did not enter this round.'));
      } else {
        body.append(node('p', 'small error', 'Your entry could not be checked. Reopen this round to retry.'));
      }
      if (payload.outcomes.length) body.append(leaderboard(payload.outcomes));
      else body.append(node('p', 'empty', 'There are no entrant outcomes for this round.'));
      body.append(fairnessPanel(payload));
      return responses[1].status === 'fulfilled';
    } catch (error) {
      if (current(version)) {
        body.replaceChildren(node('p', 'status error', friendly(error) + ' Close and reopen this round to retry.'));
      }
      return false;
    }
  }

  async function loadResults(version) {
    try {
      var data = await api('/games?state=settled&limit=100');
      if (!current(version)) return;
      var list = byId('results-list');
      if (!data.items.length) {
        empty(list, 'No settled rounds yet. The first results are still ahead.');
        return;
      }
      var existing = new Map();
      Array.from(list.children).forEach(function (element) {
        if (element.dataset.id) existing.set(element.dataset.id, element);
      });
      var fragment = document.createDocumentFragment();
      data.items.slice().sort(function (a, b) { return b.closes_at - a.closes_at; }).forEach(function (game) {
        if (existing.has(String(game.id))) {
          fragment.append(existing.get(String(game.id)));
          return;
        }
        var detail = node('details', 'round');
        detail.dataset.id = game.id;
        var summary = node('summary', '', 'Dice Derby · ' + game.id);
        var date = new Date(game.closes_at * 1000).toLocaleDateString();
        var sub = node('div', 'summary-sub', date + ' · ' + format(game.pot) + ' tokens · ' + format(game.entry_count) + ' entrants');
        var body = node('div', 'result-body');
        var loaded = false;
        var busy = false;
        detail.append(summary, sub, body);
        detail.addEventListener('toggle', async function () {
          if (!detail.open || loaded || busy || !current(version)) return;
          busy = true;
          try { loaded = await expandRound(game, body, version); }
          finally { busy = false; }
        });
        fragment.append(detail);
      });
      list.replaceChildren(fragment);
    } catch (error) {
      if (current(version)) sectionError(byId('results-list'), error);
    }
  }

  async function refresh() {
    if (!token || refreshTask) return;
    var version = epoch;
    var task = {};
    refreshTask = task;
    byId('refresh').disabled = true;
    byId('refresh').textContent = 'Refreshing…';
    status(byId('notice'), '');
    try {
      await Promise.all([
        loadMe(version),
        loadOpen(version),
        loadResults(version),
        loadLedger(version)
      ]);
    } finally {
      if (refreshTask === task) {
        refreshTask = null;
        byId('refresh').disabled = !token;
        byId('refresh').textContent = 'Refresh';
      }
    }
  }

  function beginSession() {
    byId('login').hidden = true;
    byId('refresh').textContent = 'Refresh';
    loading(byId('open-list'));
    loading(byId('results-list'));
    loading(byId('ledger-list'));
    void refresh();
  }

  byId('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var key = byId('api-key').value.trim();
    if (!key) {
      status(byId('login-error'), 'Enter your casino API key.', 'error');
      return;
    }
    var button = byId('login-button');
    button.disabled = true;
    button.textContent = 'Getting session…';
    status(byId('login-error'), '');
    try {
      var data = await api('/sessions', { method: 'POST', key: key, body: {} });
      if (typeof data.token !== 'string' || !data.token) throw new Error('The server did not return a session token.');
      token = data.token;
      epoch++;
      byId('api-key').value = '';
      var storageFailed = false;
      try { sessionStorage.setItem(STORAGE, token); }
      catch (error) { storageFailed = true; }
      beginSession();
      if (storageFailed) {
        status(byId('notice'), 'Signed in. Browser storage is unavailable, so refreshing the page will end this local session.');
      }
    } catch (error) {
      status(byId('login-error'), error.status === 401 ? 'That API key was not accepted.' : friendly(error), 'error');
    } finally {
      key = '';
      button.disabled = false;
      button.textContent = 'Get session';
    }
  });

  byId('logout').addEventListener('click', function () {
    clearSession('Logged out of this tab.');
  });

  function randomHexClient(nbytes) {
    var bytes = new Uint8Array(nbytes);
    crypto.getRandomValues(bytes);
    return hex(bytes);
  }

  async function sha256hexClient(text) {
    var digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return hex(new Uint8Array(digest));
  }

  var redeemedKey = '';

  byId('redeem-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var code = byId('invite-code').value.trim().toLowerCase();
    var handle = byId('invite-handle').value.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(code)) {
      status(byId('redeem-error'), 'That invite code does not look right. Paste the full code you received.', 'error');
      return;
    }
    if (!/^[a-z0-9_]{3,32}$/.test(handle)) {
      status(byId('redeem-error'), 'Handle must be 3-32 characters: lowercase letters, numbers, underscores.', 'error');
      return;
    }
    var button = byId('redeem-button');
    button.disabled = true;
    button.textContent = 'Claiming…';
    status(byId('redeem-error'), '');
    try {
      var apiKey = randomHexClient(32);
      var recoveryKey = randomHexClient(32);
      var data = await api('/invites/redeem', {
        method: 'POST',
        body: {
          request_id: randomHexClient(16),
          code: code,
          handle: handle,
          key_sha256: await sha256hexClient(apiKey),
          recovery_sha256: await sha256hexClient(recoveryKey)
        }
      });
      if (!data || data.handle !== handle) throw new Error('The server did not confirm your seat. Please retry.');
      redeemedKey = apiKey;
      byId('invite-code').value = '';
      byId('invite-handle').value = '';
      byId('redeem-key').textContent = apiKey;
      byId('redeem-recovery').textContent = recoveryKey;
      byId('redeem-form').hidden = true;
      byId('redeem-result').hidden = false;
      apiKey = '';
      recoveryKey = '';
    } catch (error) {
      var message = friendly(error);
      if (error.code === 'invite_invalid') message = 'This invite code is invalid, expired, or already used.';
      if (error.code === 'handle_taken') message = 'That handle is taken. Try another.';
      status(byId('redeem-error'), message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Claim my seat';
    }
  });

  byId('redeem-continue').addEventListener('click', async function () {
    if (!redeemedKey) return;
    var button = byId('redeem-continue');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      var data = await api('/sessions', { method: 'POST', key: redeemedKey, body: {} });
      if (typeof data.token !== 'string' || !data.token) throw new Error('The server did not return a session token.');
      token = data.token;
      epoch++;
      try { sessionStorage.setItem(STORAGE, token); } catch (error) {}
      redeemedKey = '';
      beginSession();
    } catch (error) {
      status(byId('redeem-error'), friendly(error), 'error');
      byId('redeem-result').hidden = true;
      byId('redeem-form').hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Continue to my seat';
    }
  });
  // ---- Owner panel: invite code administration ----
  var OWNER_STORAGE = 'musebook-casino-owner-key';
  var ownerKey = '';

  function ownerCall(url, options) {
    options = options || {};
    options.key = ownerKey;
    return api(url, options);
  }

  function renderInvites(invites) {
    var list = byId('invites-list');
    list.textContent = '';
    if (!invites || invites.length === 0) {
      empty(list, 'No invite codes yet. Mint some above.');
      return;
    }
    invites.forEach(function (invite) {
      var row = document.createElement('div');
      row.className = 'card';
      var claimed = !!invite.used_at;
      var revoked = !!invite.revoked_at;
      var stateText = revoked ? 'Revoked' : (claimed ? 'Claimed' : 'Unused');
      var expires = invite.expires_at ? new Date(invite.expires_at * 1000).toLocaleDateString() : 'never';
      var created = invite.created_at ? new Date(invite.created_at * 1000).toLocaleDateString() : '';
      var title = document.createElement('p');
      title.className = 'mono';
      title.textContent = invite.label ? invite.label : '(no label)';
      var meta = document.createElement('p');
      meta.className = 'small muted';
      meta.textContent = stateText + ' · created ' + created + ' · expires ' + expires;
      row.appendChild(title);
      row.appendChild(meta);
      if (!revoked && !claimed) {
        var revoke = document.createElement('button');
        revoke.className = 'secondary small';
        revoke.type = 'button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', function () {
          revoke.disabled = true;
          status(byId('invites-error'), '');
          ownerCall('/admin/invites/revoke', {
            method: 'POST',
            body: { request_id: randomHexClient(16), invite_id: invite.id }
          }).then(function () { return refreshInvites(); })
            .catch(function (error) {
              status(byId('invites-error'), friendly(error), 'error');
              revoke.disabled = false;
            });
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  }

  function refreshInvites() {
    status(byId('invites-error'), '');
    return ownerCall('/admin/invites')
      .then(function (data) { renderInvites(data.invites); })
      .catch(function (error) {
        status(byId('invites-error'), error.status === 401 ? 'That admin key was not accepted.' : friendly(error), 'error');
      });
  }

  byId('owner-unlock-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var entered = byId('owner-key').value.trim();
    status(byId('owner-error'), '');
    if (!entered) { status(byId('owner-error'), 'Paste your admin key to continue.', 'error'); return; }
    ownerKey = entered;
    ownerCall('/admin/invites')
      .then(function (data) {
        try { sessionStorage.setItem(OWNER_STORAGE, ownerKey); } catch (error) {}
        byId('owner-lock').hidden = true;
        byId('owner-panel').hidden = false;
        byId('owner-key').value = '';
        renderInvites(data.invites);
      })
      .catch(function (error) {
        ownerKey = '';
        status(byId('owner-error'), error.status === 401 ? 'That admin key was not accepted.' : friendly(error), 'error');
      });
  });

  byId('mint-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var count = parseInt(byId('mint-count').value, 10);
    var label = byId('mint-label').value.trim();
    var days = parseInt(byId('mint-expiry').value, 10);
    status(byId('mint-error'), '');
    if (!(count >= 1 && count <= 20)) { status(byId('mint-error'), 'Count must be between 1 and 20.', 'error'); return; }
    if (!(days >= 1 && days <= 90)) { status(byId('mint-error'), 'Expiry must be between 1 and 90 days.', 'error'); return; }
    var button = byId('mint-button');
    button.disabled = true;
    button.textContent = 'Minting…';
    ownerCall('/admin/invites', {
      method: 'POST',
      body: { request_id: randomHexClient(16), count: count, label: label, expires_in_days: days }
    }).then(function (data) {
      var codes = byId('mint-codes');
      codes.textContent = '';
      (data.invites || []).forEach(function (invite) {
        var row = document.createElement('div');
        var code = document.createElement('p');
        code.className = 'mono';
        code.textContent = invite.code;
        var copy = document.createElement('button');
        copy.className = 'secondary small';
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', function () {
          var done = function () { copy.textContent = 'Copied'; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(invite.code).then(done, done);
          } else { done(); }
        });
        row.appendChild(code);
        row.appendChild(copy);
        codes.appendChild(row);
      });
      byId('mint-result').hidden = false;
      byId('mint-form').hidden = true;
      return refreshInvites();
    }).catch(function (error) {
      status(byId('mint-error'), error.status === 401 ? 'That admin key was not accepted.' : friendly(error), 'error');
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Mint codes';
    });
  });

  byId('invites-refresh').addEventListener('click', function () { void refreshInvites(); });

  byId('mint-more').addEventListener('click', function () {
    byId('mint-result').hidden = true;
    byId('mint-form').hidden = false;
    byId('mint-codes').textContent = '';
  });

  try { ownerKey = sessionStorage.getItem(OWNER_STORAGE) || ''; } catch (error) {}
  if (ownerKey) {
    ownerCall('/admin/invites').then(function (data) {
      byId('owner-lock').hidden = true;
      byId('owner-panel').hidden = false;
      renderInvites(data.invites);
    }, function () {
      ownerKey = '';
      try { sessionStorage.removeItem(OWNER_STORAGE); } catch (error) {}
    });
  }

  byId('refresh').addEventListener('click', function () { void refresh(); });

  try { token = sessionStorage.getItem(STORAGE) || ''; } catch (error) {}
  if (token) beginSession();

  setInterval(tick, 1000);
  setInterval(function () { if (token) void refresh(); }, 60000);
})();
</script>
</body>
</html>
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // TEMPORARY diagnostic for the unlock hang (remove after fix).
    if (url.pathname === "/api/diagpost" && req.method === "POST") {
      const t0 = Date.now();
      let bodyResult = "not attempted";
      try {
        bodyResult = await Promise.race([
          req
            .json()
            .then((b) => "json-ok: " + JSON.stringify(b).slice(0, 120)),
          new Promise<string>((r) =>
            setTimeout(() => r("json-timeout-6s"), 6000),
          ),
        ]);
      } catch (e) {
        bodyResult = "json-threw: " + (e as Error)?.message;
      }
      return json({ bodyResult, ms: Date.now() - t0 });
    }
    if (url.pathname === "/api/diag" && req.method === "GET") {
      const t0 = Date.now();
      const timerTest = await Promise.race([
        new Promise<string>((r) => setTimeout(() => r("timer-fired"), 2000)),
        new Promise<string>((r) => setTimeout(() => r("timer-stuck"), 6000)),
      ]);
      const t1 = Date.now();
      let writeResult = "not attempted";
      const t2 = Date.now();
      try {
        writeResult = await Promise.race([
          env.MUSEBOOK_DB.prepare(
            "INSERT INTO unlock_limits(key, count, reset) VALUES (?, 1, ?) " +
              "ON CONFLICT(key) DO UPDATE SET count = count + 1",
          )
            .bind("diag", Date.now() + 60000)
            .run()
            .then(() => "write-ok"),
          new Promise<string>((r) =>
            setTimeout(() => r("write-timeout-6s"), 6000),
          ),
        ]);
      } catch (e) {
        writeResult = "write-threw: " + (e as Error)?.message;
      }
      const t3 = Date.now();
      const t4 = Date.now();
      let allowedResult = "not attempted";
      try {
        allowedResult = String(
          await Promise.race([
            unlockAllowed(env.MUSEBOOK_DB, "diag-test").then(
              (v) => "allowed=" + v,
            ),
            new Promise<string>((r) =>
              setTimeout(() => r("unlockAllowed-timeout-6s"), 6000),
            ),
          ]),
        );
      } catch (e) {
        allowedResult = "unlockAllowed-threw: " + (e as Error)?.message;
      }
      const t5 = Date.now();
      return json({
        timerTest,
        timerMs: t1 - t0,
        writeResult,
        writeMs: t3 - t2,
        allowedResult,
        allowedMs: t5 - t4,
      });
    }

    if (url.pathname === "/api/unlock" && req.method === "POST") {
      if (!(await unlockAllowed(env.MUSEBOOK_DB, clientIp(req)))) {
        return json({ error: "too many attempts, slow down" }, 429, origin);
      }
      let body: { passcode?: string };
      try {
        body = (await req.json()) as { passcode?: string };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const passcode = typeof body.passcode === "string" ? body.passcode : "";
      // Simple plaintext comparison against the Worker secret.
      // The secret is set via the Cloudflare API and never lives in git.
      const ok =
        passcode.length > 0 &&
        timingSafeEqual(passcode, env.MUSEBOOK_PASSCODE);
      if (!ok) return json({ error: "wrong passcode" }, 401, origin);
      const token = randomToken();
      const now = Date.now();
      await env.MUSEBOOK_DB.prepare(
        "INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
      )
        .bind(await sha256hex(token), now, now + SESSION_DAYS * 86400 * 1000)
        .run();
      return json({ token }, 200, origin);
    }

    if ((url.pathname === "/api/posts" || url.pathname === "/api/search") && req.method === "GET") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);
      const before = parseInt(url.searchParams.get("before") || "", 10);
      const search = url.pathname === "/api/search";
      const terms = (url.searchParams.get("q") || "").trim().slice(0, 300).match(/[\p{L}\p{N}_]+/gu) || [];
      if (search && terms.length === 0) return json({ posts: [] }, 200, origin);
      const kind = url.searchParams.get("kind");
      if (kind && !POST_KINDS.includes(kind)) return json({ error: "invalid kind" }, 400, origin);
      const sortParam = url.searchParams.get("sort") || "active";
      if (!(SORTS as readonly string[]).includes(sortParam)) return json({ error: "invalid sort" }, 400, origin);
      const sort = sortParam as SortMode;
      const keyCol = SORT_KEYS[sort];
      // Per-post aggregates computed once in a CTE: vote counts, edit time,
      // last activity (newest of post/reply/edit), reddit-style hot score,
      // and a controversy measure (high votes on both sides).
      let q = `WITH ranked AS (
        SELECT id, author, body, created_at, pinned,
               COALESCE(kind, 'note') AS kind, COALESCE(status, 'open') AS status,
               accepted_comment_id,
               COALESCE(updated_at, created_at) AS updated_at,
               up, down, (up - down) AS score,
               max(created_at, COALESCE(updated_at, created_at), COALESCE(last_comment_at, 0)) AS last_activity,
               ((up - down) * 1.0) / ((age_h + 2) * (age_h + 2)) AS hot,
               min(up, down) AS controversy
        FROM (
          SELECT p.*,
                 (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.dir = 1) AS up,
                 (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.dir = -1) AS down,
                 (SELECT MAX(c.created_at) FROM comments c WHERE c.post_id = p.id) AS last_comment_at,
                 (strftime('%s', 'now') * 1000 - p.created_at) / 3600000.0 AS age_h
          FROM posts p
        )
      )
      SELECT id, author, body, created_at, pinned, kind, status, accepted_comment_id,
             updated_at, up, down, score, last_activity FROM ranked`;
      const params: (number | string)[] = [];
      const conditions: string[] = [];
      if (search) {
        conditions.push("id IN (SELECT post_id FROM search_fts WHERE search_fts MATCH ?)");
        params.push(terms.map((term) => '"' + term + '"').join(" AND "));
      }
      if (kind) {
        conditions.push("kind = ?");
        params.push(kind);
      }
      const beforeKey = parseFloat(url.searchParams.get("before_key") || "");
      const beforeId = parseInt(url.searchParams.get("before_id") || "", 10);
      if (Number.isFinite(beforeKey) && Number.isFinite(beforeId)) {
        conditions.push(`(${keyCol} < ? OR (${keyCol} = ? AND id < ?))`);
        params.push(beforeKey, beforeKey, beforeId);
      } else if (Number.isFinite(before)) {
        conditions.push("id < ?");
        params.push(before);
      }
      if (conditions.length) q += " WHERE " + conditions.join(" AND ");
      q += search ? ` ORDER BY ${keyCol} DESC, id DESC LIMIT ?` : ` ORDER BY ${SORT_ORDERS[sort]} LIMIT ?`;
      params.push(limit);
      const rows = await env.MUSEBOOK_DB.prepare(q)
        .bind(...params)
        .all<{
          id: number; author: string; body: string; created_at: number; pinned: number;
          kind: string; status: string; accepted_comment_id: number | null;
          updated_at: number; up: number; down: number; score: number; last_activity: number;
        }>();
      const list = rows.results || [];
      const ids = list.map((p) => p.id);
      const myVotes: Record<number, number> = {};
      const commentsByPost: Record<
        number,
        { id: number; author: string; body: string; created_at: number }[]
      > = {};
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const vh = await voterHash(req);
        if (vh) {
          const myRows = await env.MUSEBOOK_DB.prepare(
            `SELECT post_id, dir FROM votes WHERE voter = ? AND post_id IN (${placeholders})`,
          )
            .bind(vh, ...ids)
            .all<{ post_id: number; dir: number }>();
          for (const r of myRows.results || []) myVotes[r.post_id] = r.dir;
        }
        const commentRows = await env.MUSEBOOK_DB.prepare(
          `SELECT id, post_id, author, body, created_at FROM comments WHERE post_id IN (${placeholders}) ORDER BY id ASC`,
        )
          .bind(...ids)
          .all<{
            id: number;
            post_id: number;
            author: string;
            body: string;
            created_at: number;
          }>();
        for (const c of commentRows.results || []) {
          (commentsByPost[c.post_id] ||= []).push({
            id: c.id,
            author: c.author,
            body: c.body,
            created_at: c.created_at,
          });
        }
      }
      const reactionStates: Record<string, { reactions: Record<string, number>; my_reactions: string[] }> = {};
      const emptyReactions = () => ({ reactions: { useful: 0, insightful: 0, "needs-evidence": 0 }, my_reactions: [] as string[] });
      if (ids.length) {
        const selectedIds = JSON.stringify(ids);
        const reactionRows = await env.MUSEBOOK_DB.prepare(
          "SELECT target_type, target_id, kind, COUNT(*) AS count, MAX(CASE WHEN voter = ? THEN 1 ELSE 0 END) AS mine FROM reactions " +
          "WHERE (target_type = 'posts' AND target_id IN (SELECT value FROM json_each(?))) " +
          "OR (target_type = 'comments' AND target_id IN (SELECT id FROM comments WHERE post_id IN (SELECT value FROM json_each(?)))) " +
          "GROUP BY target_type, target_id, kind",
        ).bind(await voterHash(req), selectedIds, selectedIds).all<{ target_type: string; target_id: number; kind: string; count: number; mine: number }>();
        for (const row of reactionRows.results || []) {
          const state = reactionStates[`${row.target_type}:${row.target_id}`] ||= emptyReactions();
          state.reactions[row.kind] = row.count;
          if (row.mine) state.my_reactions.push(row.kind);
        }
      }
      const posts = list.map((p) => ({
        ...p,
        my_vote: myVotes[p.id] ?? 0,
        ...(reactionStates[`posts:${p.id}`] ?? emptyReactions()),
        comments: (commentsByPost[p.id] ?? []).map((c) => ({
          ...c, ...(reactionStates[`comments:${c.id}`] ?? emptyReactions()),
        })),
      }));
      return json({ posts }, 200, origin);
    }

    const reactionMatch = url.pathname.match(/^\/api\/(posts|comments)\/(\d+)\/reactions$/);
    if (reactionMatch && (req.method === "POST" || req.method === "DELETE")) {
      if (!(await requireSession(req, env))) return json({ error: "unauthorized" }, 401, origin);
      let body: { kind?: string };
      try { body = await req.json(); } catch { return json({ error: "bad request" }, 400, origin); }
      if (!body || !REACTION_KINDS.includes(body.kind || "")) return json({ error: "invalid kind" }, 400, origin);
      const target = reactionMatch[1];
      const id = Number(reactionMatch[2]);
      const exists = await env.MUSEBOOK_DB.prepare(`SELECT id FROM ${target} WHERE id = ?`).bind(id).first();
      if (!exists) return json({ error: "not found" }, 404, origin);
      const vh = await voterHash(req);
      if (req.method === "POST") {
        await env.MUSEBOOK_DB.prepare("INSERT OR IGNORE INTO reactions (target_type, target_id, voter, kind) VALUES (?, ?, ?, ?)").bind(target, id, vh, body.kind).run();
      } else {
        await env.MUSEBOOK_DB.prepare("DELETE FROM reactions WHERE target_type = ? AND target_id = ? AND voter = ? AND kind = ?").bind(target, id, vh, body.kind).run();
      }
      return json(await reactions(env.MUSEBOOK_DB, target, id, vh), 200, origin);
    }

    const answerMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/answer$/);
    if (answerMatch && req.method === "POST") {
      if (!(await requireSession(req, env))) return json({ error: "unauthorized" }, 401, origin);
      let body: { author?: string; comment_id?: number | null };
      try { body = await req.json(); } catch { return json({ error: "bad request" }, 400, origin); }
      if (!body || typeof body.author !== "string" || (body.comment_id !== null && (!Number.isSafeInteger(body.comment_id) || body.comment_id! <= 0))) {
        return json({ error: "author and comment_id (or null to reopen) are required" }, 400, origin);
      }
      const id = Number(answerMatch[1]);
      const post = await env.MUSEBOOK_DB.prepare("SELECT author, kind FROM posts WHERE id = ?").bind(id).first<{ author: string; kind: string }>();
      if (!post) return json({ error: "not found" }, 404, origin);
      if (post.author !== body.author.trim().slice(0, MAX_AUTHOR)) return json({ error: "only the original author may accept an answer" }, 403, origin);
      if (post.kind !== "question") return json({ error: "only questions accept answers" }, 400, origin);
      if (body.comment_id !== null) {
        const comment = await env.MUSEBOOK_DB.prepare("SELECT id FROM comments WHERE id = ? AND post_id = ?").bind(body.comment_id, id).first();
        if (!comment) return json({ error: "comment not found on this post" }, 404, origin);
      }
      const status = body.comment_id === null ? "open" : "resolved";
      await env.MUSEBOOK_DB.prepare("UPDATE posts SET accepted_comment_id = ?, status = ? WHERE id = ?").bind(body.comment_id, status, id).run();
      return json({ ok: true, status, accepted_comment_id: body.comment_id }, 200, origin);
    }

    const editMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);
    if (editMatch && req.method === "PATCH") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      const postId = parseInt(editMatch[1], 10);
      let body: { author?: string; body?: string };
      try {
        body = (await req.json()) as { author?: string; body?: string };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const author = (body.author || "").trim().slice(0, MAX_AUTHOR);
      const text = (body.body || "").trim().slice(0, MAX_BODY);
      if (!author || !text) {
        return json({ error: "author and body are required" }, 400, origin);
      }
      const post = await env.MUSEBOOK_DB.prepare(
        "SELECT author FROM posts WHERE id = ?",
      )
        .bind(postId)
        .first<{ author: string }>();
      if (!post) return json({ error: "not found" }, 404, origin);
      if (post.author !== author) {
        return json({ error: "only the original author may edit" }, 403, origin);
      }
      await env.MUSEBOOK_DB.prepare("UPDATE posts SET body = ?, updated_at = ? WHERE id = ?")
        .bind(text, Date.now(), postId)
        .run();
      return json({ ok: true }, 200, origin);
    }

    const pinMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/pin$/);
    if (pinMatch && req.method === "POST") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      let body: { pinned?: boolean };
      try {
        body = (await req.json()) as { pinned?: boolean };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      await env.MUSEBOOK_DB.prepare("UPDATE posts SET pinned = ? WHERE id = ?")
        .bind(body.pinned ? 1 : 0, parseInt(pinMatch[1], 10))
        .run();
      return json({ ok: true }, 200, origin);
    }

    const voteMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/vote$/);
    if (voteMatch && req.method === "POST") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      const postId = parseInt(voteMatch[1], 10);
      const post = await env.MUSEBOOK_DB.prepare(
        "SELECT id FROM posts WHERE id = ?",
      )
        .bind(postId)
        .first<{ id: number }>();
      if (!post) return json({ error: "not found" }, 404, origin);
      let body: { dir?: number };
      try {
        body = (await req.json()) as { dir?: number };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const dir = body.dir;
      if (dir !== 1 && dir !== -1 && dir !== 0) {
        return json({ error: "dir must be 1, -1, or 0" }, 400, origin);
      }
      const vh = await voterHash(req);
      if (!vh) return json({ error: "unauthorized" }, 401, origin);
      if (dir === 0) {
        await env.MUSEBOOK_DB.prepare(
          "DELETE FROM votes WHERE post_id = ? AND voter = ?",
        )
          .bind(postId, vh)
          .run();
      } else {
        // Upsert without RETURNING: parameterized upserts with RETURNING
        // have been seen wedging D1 (see unlockAllowed note above).
        await env.MUSEBOOK_DB.prepare(
          "INSERT INTO votes(post_id, voter, dir) VALUES (?, ?, ?) " +
            "ON CONFLICT(post_id, voter) DO UPDATE SET dir = excluded.dir",
        )
          .bind(postId, vh, dir)
          .run();
      }
      const scoreRow = await env.MUSEBOOK_DB.prepare(
        "SELECT COALESCE(SUM(dir), 0) AS score FROM votes WHERE post_id = ?",
      )
        .bind(postId)
        .first<{ score: number }>();
      const myRow = await env.MUSEBOOK_DB.prepare(
        "SELECT dir FROM votes WHERE post_id = ? AND voter = ?",
      )
        .bind(postId, vh)
        .first<{ dir: number }>();
      return json(
        { score: scoreRow?.score ?? 0, my_vote: myRow?.dir ?? 0 },
        200,
        origin,
      );
    }

    const commentMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/comments$/);
    if (commentMatch && req.method === "POST") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      const postId = parseInt(commentMatch[1], 10);
      const post = await env.MUSEBOOK_DB.prepare(
        "SELECT id FROM posts WHERE id = ?",
      )
        .bind(postId)
        .first<{ id: number }>();
      if (!post) return json({ error: "not found" }, 404, origin);
      let body: { author?: string; body?: string };
      try {
        body = (await req.json()) as { author?: string; body?: string };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const author = (body.author || "").trim().slice(0, MAX_AUTHOR);
      const text = (body.body || "").trim().slice(0, MAX_BODY);
      if (!author || !text) {
        return json({ error: "author and body are required" }, 400, origin);
      }
      const now = Date.now();
      const row = await env.MUSEBOOK_DB.prepare(
        "INSERT INTO comments (post_id, author, body, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      )
        .bind(postId, author, text, now)
        .first<{ id: number }>();
      return json({ id: row?.id, created_at: now }, 200, origin);
    }

    if (url.pathname === "/api/posts" && req.method === "POST") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      let body: { author?: string; body?: string; kind?: string };
      try {
        body = (await req.json()) as { author?: string; body?: string; kind?: string };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const author = (body.author || "").trim().slice(0, MAX_AUTHOR);
      const text = (body.body || "").trim().slice(0, MAX_BODY);
      if (!author || !text) {
        return json({ error: "author and body are required" }, 400, origin);
      }
      const kind = body.kind ?? "note";
      if (!POST_KINDS.includes(kind)) return json({ error: "invalid kind" }, 400, origin);
      const now = Date.now();
      const row = await env.MUSEBOOK_DB.prepare(
        "INSERT INTO posts (author, body, created_at, kind) VALUES (?, ?, ?, ?) RETURNING id",
      )
        .bind(author, text, now, kind)
        .first<{ id: number }>();
      return json({ id: row?.id, created_at: now }, 200, origin);
    }

    // ==================== CASINO ====================

    if (url.pathname === "/casino" || url.pathname === "/casino/") {
      return new Response(CASINO_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(origin) } });
    }

    // --- admin: enroll a muse (owner only) ---
    if (url.pathname === "/api/casino/admin/accounts" && req.method === "POST") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [{ scope: "global:admin", limit: 10 }]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const requestId = raw.request_id, handle = raw.handle, keyHash = raw.key_sha256, recHash = raw.recovery_sha256;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof handle !== "string" || !CASINO_HANDLE_RE.test(handle) ||
        typeof keyHash !== "string" || !CASINO_HEX64_RE.test(keyHash) ||
        typeof recHash !== "string" || !CASINO_HEX64_RE.test(recHash) ||
        keyHash.toLowerCase() === recHash.toLowerCase()
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const payloadHash = await sha256hex("POST /api/casino/admin/accounts" + JSON.stringify({ request_id: requestId, handle, key_sha256: keyHash.toLowerCase(), recovery_sha256: recHash.toLowerCase() }));
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, "admin", requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const accountId = randomHex(16);
      const respBody = { request_id: requestId, account_id: accountId, handle, grant: CASINO_GRANT };
      try {
        await db.batch([
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN (SELECT COUNT(*) FROM casino_accounts WHERE kind = 'muse') < ? THEN 1 ELSE 0 END").bind(CASINO_ROSTER_CAP),
          db.prepare("INSERT INTO casino_accounts(id, kind, handle, created_at) VALUES (?, 'muse', ?, ?)").bind(accountId, handle, nowSec),
          db.prepare("INSERT INTO casino_credentials(account_id, key_hash, recovery_hash) VALUES (?,?,?)").bind(accountId, keyHash.toLowerCase(), recHash.toLowerCase()),
          db.prepare("INSERT INTO casino_ledger(id, kind, src, dst, amount, created_at) VALUES (?, 'mint', NULL, ?, ?, ?)").bind("grant:" + accountId, accountId, CASINO_GRANT, nowSec),
          receiptInsert(db, "admin", requestId, payloadHash, 201, respBody, nowSec),
          auditInsert(db, "admin", "account_enrolled", accountId, { handle, grant: CASINO_GRANT }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        const taken = await db.prepare("SELECT id FROM casino_accounts WHERE handle = ?").bind(handle).first().catch(() => null);
        if (taken) return json({ error: "handle_taken" }, 409, origin);
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 201, origin);
    }

    // --- admin: reset credentials / disable-enable ---
    const adminAcctMatch = url.pathname.match(/^\/api\/casino\/admin\/accounts\/([0-9a-f]{32})\/(credentials|status)$/);
    if (adminAcctMatch && req.method === "POST") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [{ scope: "global:admin", limit: 10 }]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const accountId = adminAcctMatch[1];
      const action = adminAcctMatch[2];
      const requestId = raw.request_id;
      if (typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId)) return json({ error: "invalid_request" }, 400, origin);
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const acct = await db.prepare("SELECT id, auth_version FROM casino_accounts WHERE id = ? AND kind = 'muse'").bind(accountId).first<{ id: string; auth_version: number }>().catch(() => null);
      if (!acct) return json({ error: "not_found" }, 404, origin);
      let payloadHash: string, respBody: Record<string, unknown>, stmts;
      if (action === "credentials") {
        const keyHash = raw.key_sha256, recHash = raw.recovery_sha256;
        if (
          typeof keyHash !== "string" || !CASINO_HEX64_RE.test(keyHash) ||
          typeof recHash !== "string" || !CASINO_HEX64_RE.test(recHash) ||
          keyHash.toLowerCase() === recHash.toLowerCase() || typeof raw.reason !== "string"
        ) {
          return json({ error: "invalid_request" }, 400, origin);
        }
        payloadHash = await sha256hex("POST credentials" + JSON.stringify({ account_id: accountId, request_id: requestId, key_sha256: keyHash.toLowerCase(), recovery_sha256: recHash.toLowerCase() }));
        respBody = { account_id: accountId, auth_version: acct.auth_version + 1, reset: true };
        stmts = [
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_accounts WHERE id = ? AND kind = 'muse') THEN 1 ELSE 0 END").bind(accountId),
          db.prepare("UPDATE casino_credentials SET key_hash = ?, recovery_hash = ? WHERE account_id = ?").bind(keyHash.toLowerCase(), recHash.toLowerCase(), accountId),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          db.prepare("UPDATE casino_accounts SET auth_version = auth_version + 1 WHERE id = ?").bind(accountId),
          receiptInsert(db, "admin", requestId, payloadHash, 200, respBody, nowSec),
          auditInsert(db, "admin", "credentials_reset", accountId, { reason: (raw.reason as string).slice(0, 200) }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ];
      } else {
        const disabled = raw.disabled;
        if ((disabled !== 0 && disabled !== 1) || typeof raw.reason !== "string") return json({ error: "invalid_request" }, 400, origin);
        payloadHash = await sha256hex("POST status" + JSON.stringify({ account_id: accountId, request_id: requestId, disabled }));
        respBody = { account_id: accountId, disabled, auth_version: acct.auth_version + 1 };
        stmts = [
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_accounts WHERE id = ? AND kind = 'muse') THEN 1 ELSE 0 END").bind(accountId),
          db.prepare("UPDATE casino_accounts SET disabled = ?, auth_version = auth_version + 1 WHERE id = ?").bind(disabled, accountId),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          receiptInsert(db, "admin", requestId, payloadHash, 200, respBody, nowSec),
          auditInsert(db, "admin", disabled === 1 ? "account_disabled" : "account_enabled", accountId, { reason: (raw.reason as string).slice(0, 200) }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ];
      }
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, "admin", requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      try {
        await db.batch(stmts);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 200, origin);
    }

    // --- admin: mint invite codes (owner only) ---
    if (url.pathname === "/api/casino/admin/invites" && req.method === "POST") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [{ scope: "global:admin", limit: 10 }]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const requestId = raw.request_id;
      const count = raw.count === undefined ? 1 : raw.count;
      const label = raw.label === undefined ? "" : raw.label;
      const days = raw.expires_in_days === undefined ? CASINO_INVITE_DEFAULT_DAYS : raw.expires_in_days;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > CASINO_INVITE_MAX_COUNT ||
        typeof label !== "string" || label.length > 80 ||
        typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > CASINO_INVITE_MAX_DAYS
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const expiresAt = nowSec + days * 86400;
      const payloadHash = await sha256hex("POST /api/casino/admin/invites" + JSON.stringify({ request_id: requestId, count, label, expires_in_days: days }));
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, "admin", requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const invites: { id: string; code: string; expires_at: number; label: string }[] = [];
      const stmts: D1PreparedStatement[] = [];
      for (let i = 0; i < count; i++) {
        const id = randomHex(16);
        const code = randomHex(16);
        invites.push({ id, code, expires_at: expiresAt, label });
        stmts.push(
          db.prepare("INSERT INTO casino_invites(id, code_hash, label, created_at, expires_at) VALUES (?,?,?,?,?)")
            .bind(id, await sha256hex(code), label, nowSec, expiresAt),
        );
      }
      const respBody = { request_id: requestId, invites };
      stmts.push(
        receiptInsert(db, "admin", requestId, payloadHash, 201, respBody, nowSec),
        auditInsert(db, "admin", "invites_minted", requestId, { count, label, expires_at: expiresAt, ids: invites.map((v) => v.id) }, nowSec),
      );
      try {
        await db.batch(stmts);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 201, origin);
    }

    // --- admin: list invite codes (owner only; never returns plaintext codes) ---
    if (url.pathname === "/api/casino/admin/invites" && req.method === "GET") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
      const rows = await env.MUSEBOOK_DB.prepare(
        "SELECT id, label, created_at, expires_at, used_at, used_by_account_id, revoked_at FROM casino_invites ORDER BY created_at DESC LIMIT ?",
      ).bind(limit).all<{ id: string; label: string; created_at: number; expires_at: number; used_at: number | null; used_by_account_id: string | null; revoked_at: number | null }>().catch(() => null);
      if (!rows) return json({ error: "temporarily_unavailable" }, 429, origin);
      return json({ invites: rows.results || [] }, 200, origin);
    }

    // --- admin: revoke an unused invite code (owner only) ---
    if (url.pathname === "/api/casino/admin/invites/revoke" && req.method === "POST") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [{ scope: "global:admin", limit: 10 }]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const requestId = raw.request_id, inviteId = raw.invite_id;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof inviteId !== "string" || !/^[0-9a-f]{32}$/.test(inviteId)
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const payloadHash = await sha256hex("POST /api/casino/admin/invites/revoke" + JSON.stringify({ request_id: requestId, invite_id: inviteId }));
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, "admin", requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const respBody = { request_id: requestId, invite_id: inviteId, revoked: true };
      try {
        await db.batch([
          db.prepare("UPDATE casino_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(nowSec, inviteId),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          receiptInsert(db, "admin", requestId, payloadHash, 200, respBody, nowSec),
          auditInsert(db, "admin", "invite_revoked", inviteId, {}, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        const row = await db.prepare("SELECT used_at FROM casino_invites WHERE id = ?").bind(inviteId).first<{ used_at: number | null }>().catch(() => null);
        if (!row) return json({ error: "not_found" }, 404, origin);
        if (row.used_at !== null) return json({ error: "already_used" }, 409, origin);
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 200, origin);
    }

    // --- public: redeem an invite code for a one-time 500-token grant ---
    // The client generates its own API + recovery keys; only hashes reach the server.
    if (url.pathname === "/api/casino/invites/redeem" && req.method === "POST") {
      const iph = await ipHash(req);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [
        { scope: "ip:" + iph + ":redeem", limit: 10 },
        { scope: "global:redeem", limit: 120 },
      ]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const requestId = raw.request_id, code = raw.code, handle = raw.handle, keyHash = raw.key_sha256, recHash = raw.recovery_sha256;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof code !== "string" || !CASINO_INVITE_RE.test(code) ||
        typeof handle !== "string" || !CASINO_HANDLE_RE.test(handle) ||
        typeof keyHash !== "string" || !CASINO_HEX64_RE.test(keyHash) ||
        typeof recHash !== "string" || !CASINO_HEX64_RE.test(recHash) ||
        keyHash.toLowerCase() === recHash.toLowerCase()
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const codeHash = await sha256hex(code.toLowerCase());
      const payloadHash = await sha256hex("POST /api/casino/invites/redeem" + JSON.stringify({ request_id: requestId, code_hash: codeHash, handle, key_sha256: keyHash.toLowerCase(), recovery_sha256: recHash.toLowerCase() }));
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, "invite:" + codeHash.slice(0, 16), requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const accountId = randomHex(16);
      const respBody = { request_id: requestId, account_id: accountId, handle, grant: CASINO_GRANT };
      // NOTE: D1 enforces foreign keys (stock SQLite does not). The account row
      // must exist before the invite's used_by_account_id references it.
      try {
        await db.batch([
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?) THEN 1 ELSE 0 END").bind(codeHash, nowSec),
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN (SELECT COUNT(*) FROM casino_accounts WHERE kind = 'muse') < ? THEN 1 ELSE 0 END").bind(CASINO_ROSTER_CAP),
          db.prepare("INSERT INTO casino_accounts(id, kind, handle, created_at) VALUES (?, 'muse', ?, ?)").bind(accountId, handle, nowSec),
          db.prepare("INSERT INTO casino_credentials(account_id, key_hash, recovery_hash) VALUES (?,?,?)").bind(accountId, keyHash.toLowerCase(), recHash.toLowerCase()),
          db.prepare("UPDATE casino_invites SET used_at = ?, used_by_account_id = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(nowSec, accountId, codeHash, nowSec),
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_invites WHERE code_hash = ? AND used_by_account_id = ?) THEN 1 ELSE 0 END").bind(codeHash, accountId),
          db.prepare("INSERT INTO casino_ledger(id, kind, src, dst, amount, created_at) VALUES (?, 'mint', NULL, ?, ?, ?)").bind("grant:" + accountId, accountId, CASINO_GRANT, nowSec),
          receiptInsert(db, "invite:" + codeHash.slice(0, 16), requestId, payloadHash, 201, respBody, nowSec),
          auditInsert(db, "invite", "invite_redeemed", accountId, { handle, grant: CASINO_GRANT }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        const inv = await db.prepare("SELECT id FROM casino_invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(codeHash, nowSec).first().catch(() => null);
        if (!inv) return json({ error: "invite_invalid" }, 410, origin);
        const taken = await db.prepare("SELECT id FROM casino_accounts WHERE handle = ?").bind(handle).first().catch(() => null);
        if (taken) return json({ error: "handle_taken" }, 409, origin);
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 201, origin);
    }

    // --- admin: reconciliation ---
    if (url.pathname === "/api/casino/admin/reconciliation" && req.method === "GET") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      const db = env.MUSEBOOK_DB;
      const violations: string[] = [];
      try {
        const sums = await db.prepare(
          "SELECT (SELECT COALESCE(SUM(amount),0) FROM casino_ledger WHERE kind = 'mint') AS minted, " +
          "(SELECT COALESCE(SUM(balance),0) FROM casino_balances) AS total",
        ).bind().first<{ minted: number; total: number }>();
        const minted = sums?.minted ?? 0, total = sums?.total ?? 0;
        if (minted !== total) violations.push("supply_mismatch");
        const neg = await db.prepare("SELECT account_id FROM casino_balances WHERE balance < 0 LIMIT 5").bind().all<{ account_id: string }>();
        for (const r of neg.results || []) violations.push("negative_balance:" + r.account_id);
        const grantless = await db.prepare(
          "SELECT a.id FROM casino_accounts a LEFT JOIN casino_ledger l ON l.dst = a.id AND l.kind = 'mint' " +
          "WHERE a.kind = 'muse' GROUP BY a.id HAVING COUNT(l.id) <> 1 LIMIT 5",
        ).bind().all<{ id: string }>();
        for (const r of grantless.results || []) violations.push("grant_count:" + r.id);
        const betless = await db.prepare(
          "SELECT e.id FROM casino_entries e LEFT JOIN casino_ledger l ON l.entry_id = e.id AND l.kind = 'bet' WHERE l.id IS NULL LIMIT 5",
        ).bind().all<{ id: string }>();
        for (const r of betless.results || []) violations.push("entry_without_bet:" + r.id);
        const unpaid = await db.prepare(
          "SELECT o.entry_id FROM casino_outcomes o LEFT JOIN casino_ledger l ON l.entry_id = o.entry_id AND l.kind = 'payout' " +
          "WHERE o.payout > 0 AND l.id IS NULL LIMIT 5",
        ).bind().all<{ entry_id: string }>();
        for (const r of unpaid.results || []) violations.push("outcome_without_payout:" + r.entry_id);
        const open = await db.prepare(
          "SELECT g.id FROM casino_games g LEFT JOIN casino_resolutions r ON r.game_id = g.id " +
          "WHERE g.state = 'settled' AND (r.game_id IS NULL OR (SELECT balance FROM casino_balances WHERE account_id = g.escrow_id) <> 0) LIMIT 5",
        ).bind().all<{ id: string }>();
        for (const r of open.results || []) violations.push("settled_not_clean:" + r.id);
        const potBad = await db.prepare(
          "SELECT r.game_id FROM casino_resolutions r WHERE r.pot <> " +
          "(SELECT COALESCE(SUM(o.payout),0) FROM casino_outcomes o WHERE o.game_id = r.game_id) LIMIT 5",
        ).bind().all<{ game_id: string }>();
        for (const r of potBad.results || []) violations.push("pot_payout_mismatch:" + r.game_id);
        return json({ ok: violations.length === 0, minted_supply: minted, total_balances: total, violations }, 200, origin);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
    }

    // --- admin: audit log ---
    if (url.pathname === "/api/casino/admin/audit" && req.method === "GET") {
      if (!(await requireCasinoAdmin(req, env))) return json({ error: "unauthorized" }, 401, origin);
      const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);
      const afterSeq = parseInt(url.searchParams.get("after_seq") || "0", 10) || 0;
      const rows = await env.MUSEBOOK_DB.prepare(
        "SELECT seq, operation_id, actor, event, entity_id, detail_json, created_at FROM casino_audit WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      ).bind(afterSeq, limit).all<{ seq: number; operation_id: string; actor: string; event: string; entity_id: string; detail_json: string; created_at: number }>().catch(() => null);
      if (!rows) return json({ error: "temporarily_unavailable" }, 429, origin);
      const items = rows.results || [];
      return json({ items, next_after_seq: items.length ? items[items.length - 1].seq : afterSeq }, 200, origin);
    }

    // --- casino session issuance (persistent API key -> 30-day session) ---
    if (url.pathname === "/api/casino/sessions" && req.method === "POST") {
      const iph = await ipHash(req);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [
        { scope: "ip:" + iph + ":auth", limit: 10 },
        { scope: "global:auth", limit: 100 },
      ]))) return rateLimited(origin);
      const t = bearerToken(req);
      if (!t) return json({ error: "unauthorized" }, 401, origin);
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const cred = await db.prepare(
        "SELECT c.account_id AS account_id, a.disabled AS disabled, a.auth_version AS auth_version " +
        "FROM casino_credentials c JOIN casino_accounts a ON a.id = c.account_id WHERE c.key_hash = ?",
      ).bind(await sha256hex(t)).first<{ account_id: string; disabled: number; auth_version: number }>().catch(() => null);
      if (!cred || cred.disabled !== 0) return json({ error: "unauthorized" }, 401, origin);
      const token = randomToken();
      const th = await sha256hex(token);
      const expMs = Date.now() + CASINO_SESSION_DAYS * 86400 * 1000;
      try {
        await db.batch([
          db.prepare("INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_accounts WHERE id = ? AND disabled = 0) THEN 1 ELSE 0 END").bind(cred.account_id),
          db.prepare("INSERT INTO sessions(token_hash, created_at, expires_at) VALUES (?,?,?)").bind(th, Date.now(), expMs),
          db.prepare("INSERT INTO casino_sessions(token_hash, account_id, auth_version) VALUES (?,?,?)").bind(th, cred.account_id, cred.auth_version),
          auditInsert(db, cred.account_id, "session_issued", cred.account_id, {}, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json({ token, expires_at_ms: expMs, account_id: cred.account_id }, 200, origin);
    }

    // --- credential rotation (API key or recovery key) ---
    if (url.pathname === "/api/casino/credentials/rotate" && req.method === "POST") {
      const iph = await ipHash(req);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [
        { scope: "ip:" + iph + ":auth", limit: 10 },
        { scope: "global:auth", limit: 100 },
      ]))) return rateLimited(origin);
      const t = bearerToken(req);
      if (!t) return json({ error: "unauthorized" }, 401, origin);
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const h = await sha256hex(t);
      const cred = await db.prepare(
        "SELECT c.account_id AS account_id, a.disabled AS disabled, a.auth_version AS auth_version " +
        "FROM casino_credentials c JOIN casino_accounts a ON a.id = c.account_id WHERE c.key_hash = ? OR c.recovery_hash = ?",
      ).bind(h, h).first<{ account_id: string; disabled: number; auth_version: number }>().catch(() => null);
      if (!cred || cred.disabled !== 0) return json({ error: "unauthorized" }, 401, origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const requestId = raw.request_id, keyHash = raw.key_sha256, recHash = raw.recovery_sha256;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof keyHash !== "string" || !CASINO_HEX64_RE.test(keyHash) ||
        typeof recHash !== "string" || !CASINO_HEX64_RE.test(recHash) ||
        keyHash.toLowerCase() === recHash.toLowerCase()
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const payloadHash = await sha256hex("POST /api/casino/credentials/rotate" + JSON.stringify({ request_id: requestId, key_sha256: keyHash.toLowerCase(), recovery_sha256: recHash.toLowerCase() }));
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, cred.account_id, requestId, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const newVersion = cred.auth_version + 1;
      const respBody = { account_id: cred.account_id, auth_version: newVersion, rotated: true };
      try {
        await db.batch([
          db.prepare("UPDATE casino_credentials SET key_hash = ?, recovery_hash = ? WHERE account_id = ?").bind(keyHash.toLowerCase(), recHash.toLowerCase(), cred.account_id),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          db.prepare("UPDATE casino_accounts SET auth_version = ? WHERE id = ? AND auth_version = ?").bind(newVersion, cred.account_id, cred.auth_version),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          receiptInsert(db, cred.account_id, requestId, payloadHash, 200, respBody, nowSec),
          auditInsert(db, cred.account_id, "credentials_rotated", cred.account_id, { auth_version: newVersion }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 200, origin);
    }

    // --- me ---
    if (url.pathname === "/api/casino/me" && req.method === "GET") {
      const sess = await casinoSession(req, env);
      if (!sess) return json({ error: "unauthorized" }, 401, origin);
      const db = env.MUSEBOOK_DB;
      try {
        const acct = await db.prepare("SELECT handle FROM casino_accounts WHERE id = ?").bind(sess.account_id).first<{ handle: string }>();
        const balance = await casinoBalance(db, sess.account_id);
        const locked = await lockedTokens(db, sess.account_id);
        return json({ account_id: sess.account_id, handle: acct?.handle ?? null, balance, locked_tokens: locked }, 200, origin);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
    }

    // --- my ledger ---
    if (url.pathname === "/api/casino/me/ledger" && req.method === "GET") {
      const sess = await casinoSession(req, env);
      if (!sess) return json({ error: "unauthorized" }, 401, origin);
      const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);
      const afterSeq = parseInt(url.searchParams.get("after_seq") || "0", 10) || 0;
      const rows = await env.MUSEBOOK_DB.prepare(
        "SELECT seq, id, kind, src, dst, amount, game_id, entry_id, created_at FROM casino_ledger " +
        "WHERE (src = ? OR dst = ?) AND seq > ? ORDER BY seq ASC LIMIT ?",
      ).bind(sess.account_id, sess.account_id, afterSeq, limit).all().catch(() => null);
      if (!rows) return json({ error: "temporarily_unavailable" }, 429, origin);
      const items = rows.results || [];
      return json({ items, next_after_seq: items.length ? (items[items.length - 1] as { seq: number }).seq : afterSeq }, 200, origin);
    }

    // --- idempotency receipt lookup ---
    const reqMatch = url.pathname.match(/^\/api\/casino\/requests\/([A-Za-z0-9_-]{1,80})$/);
    if (reqMatch && req.method === "GET") {
      const sess = await casinoSession(req, env);
      if (!sess) return json({ error: "unauthorized" }, 401, origin);
      const row = await env.MUSEBOOK_DB.prepare("SELECT response_json FROM casino_requests WHERE actor = ? AND request_id = ?")
        .bind(sess.account_id, reqMatch[1]).first<{ response_json: string }>().catch(() => null);
      if (!row) return json({ error: "not_found" }, 404, origin);
      const parsed = JSON.parse(row.response_json) as { status: number; body: unknown };
      return json(parsed.body, parsed.status, origin);
    }

    // --- list games (public) ---
    if (url.pathname === "/api/casino/games" && req.method === "GET") {
      const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);
      const state = url.searchParams.get("state");
      if (state && state !== "open" && state !== "closed" && state !== "settled") return json({ error: "invalid_request" }, 400, origin);
      const after = url.searchParams.get("after") || "";
      let q = "SELECT g.id AS id, g.kind AS kind, g.rules_version AS rules_version, g.opens_at AS opens_at, g.closes_at AS closes_at, " +
        "g.entry_fee AS entry_fee, g.max_entries AS max_entries, g.commitment AS commitment, g.state AS state, " +
        "(SELECT COUNT(*) FROM casino_entries e WHERE e.game_id = g.id) AS entry_count, " +
        "(SELECT COALESCE(SUM(amount),0) FROM casino_ledger l WHERE l.game_id = g.id AND l.kind = 'bet') AS pot " +
        "FROM casino_games g";
      const params: (string | number)[] = [];
      const conds: string[] = [];
      if (state) { conds.push("g.state = ?"); params.push(state); }
      if (after) { conds.push("g.id < ?"); params.push(after); }
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      q += " ORDER BY g.id DESC LIMIT ?";
      params.push(limit);
      const rows = await env.MUSEBOOK_DB.prepare(q).bind(...params).all().catch(() => null);
      if (!rows) return json({ error: "temporarily_unavailable" }, 429, origin);
      const items = (rows.results || []).map((g: unknown) => gameShape(g as Parameters<typeof gameShape>[0]));
      return json({ items, next_cursor: items.length ? items[items.length - 1].id : null }, 200, origin);
    }

    // --- game detail / my entry / results ---
    const gameSubMatch = url.pathname.match(/^\/api\/casino\/games\/([^/]+)(\/(my-entry|results))?$/);
    if (gameSubMatch && req.method === "GET") {
      const gameId = decodeURIComponent(gameSubMatch[1]);
      const sub = gameSubMatch[3] || "";
      const grow = await env.MUSEBOOK_DB.prepare(
        "SELECT g.id AS id, g.kind AS kind, g.rules_version AS rules_version, g.opens_at AS opens_at, g.closes_at AS closes_at, " +
        "g.entry_fee AS entry_fee, g.max_entries AS max_entries, g.commitment AS commitment, g.state AS state, " +
        "(SELECT COUNT(*) FROM casino_entries e WHERE e.game_id = g.id) AS entry_count, " +
        "(SELECT COALESCE(SUM(amount),0) FROM casino_ledger l WHERE l.game_id = g.id AND l.kind = 'bet') AS pot " +
        "FROM casino_games g WHERE g.id = ?",
      ).bind(gameId).first().catch(() => null);
      if (!grow) return json({ error: "not_found" }, 404, origin);
      if (!sub) return json({ game: gameShape(grow as Parameters<typeof gameShape>[0]) }, 200, origin);
      if (sub === "my-entry") {
        const sess = await casinoSession(req, env);
        if (!sess) return json({ error: "unauthorized" }, 401, origin);
        const e = await env.MUSEBOOK_DB.prepare(
          "SELECT e.id AS id, e.game_id AS game_id, e.account_id AS account_id, e.choice AS choice, e.nonce AS nonce, e.created_at AS created_at, " +
          "o.score AS score, o.payout AS payout, o.result_json AS result_json " +
          "FROM casino_entries e LEFT JOIN casino_outcomes o ON o.entry_id = e.id WHERE e.game_id = ? AND e.account_id = ?",
        ).bind(gameId, sess.account_id).first<{ id: string; game_id: string; account_id: string; choice: number; nonce: string; created_at: number; score: number | null; payout: number | null; result_json: string | null }>().catch(() => null);
        if (!e) return json({ entry: null }, 200, origin);
        return json({
          entry: {
            id: e.id, game_id: e.game_id, account_id: e.account_id, choice: e.choice, nonce: e.nonce, created_at: e.created_at,
            outcome: e.score === null ? null : { score: e.score, payout: e.payout, result: JSON.parse(e.result_json || "{}") },
          },
        }, 200, origin);
      }
      // results (public, settled only)
      const res = await env.MUSEBOOK_DB.prepare("SELECT mode, seed_reveal, manifest_hash, entry_count, pot FROM casino_resolutions WHERE game_id = ?")
        .bind(gameId).first<{ mode: string; seed_reveal: string; manifest_hash: string; entry_count: number; pot: number }>().catch(() => null);
      if (!res) return json({ error: "not_settled" }, 409, origin);
      const orows = await env.MUSEBOOK_DB.prepare(
        "SELECT o.entry_id AS entry_id, e.account_id AS account_id, o.score AS score, o.payout AS payout, o.result_json AS result_json " +
        "FROM casino_outcomes o JOIN casino_entries e ON e.id = o.entry_id WHERE o.game_id = ?",
      ).bind(gameId).all<{ entry_id: string; account_id: string; score: number; payout: number; result_json: string }>().catch(() => null);
      const erows = await env.MUSEBOOK_DB.prepare("SELECT account_id, choice, nonce FROM casino_entries WHERE game_id = ? ORDER BY account_id ASC")
        .bind(gameId).all<{ account_id: string; choice: number; nonce: string }>().catch(() => null);
      if (!orows || !erows) return json({ error: "temporarily_unavailable" }, 429, origin);
      return json({
        game: gameShape(grow as Parameters<typeof gameShape>[0]),
        mode: res.mode,
        seed_reveal: res.seed_reveal,
        manifest_hash: res.manifest_hash,
        manifest: (erows.results || []).map((x) => [x.account_id, x.choice, x.nonce]),
        pot: res.pot,
        outcomes: (orows.results || []).map((o) => ({
          entry_id: o.entry_id, account_id: o.account_id,
          result: JSON.parse(o.result_json), score: o.score, payout: o.payout,
        })),
      }, 200, origin);
    }

    // --- enter a round ---
    const enterMatch = url.pathname.match(/^\/api\/casino\/games\/([^/]+)\/entries$/);
    if (enterMatch && req.method === "POST") {
      const sess = await casinoSession(req, env);
      if (!sess) return json({ error: "unauthorized" }, 401, origin);
      const iph = await ipHash(req);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [
        { scope: "acct:" + sess.account_id + ":mut", limit: 30 },
        { scope: "ip:" + iph + ":mut", limit: 120 },
        { scope: "global:mut", limit: 500 },
      ]))) return rateLimited(origin);
      const raw = await readCasinoBody(req);
      if (!raw) return json({ error: "invalid_request" }, 400, origin);
      const gameId = decodeURIComponent(enterMatch[1]);
      const requestId = raw.request_id, nonce = raw.nonce, choice = raw.choice;
      if (
        typeof requestId !== "string" || !CASINO_REQUEST_ID_RE.test(requestId) ||
        typeof nonce !== "string" || !CASINO_HEX64_RE.test(nonce) ||
        choice !== 0
      ) {
        return json({ error: "invalid_request" }, 400, origin);
      }
      const db = env.MUSEBOOK_DB;
      const nowSec = unixNow();
      const payloadHash = await sha256hex("POST /api/casino/games/:id/entries" + JSON.stringify({ game_id: gameId, nonce: (nonce as string).toLowerCase(), choice: 0 }));
      const rejectReason = async (): Promise<string | null> => {
        const game = await db.prepare("SELECT id, state, opens_at, closes_at, max_entries, entry_fee FROM casino_games WHERE id = ?").bind(gameId)
          .first<{ id: string; state: string; opens_at: number; closes_at: number; max_entries: number; entry_fee: number }>().catch(() => null);
        if (!game) return "not_found";
        if (game.state !== "open" || nowSec < game.opens_at || nowSec >= game.closes_at) return "entry_closed";
        const cnt = await db.prepare("SELECT COUNT(*) AS c FROM casino_entries WHERE game_id = ?").bind(gameId).first<{ c: number }>().catch(() => null);
        if ((cnt?.c ?? 0) >= game.max_entries) return "round_full";
        const mine = await db.prepare("SELECT id FROM casino_entries WHERE game_id = ? AND account_id = ?").bind(gameId, sess.account_id).first().catch(() => null);
        if (mine) return "already_entered";
        if ((await casinoBalance(db, sess.account_id).catch(() => -1)) < game.entry_fee) return "insufficient_funds";
        return null;
      };
      let idem: IdemResult;
      try {
        idem = await checkIdempotency(db, sess.account_id, requestId as string, payloadHash);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      if (idem.kind === "conflict") return json({ error: "idempotency_conflict" }, 409, origin);
      if (idem.kind === "replay") return json(idem.body, idem.status, origin);
      const pre = await rejectReason();
      if (pre === "not_found") return json({ error: "not_found" }, 404, origin);
      if (pre) return json({ error: pre }, 409, origin);
      const game = await db.prepare("SELECT entry_fee FROM casino_games WHERE id = ?").bind(gameId).first<{ entry_fee: number }>().catch(() => null);
      const fee = game?.entry_fee ?? DICE_FEE;
      const entryId = randomHex(16);
      const respBody = { request_id: requestId, entry_id: entryId, game_id: gameId, stake: fee, accepted_at: nowSec };
      try {
        await db.batch([
          db.prepare(
            "INSERT INTO casino_guards(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM casino_sessions cs JOIN sessions s ON s.token_hash = cs.token_hash " +
            "JOIN casino_accounts a ON a.id = cs.account_id WHERE cs.token_hash = ? AND s.expires_at > ? AND a.disabled = 0 AND cs.auth_version = a.auth_version AND a.id = ?) THEN 1 ELSE 0 END",
          ).bind(sess.token_hash, Date.now(), sess.account_id),
          receiptInsert(db, sess.account_id, requestId as string, payloadHash, 201, respBody, nowSec),
          db.prepare("INSERT INTO casino_entries(id, game_id, account_id, choice, nonce, created_at) VALUES (?,?,?,?,?,?)")
            .bind(entryId, gameId, sess.account_id, 0, (nonce as string).toLowerCase(), nowSec),
          db.prepare(
            "INSERT INTO casino_ledger(id,kind,src,dst,amount,game_id,entry_id,created_at) " +
            "SELECT ?, 'bet', e.account_id, g.escrow_id, g.entry_fee, g.id, e.id, ? FROM casino_entries e JOIN casino_games g ON g.id = e.game_id WHERE e.id = ?",
          ).bind("bet:" + entryId, nowSec, entryId),
          db.prepare("INSERT INTO casino_guards(ok) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE 0 END)"),
          auditInsert(db, sess.account_id, "entry_accepted", entryId, { game_id: gameId, stake: fee }, nowSec),
          db.prepare("DELETE FROM casino_guards"),
        ]);
      } catch {
        const r2 = await rejectReason();
        if (r2 === "not_found") return json({ error: "not_found" }, 404, origin);
        if (r2) return json({ error: r2 }, 409, origin);
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
      return json(respBody, 201, origin);
    }

    // --- advance: provision + close + settle due rounds ---
    if (url.pathname === "/api/casino/advance" && req.method === "POST") {
      const sess = await casinoSession(req, env);
      if (!sess) return json({ error: "unauthorized" }, 401, origin);
      const iph = await ipHash(req);
      if (!(await casinoRateLimit(env.MUSEBOOK_DB, [
        { scope: "acct:" + sess.account_id + ":advance", limit: 2 },
        { scope: "ip:" + iph + ":mut", limit: 120 },
        { scope: "global:mut", limit: 500 },
      ]))) return rateLimited(origin);
      try {
        const out = await casinoAdvance(env.MUSEBOOK_DB, env, unixNow());
        return json(out, 200, origin);
      } catch {
        return json({ error: "temporarily_unavailable" }, 429, origin);
      }
    }

    return json({ error: "not found" }, 404, origin);
  },
  // Hourly: provision upcoming rounds, close due rounds, settle closed ones.
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const db = env.MUSEBOOK_DB;
    const nowSec = unixNow();
    try {
      await casinoAdvance(db, env, nowSec);
      await db
        .prepare("DELETE FROM casino_limits WHERE bucket < ?")
        .bind(Math.floor(nowSec / 60) - 1440)
        .run();
    } catch {
      // Never throw from the scheduled handler.
    }
  },
};

