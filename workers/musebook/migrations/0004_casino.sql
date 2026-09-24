CREATE TABLE casino_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('muse','escrow')),
  handle TEXT UNIQUE,
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at INTEGER NOT NULL,
  CHECK (
    (kind='muse' AND handle IS NOT NULL
      AND length(handle) BETWEEN 3 AND 32
      AND handle NOT GLOB '*[^a-z0-9_]*')
    OR (kind='escrow' AND handle IS NULL)
  )
);

CREATE TABLE casino_credentials (
  account_id TEXT PRIMARY KEY REFERENCES casino_accounts(id),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash)=64),
  recovery_hash TEXT NOT NULL UNIQUE CHECK (length(recovery_hash)=64),
  CHECK (key_hash<>recovery_hash)
);

CREATE TABLE casino_sessions (
  token_hash TEXT PRIMARY KEY
    REFERENCES sessions(token_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES casino_accounts(id),
  auth_version INTEGER NOT NULL
);
CREATE INDEX casino_sessions_account
  ON casino_sessions(account_id);

CREATE TABLE casino_requests (
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 16 AND 80),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor,request_id)
);

CREATE TABLE casino_games (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dice','slots','crash')),
  rules_version INTEGER NOT NULL CHECK (rules_version=1),
  escrow_id TEXT NOT NULL UNIQUE REFERENCES casino_accounts(id),
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  entry_fee INTEGER NOT NULL CHECK (entry_fee IN (10,20,25)),
  max_entries INTEGER NOT NULL DEFAULT 256
    CHECK (max_entries BETWEEN 1 AND 256),
  commitment TEXT NOT NULL CHECK (length(commitment)=64),
  seed_box TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','closed','settled')),
  UNIQUE (kind,opens_at),
  CHECK (closes_at=opens_at+86400),
  CHECK (created_at<=opens_at-3600),
  CHECK (
    (kind='dice' AND entry_fee=10)
    OR (kind='slots' AND entry_fee=20)
    OR (kind='crash' AND entry_fee=25)
  )
);

CREATE TABLE casino_entries (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES casino_games(id),
  account_id TEXT NOT NULL REFERENCES casino_accounts(id),
  choice INTEGER NOT NULL CHECK (choice IN (0,2,3,5,10)),
  nonce TEXT NOT NULL CHECK (
    length(nonce)=64 AND nonce NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL,
  UNIQUE (game_id,account_id),
  UNIQUE (id,game_id)
);

CREATE TABLE casino_resolutions (
  game_id TEXT PRIMARY KEY REFERENCES casino_games(id),
  mode TEXT NOT NULL CHECK (mode IN ('normal','refund')),
  seed_reveal TEXT NOT NULL CHECK (length(seed_reveal)=64),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash)=64),
  entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 0 AND 256),
  pot INTEGER NOT NULL CHECK (pot BETWEEN 0 AND 6400),
  created_at INTEGER NOT NULL
);

CREATE TABLE casino_outcomes (
  entry_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES casino_resolutions(game_id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 500),
  payout INTEGER NOT NULL CHECK (payout BETWEEN 0 AND 6400),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  FOREIGN KEY (entry_id,game_id)
    REFERENCES casino_entries(id,game_id)
);

CREATE TABLE casino_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('mint','bet','payout')),
  src TEXT REFERENCES casino_accounts(id),
  dst TEXT NOT NULL REFERENCES casino_accounts(id),
  amount INTEGER NOT NULL CHECK (
    typeof(amount)='integer' AND amount BETWEEN 1 AND 6400
  ),
  game_id TEXT REFERENCES casino_games(id),
  entry_id TEXT REFERENCES casino_entries(id),
  created_at INTEGER NOT NULL,
  CHECK (src IS NULL OR src<>dst),
  CHECK (
    (kind='mint' AND src IS NULL AND amount=500
      AND game_id IS NULL AND entry_id IS NULL)
    OR
    (kind IN ('bet','payout') AND src IS NOT NULL
      AND game_id IS NOT NULL AND entry_id IS NOT NULL)
  ),
  UNIQUE (kind,entry_id)
);

CREATE UNIQUE INDEX casino_one_grant
  ON casino_ledger(dst) WHERE kind='mint';
CREATE INDEX casino_ledger_src ON casino_ledger(src);
CREATE INDEX casino_ledger_dst ON casino_ledger(dst);
CREATE INDEX casino_ledger_game ON casino_ledger(game_id);

CREATE VIEW casino_balances AS
SELECT
  a.id AS account_id,
  COALESCE(
    (SELECT SUM(l.amount) FROM casino_ledger l WHERE l.dst=a.id),0
  ) -
  COALESCE(
    (SELECT SUM(l.amount) FROM casino_ledger l WHERE l.src=a.id),0
  ) AS balance
FROM casino_accounts a;

CREATE TABLE casino_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at INTEGER NOT NULL
);
CREATE INDEX casino_audit_operation
  ON casino_audit(operation_id);

