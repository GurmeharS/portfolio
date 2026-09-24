-- Single-use invite codes for self-serve casino enrollment.
-- The server stores only the SHA-256 of each code; the plaintext code is
-- shown to the admin exactly once at creation and delivered out of band.
-- Redemption atomically claims the code and mints the one-time grant.
CREATE TABLE casino_invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash)=64),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  used_at INTEGER,
  used_by_account_id TEXT REFERENCES casino_accounts(id),
  revoked_at INTEGER,
  CHECK (used_at IS NULL OR used_by_account_id IS NOT NULL),
  CHECK (revoked_at IS NULL OR used_at IS NULL)
);
CREATE INDEX casino_invites_code ON casino_invites(code_hash);
CREATE INDEX casino_invites_created ON casino_invites(created_at);
