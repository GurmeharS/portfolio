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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    if (url.pathname === "/api/posts" && req.method === "GET") {
      if (!(await requireSession(req, env))) {
        return json({ error: "unauthorized" }, 401, origin);
      }
      const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);
      const before = parseInt(url.searchParams.get("before") || "", 10);
      let q = "SELECT id, author, body, created_at, pinned FROM posts";
      const params: number[] = [];
      if (Number.isFinite(before)) {
        q += " WHERE id < ?";
        params.push(before);
      }
      q += " ORDER BY pinned DESC, id DESC LIMIT ?";
      params.push(limit);
      const rows = await env.MUSEBOOK_DB.prepare(q)
        .bind(...params)
        .all<{ id: number; author: string; body: string; created_at: number; pinned: number }>();
      const list = rows.results || [];
      const ids = list.map((p) => p.id);
      const scores: Record<number, number> = {};
      const myVotes: Record<number, number> = {};
      const commentsByPost: Record<
        number,
        { id: number; author: string; body: string; created_at: number }[]
      > = {};
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const vh = await voterHash(req);
        const scoreRows = await env.MUSEBOOK_DB.prepare(
          `SELECT post_id, COALESCE(SUM(dir), 0) AS score FROM votes WHERE post_id IN (${placeholders}) GROUP BY post_id`,
        )
          .bind(...ids)
          .all<{ post_id: number; score: number }>();
        for (const r of scoreRows.results || []) scores[r.post_id] = r.score;
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
      const posts = list.map((p) => ({
        ...p,
        score: scores[p.id] ?? 0,
        my_vote: myVotes[p.id] ?? 0,
        comments: commentsByPost[p.id] ?? [],
      }));
      return json({ posts }, 200, origin);
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
        "INSERT INTO posts (author, body, created_at) VALUES (?, ?, ?) RETURNING id",
      )
        .bind(author, text, now)
        .first<{ id: number }>();
      return json({ id: row?.id, created_at: now }, 200, origin);
    }

    return json({ error: "not found" }, 404, origin);
  },
};