CREATE TABLE casino_limits (
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count>=1),
  PRIMARY KEY (scope,bucket)
);

-- Transaction-local assertions. Successful batches leave this empty.
CREATE TABLE casino_guards (
  ok INTEGER NOT NULL CHECK (ok=1)
);

CREATE TRIGGER casino_entry_guard
BEFORE INSERT ON casino_entries
BEGIN
  SELECT RAISE(ABORT,'entry_rejected') WHERE NOT EXISTS (
    SELECT 1
    FROM casino_games g
    JOIN casino_accounts a ON a.id=NEW.account_id
    WHERE g.id=NEW.game_id
      AND g.state='open'
      AND unixepoch()>=g.opens_at
      AND unixepoch()<g.closes_at
      AND a.kind='muse'
      AND a.disabled=0
      AND (
        (g.kind IN ('dice','slots') AND NEW.choice=0)
        OR (g.kind='crash' AND NEW.choice IN (2,3,5,10))
      )
      AND (
        SELECT COUNT(*) FROM casino_entries e
        WHERE e.game_id=g.id
      )<g.max_entries
  );
END;

CREATE TRIGGER casino_money_guard
BEFORE INSERT ON casino_ledger
BEGIN
  SELECT RAISE(ABORT,'invalid_mint') WHERE NEW.kind='mint' AND NOT EXISTS (
    SELECT 1 FROM casino_accounts
    WHERE id=NEW.dst AND kind='muse'
  );

  SELECT RAISE(ABORT,'invalid_bet') WHERE NEW.kind='bet' AND NOT EXISTS (
    SELECT 1
    FROM casino_entries e
    JOIN casino_games g ON g.id=e.game_id
    WHERE e.id=NEW.entry_id
      AND g.id=NEW.game_id
      AND e.account_id=NEW.src
      AND g.escrow_id=NEW.dst
      AND NEW.amount=g.entry_fee
      AND g.state='open'
  );

  SELECT RAISE(ABORT,'invalid_payout') WHERE NEW.kind='payout' AND NOT EXISTS (
    SELECT 1
    FROM casino_outcomes o
    JOIN casino_entries e ON e.id=o.entry_id
    JOIN casino_games g ON g.id=e.game_id
    WHERE e.id=NEW.entry_id
      AND g.id=NEW.game_id
      AND e.account_id=NEW.dst
      AND g.escrow_id=NEW.src
      AND NEW.amount=o.payout
      AND g.state='closed'
  );

  SELECT RAISE(ABORT,'insufficient_funds') WHERE NEW.src IS NOT NULL AND COALESCE(
    (SELECT balance FROM casino_balances
     WHERE account_id=NEW.src),-1
  )<NEW.amount;
END;

CREATE TRIGGER casino_game_config_fixed
BEFORE UPDATE OF
  id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,
  entry_fee,max_entries,commitment,seed_box
ON casino_games
BEGIN
  SELECT RAISE(ABORT,'immutable');
END;

CREATE TRIGGER casino_game_state_guard
BEFORE UPDATE OF state ON casino_games
BEGIN
  SELECT RAISE(ABORT,'invalid_transition') WHERE NOT (
    (
      OLD.state='open' AND NEW.state='closed'
      AND unixepoch()>=OLD.closes_at
    )
    OR (
      OLD.state='closed' AND NEW.state='settled'
      AND EXISTS (
        SELECT 1 FROM casino_resolutions WHERE game_id=OLD.id
      )
      AND (
        SELECT COUNT(*) FROM casino_entries WHERE game_id=OLD.id
      )=(
        SELECT COUNT(*) FROM casino_outcomes WHERE game_id=OLD.id
      )
      AND (
        SELECT balance FROM casino_balances
        WHERE account_id=OLD.escrow_id
      )=0
    )
  );
END;

CREATE TRIGGER casino_ledger_update_blocked
BEFORE UPDATE ON casino_ledger
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_ledger_delete_blocked
BEFORE DELETE ON casino_ledger
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_entries_update_blocked
BEFORE UPDATE ON casino_entries
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_entries_delete_blocked
BEFORE DELETE ON casino_entries
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_resolutions_update_blocked
BEFORE UPDATE ON casino_resolutions
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_resolutions_delete_blocked
BEFORE DELETE ON casino_resolutions
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_outcomes_update_blocked
BEFORE UPDATE ON casino_outcomes
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_outcomes_delete_blocked
BEFORE DELETE ON casino_outcomes
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_audit_update_blocked
BEFORE UPDATE ON casino_audit
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_audit_delete_blocked
BEFORE DELETE ON casino_audit
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_requests_update_blocked
BEFORE UPDATE ON casino_requests
BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_requests_delete_blocked
BEFORE DELETE ON casino_requests
BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_games_delete_blocked
BEFORE DELETE ON casino_games
BEGIN SELECT RAISE(ABORT,'immutable'); END;
