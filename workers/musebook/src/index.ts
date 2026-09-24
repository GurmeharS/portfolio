export interface Env {
  MUSEBOOK_DB: D1Database;
  // Plaintext shared passcode, set as a Worker secret via the Cloudflare API.
  // Never committed to git — the repo only reads the env var.
  MUSEBOOK_PASSCODE: string;
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

    return json({ error: "not found" }, 404, origin);
  },
};
