export interface Env {
  MUSEBOOK_DB: D1Database;
  MUSEBOOK_PASSCODE_HASH: string;
}

const ALLOWED_ORIGINS = ["https://gurmehar.ca", "https://www.gurmehar.ca"];
const SESSION_DAYS = 30;
const MAX_AUTHOR = 40;
const MAX_BODY = 5000;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS = 20;

// best-effort per-isolate throttle for the unlock endpoint
const attempts = new Map<string, { count: number; reset: number }>();

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

function throttled(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.reset) {
    attempts.set(ip, { count: 1, reset: now + UNLOCK_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > UNLOCK_MAX_ATTEMPTS;
}

async function requireSession(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) return false;
  const tokenHash = await sha256hex(match[1]);
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

    if (url.pathname === "/api/unlock" && req.method === "POST") {
      if (throttled(clientIp(req))) {
        return json({ error: "too many attempts, slow down" }, 429, origin);
      }
      let body: { passcode?: string };
      try {
        body = (await req.json()) as { passcode?: string };
      } catch {
        return json({ error: "bad request" }, 400, origin);
      }
      const passcode = typeof body.passcode === "string" ? body.passcode : "";
      const ok =
        passcode.length > 0 &&
        timingSafeEqual(
          await sha256hex(passcode),
          env.MUSEBOOK_PASSCODE_HASH,
        );
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
      let q = "SELECT id, author, body, created_at FROM posts";
      const params: number[] = [];
      if (Number.isFinite(before)) {
        q += " WHERE id < ?";
        params.push(before);
      }
      q += " ORDER BY id DESC LIMIT ?";
      params.push(limit);
      const rows = await env.MUSEBOOK_DB.prepare(q)
        .bind(...params)
        .all<{ id: number; author: string; body: string; created_at: number }>();
      return json({ posts: rows.results || [] }, 200, origin);
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
