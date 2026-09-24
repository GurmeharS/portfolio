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

const CASINO_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Musebook Casino</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#222}
.card{border:1px solid #ddd;border-radius:8px;padding:1em;margin:1em 0}button{padding:.4em 1em;cursor:pointer}
input{padding:.4em;width:100%;box-sizing:border-box;margin:.3em 0}pre{background:#f6f6f6;padding:.6em;overflow:auto;font-size:.85em}</style>
</head><body>
<h1>&#127920; Musebook Casino</h1>
<div class="card"><h3>1. Log in</h3>
<input id="key" type="password" placeholder="Paste your casino API key" autocomplete="off">
<button onclick="login()">Get session</button>
<div id="me"></div></div>
<div class="card"><h3>2. Open rounds</h3><div id="games"></div></div>
<div class="card"><h3>3. Results</h3><div id="results"></div></div>
<script>
let token=null,account=null;
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
if(token)opts.headers['Authorization']='Bearer '+token;
const r=await fetch('/api/casino'+path,opts);const b=await r.json().catch(()=>({}));return {status:r.status,body:b};}
function hex(n){const b=new Uint8Array(n);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function login(){const key=document.getElementById('key').value.trim();if(!key)return;
const r=await api('/sessions',{method:'POST',body:'{}',headers:{'Authorization':'Bearer '+key}});
if(r.status!==200){document.getElementById('me').textContent='Login failed: '+(r.body.error||r.status);return;}
token=r.body.token;account=r.body.account_id;refresh();}
async function refresh(){const me=await api('/me');if(me.status!==200){document.getElementById('me').textContent='Session expired';return;}
document.getElementById('me').innerHTML='<b>'+me.body.handle+'</b> — balance <b>'+me.body.balance+'</b> tokens (locked: '+me.body.locked_tokens+')';
const g=await api('/games?state=open&limit=20');const div=document.getElementById('games');div.innerHTML='';
(g.body.items||[]).forEach(x=>{const d=document.createElement('div');d.className='card';
d.innerHTML='<b>'+x.id+'</b> — entry '+x.entry_fee+' tokens, '+x.entry_count+'/'+x.max_entries+' entered, closes '+new Date(x.closes_at*1000).toLocaleString();
const b=document.createElement('button');b.textContent='Enter (10 tokens)';b.onclick=()=>enter(x.id);d.appendChild(b);div.appendChild(d);});
const s=await api('/games?state=settled&limit=5');const rd=document.getElementById('results');rd.innerHTML='';
(s.body.items||[]).forEach(x=>{const d=document.createElement('div');d.innerHTML='<b>'+x.id+'</b> pot '+x.pot+' ';
const b=document.createElement('button');b.textContent='Results';b.onclick=async()=>{const r=await api('/games/'+encodeURIComponent(x.id)+'/results');
d.appendChild(Object.assign(document.createElement('pre'),{textContent:JSON.stringify(r.body,null,1)}));};d.appendChild(b);rd.appendChild(d);});}
async function enter(id){const r=await api('/games/'+encodeURIComponent(id)+'/entries',{method:'POST',
body:JSON.stringify({request_id:hex(16),nonce:hex(32),choice:0})});
alert(r.status===201?'Entered! Entry '+r.body.entry_id:'Failed: '+(r.body.error||r.status));refresh();}
</script></body></html>`;

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

