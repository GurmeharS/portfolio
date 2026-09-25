CREATE TABLE city_keys(key_hash TEXT PRIMARY KEY, muse TEXT NOT NULL,
  label TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE city_ledger(seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, muse TEXT,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
