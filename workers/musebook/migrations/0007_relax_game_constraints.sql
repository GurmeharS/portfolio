-- 0007_relax_game_constraints.sql — allow rolling v2 rounds.
--
-- The original casino_games CHECK constraints (rules_version=1,
-- closes_at=opens_at+86400, created_at<=opens_at-3600) block short-lived
-- bridge rounds and immediately-opening rolling rounds. SQLite/D1 cannot
-- ALTER a CHECK constraint, so the table is rebuilt with relaxed checks:
--   rules_version IN (1,2)
--   closes_at > opens_at AND closes_at <= opens_at+86400
--   created_at <= opens_at
-- v1 rounds still satisfy all three (24h, provisioned >=1h early).
--
-- Data-preserving rebuild. D1 enforces FKs immediately, and delete-blocker
-- triggers guard the child tables, so:
--   1. drop the delete-blocker triggers,
--   2. clear child rows (backed up by the operator beforehand on live DBs),
--   3. rebuild the parent via _new + rename (DROP TABLE does not fire the
--      BEFORE DELETE trigger; RENAME requires dropping triggers that
--      reference the table name first),
--   4. restore child rows, recreate all triggers.
-- On a fresh DB the child tables are empty and steps 2/4 are no-ops.

-- 1. Drop delete blockers so child rows can be moved.
DROP TRIGGER IF EXISTS casino_entries_delete_blocked;
DROP TRIGGER IF EXISTS casino_ledger_delete_blocked;
DROP TRIGGER IF EXISTS casino_games_delete_blocked;

-- 2. Clear child rows (operator backs these up first on a live DB).
DELETE FROM casino_outcomes;
DELETE FROM casino_ledger WHERE game_id IS NOT NULL;
DELETE FROM casino_resolutions;
DELETE FROM casino_entries;

-- Triggers referencing casino_games by name must go before the rename.
DROP TRIGGER IF EXISTS casino_entry_guard;
DROP TRIGGER IF EXISTS casino_money_guard;
DROP TRIGGER IF EXISTS casino_game_config_fixed;
DROP TRIGGER IF EXISTS casino_game_state_guard;

-- 3. Rebuild with relaxed constraints.
CREATE TABLE casino_games_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dice','slots','crash')),
  rules_version INTEGER NOT NULL CHECK (rules_version IN (1,2)),
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
  accelerated_close_at INTEGER,
  UNIQUE (kind,opens_at),
  CHECK (closes_at > opens_at AND closes_at <= opens_at+86400),
  CHECK (created_at <= opens_at),
  CHECK (
    (kind='dice' AND entry_fee=10)
    OR (kind='slots' AND entry_fee=20)
    OR (kind='crash' AND entry_fee=25)
  )
);
INSERT INTO casino_games_new
  (id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,
   max_entries,commitment,seed_box,state,accelerated_close_at)
  SELECT id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,
         max_entries,commitment,seed_box,state,accelerated_close_at
  FROM casino_games;
DROP TABLE casino_games;
ALTER TABLE casino_games_new RENAME TO casino_games;

-- 4. Recreate game triggers (state guard allows accelerated close).
CREATE TRIGGER casino_game_config_fixed
BEFORE UPDATE OF id,kind,rules_version,escrow_id,opens_at,closes_at,created_at,entry_fee,max_entries,commitment,seed_box
ON casino_games BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_game_state_guard
BEFORE UPDATE OF state ON casino_games
BEGIN
  SELECT RAISE(ABORT,'invalid_transition') WHERE NOT (
    (OLD.state='open' AND NEW.state='closed'
      AND (unixepoch()>=OLD.closes_at OR unixepoch()>=OLD.accelerated_close_at))
    OR
    (OLD.state='closed' AND NEW.state='settled'
      AND EXISTS (SELECT 1 FROM casino_resolutions WHERE game_id=OLD.id)
      AND (SELECT COUNT(*) FROM casino_entries WHERE game_id=OLD.id)
        = (SELECT COUNT(*) FROM casino_outcomes WHERE game_id=OLD.id)
      AND (SELECT balance FROM casino_balances WHERE account_id=OLD.escrow_id)=0)
  );
END;
CREATE TRIGGER casino_games_delete_blocked
BEFORE DELETE ON casino_games BEGIN SELECT RAISE(ABORT,'immutable'); END;
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

-- 5. Operator restores backed-up child rows here on a live DB, then:
CREATE TRIGGER casino_entries_delete_blocked
BEFORE DELETE ON casino_entries BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_ledger_delete_blocked
BEFORE DELETE ON casino_ledger BEGIN SELECT RAISE(ABORT,'immutable'); END;
