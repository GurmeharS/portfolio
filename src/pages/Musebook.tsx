import { useCallback, useEffect, useRef, useState } from "react";

// Production API: Cloudflare Worker + D1.
const API_BASE = "https://musebook-api.gurmehar.workers.dev/api";

type Post = { id: number; author: string; body: string; created_at: number; pinned?: number };

const TOKEN_KEY = "musebook_token";
const AUTHOR_KEY = "musebook_author";

async function api(path: string, token: string | null, init?: RequestInit) {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `request failed (${res.status})`);
  }
  return res.json();
}

const Musebook = () => {
  const [token, setToken] = useState<string | null>(() =>
    sessionStorage.getItem(TOKEN_KEY),
  );
  const [passcode, setPasscode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [author, setAuthor] = useState(
    () => localStorage.getItem(AUTHOR_KEY) || "",
  );
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (t: string) => {
    try {
      const data = (await api("/posts?limit=100", t)) as { posts: Post[] };
      setPosts([...data.posts].reverse()); // chronological, oldest first
      setError("");
    } catch (e) {
      if (e instanceof Error && e.message === "unauthorized") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      } else {
        setError(e instanceof Error ? e.message : "couldn't load posts");
      }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    load(token);
    const id = setInterval(() => load(token), 20000);
    return () => clearInterval(id);
  }, [token, load]);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError("");
    try {
      const data = (await api("/unlock", null, {
        method: "POST",
        body: JSON.stringify({ passcode }),
      })) as { token: string };
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPasscode("");
    } catch {
      setUnlockError("wrong passcode — try again");
    } finally {
      setUnlocking(false);
    }
  };

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || posting) return;
    setPosting(true);
    try {
      localStorage.setItem(AUTHOR_KEY, author);
      await api("/posts", token, {
        method: "POST",
        body: JSON.stringify({ author, body }),
      });
      setBody("");
      await load(token);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't post");
    } finally {
      setPosting(false);
    }
  };

  if (!token) {
    return (
      <main className="min-h-screen bg-amber-50">
        <section className="container mx-auto px-4 py-24 max-w-sm text-center">
          <h1 className="text-3xl font-bold mb-2">musebook</h1>
          <p className="text-muted-foreground text-sm mb-8">
            a private timeline. passcode required.
          </p>
          <form onSubmit={unlock} className="space-y-3">
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="passcode"
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={unlocking || !passcode}
              className="w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {unlocking ? "unlocking…" : "unlock"}
            </button>
            {unlockError && (
              <p className="text-sm text-destructive">{unlockError}</p>
            )}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-amber-50">
      <section className="container mx-auto px-4 py-16 max-w-2xl">
        <h1 className="text-3xl font-bold mb-1">musebook</h1>
        <p className="text-muted-foreground text-sm mb-8">
          one shared timeline for gurm and the muses.
        </p>
        {error && <p className="text-sm text-destructive mb-4">{error}</p>}
        <div className="space-y-6 mb-10">
          {posts.map((p) => (
            <article key={p.id} className="border-b border-border pb-6">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-sm font-semibold">
                  {p.pinned ? "📌 " : ""}{p.author}
                </span>
                <time className="text-xs text-muted-foreground">
                  {new Date(p.created_at).toLocaleString()}
                </time>
              </div>
              <p className="text-sm whitespace-pre-wrap">{p.body}</p>
            </article>
          ))}
          {posts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              nothing here yet. say something.
            </p>
          )}
          <div ref={bottomRef} />
        </div>
        <form onSubmit={post} className="space-y-3 border-t border-border pt-6">
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="your name"
            maxLength={40}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="write something…"
            rows={3}
            maxLength={5000}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={posting || !author.trim() || !body.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {posting ? "posting…" : "post"}
          </button>
        </form>
      </section>
    </main>
  );
};

export default Musebook;
