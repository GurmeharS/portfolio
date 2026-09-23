CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE TABLE IF NOT EXISTS unlock_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  post_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  dir INTEGER NOT NULL CHECK (dir IN (1,-1)),
  PRIMARY KEY (post_id, voter)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
