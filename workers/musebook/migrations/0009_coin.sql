-- Coin Flip: apply after 0008, in one migration transaction with FKs ON.
-- Self-contained child backups; restores all guards before accepting traffic.
-- Choice codes 2=HEADS, 3=TAILS preserve the existing entry CHECK.
-- 0. Internal backup of all child rows.
CREATE TEMP TABLE _bup_entries AS SELECT * FROM casino_entries;
CREATE TEMP TABLE _bup_resolutions AS SELECT * FROM casino_resolutions;
CREATE TEMP TABLE _bup_outcomes AS SELECT * FROM casino_outcomes;
CREATE TEMP TABLE _bup_ledger AS SELECT * FROM casino_ledger WHERE game_id IS NOT NULL;

DROP TRIGGER IF EXISTS casino_resolutions_delete_blocked;
DROP TRIGGER IF EXISTS casino_outcomes_delete_blocked;
DROP TRIGGER IF EXISTS casino_second_seat;
DROP TRIGGER IF EXISTS casino_bankroll_floor;
DROP TRIGGER IF EXISTS casino_game_timing_guard;
DROP TRIGGER IF EXISTS casino_game_overlap_guard;
DROP TRIGGER IF EXISTS casino_acceleration_guard;

-- 1. Drop delete blockers so child rows can be moved.
DROP TRIGGER IF EXISTS casino_entries_delete_blocked;
DROP TRIGGER IF EXISTS casino_ledger_delete_blocked;
DROP TRIGGER IF EXISTS casino_games_delete_blocked;

-- 2. Clear child rows (restored from _bup_* in step 5).
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
  kind TEXT NOT NULL CHECK (kind IN ('dice','slots','crash','coin')),
  rules_version INTEGER NOT NULL CHECK (rules_version IN (1,2)),
  escrow_id TEXT NOT NULL UNIQUE REFERENCES casino_accounts(id),
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  entry_fee INTEGER NOT NULL CHECK (entry_fee IN (10,15,20,25)),
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
    (kind='coin' AND entry_fee=15)
    OR (kind='dice' AND entry_fee=10)
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

-- NOTE: casino_entry_guard and casino_money_guard are recreated in step 6,
-- AFTER the child-row restore, so the restore itself is not rejected.

-- 5. Restore child rows from internal backup FIRST (before INSERT guards
-- are recreated, so the restore itself is not rejected by entry_guard).
-- Restore parents first: the rebuilt casino_games contains every original ID.
INSERT INTO casino_entries SELECT * FROM _bup_entries;
INSERT INTO casino_resolutions SELECT * FROM _bup_resolutions;
INSERT INTO casino_outcomes SELECT * FROM _bup_outcomes;
INSERT INTO casino_ledger SELECT * FROM _bup_ledger;

-- 6. Now recreate the INSERT guards and delete blockers.

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

CREATE TRIGGER casino_entries_delete_blocked
BEFORE DELETE ON casino_entries BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER casino_ledger_delete_blocked
BEFORE DELETE ON casino_ledger BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- Abort the migration transaction if a backup count differs on restore.
CREATE TEMP TABLE _coin_backup_check (ok INTEGER NOT NULL CHECK (ok=1));
INSERT INTO _coin_backup_check SELECT CASE WHEN
  (SELECT COUNT(*) FROM casino_entries)=(SELECT COUNT(*) FROM _bup_entries)
  AND (SELECT COUNT(*) FROM casino_resolutions)=(SELECT COUNT(*) FROM _bup_resolutions)
  AND (SELECT COUNT(*) FROM casino_outcomes)=(SELECT COUNT(*) FROM _bup_outcomes)
  AND (SELECT COUNT(*) FROM casino_ledger WHERE game_id IS NOT NULL)=(SELECT COUNT(*) FROM _bup_ledger)
THEN 1 ELSE 0 END;
DROP TABLE _coin_backup_check;
DROP TABLE _bup_entries;
DROP TABLE _bup_resolutions;
DROP TABLE _bup_outcomes;
DROP TABLE _bup_ledger;

CREATE TRIGGER casino_resolutions_delete_blocked BEFORE DELETE ON casino_resolutions BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_outcomes_delete_blocked BEFORE DELETE ON casino_outcomes BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- Restore the complete 0008 timing, overlap, bankroll and acceleration guards.
DROP TRIGGER IF EXISTS casino_game_config_fixed;
CREATE TRIGGER casino_game_config_fixed
BEFORE UPDATE OF id,kind,rules_version,escrow_id,created_at,entry_fee,max_entries,commitment,seed_box
ON casino_games BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER casino_game_timing_guard
BEFORE UPDATE OF opens_at,closes_at ON casino_games
BEGIN
  SELECT RAISE(ABORT,'immutable_timing') WHERE NOT (
    OLD.rules_version=2 AND OLD.state='open' AND NEW.state='open'
    AND OLD.opens_at>unixepoch() AND NEW.opens_at=unixepoch()
    AND NEW.closes_at=NEW.opens_at+86400
    AND NOT EXISTS(SELECT 1 FROM casino_entries WHERE game_id=OLD.id)
  );
  SELECT RAISE(ABORT,'overlapping_table') WHERE EXISTS (
    SELECT 1 FROM casino_games g WHERE g.kind=NEW.kind AND g.id<>NEW.id
    AND g.state='open' AND g.id NOT LIKE '%test%'
    AND g.opens_at<NEW.closes_at
    AND MIN(g.closes_at,COALESCE(g.accelerated_close_at,g.closes_at))>NEW.opens_at
  );
END;
CREATE TRIGGER casino_game_overlap_guard
BEFORE INSERT ON casino_games WHEN NEW.id NOT LIKE '%test%'
BEGIN
  SELECT RAISE(ABORT,'overlapping_table') WHERE EXISTS (
    SELECT 1 FROM casino_games g WHERE g.kind=NEW.kind AND g.state='open'
    AND g.id NOT LIKE '%test%' AND g.opens_at<NEW.closes_at
    AND MIN(g.closes_at,COALESCE(g.accelerated_close_at,g.closes_at))>NEW.opens_at
  );
END;

DROP TRIGGER IF EXISTS casino_entry_guard;
CREATE TRIGGER casino_entry_guard BEFORE INSERT ON casino_entries
BEGIN
  SELECT RAISE(ABORT,'entry_rejected') WHERE NOT EXISTS (
    SELECT 1 FROM casino_games g JOIN casino_accounts a ON a.id=NEW.account_id
    WHERE g.id=NEW.game_id AND g.state='open'
    AND unixepoch()>=g.opens_at
    AND unixepoch()<MIN(g.closes_at,COALESCE(g.accelerated_close_at,g.closes_at))
    AND a.kind='muse' AND a.disabled=0
    AND ((g.kind IN ('dice','slots') AND NEW.choice=0)
      OR (g.kind='crash' AND NEW.choice IN (2,3,5,10))
      OR (g.kind='coin' AND NEW.choice IN (2,3)))
    AND (SELECT COUNT(*) FROM casino_entries WHERE game_id=g.id)<g.max_entries
  );
END;
CREATE TRIGGER casino_bankroll_floor BEFORE INSERT ON casino_ledger
WHEN NEW.kind='bet'
BEGIN
  SELECT RAISE(ABORT,'bankroll_floor') WHERE
    COALESCE((SELECT balance FROM casino_balances WHERE account_id=NEW.src),0)-NEW.amount<100;
END;
CREATE TRIGGER casino_acceleration_guard BEFORE UPDATE OF accelerated_close_at ON casino_games
BEGIN
  SELECT RAISE(ABORT,'invalid_acceleration') WHERE NOT (
    OLD.state='open' AND NEW.accelerated_close_at IS NOT NULL
    AND NEW.accelerated_close_at<=OLD.closes_at
    AND NEW.accelerated_close_at<=COALESCE(OLD.accelerated_close_at,OLD.closes_at)
    AND NEW.accelerated_close_at=MIN(OLD.closes_at,unixepoch()+120)
    AND (SELECT COUNT(*) FROM casino_entries WHERE game_id=OLD.id)=2
  );
END;
CREATE TRIGGER casino_second_seat AFTER INSERT ON casino_entries
WHEN (SELECT COUNT(*) FROM casino_entries WHERE game_id=NEW.game_id)=2
BEGIN
  UPDATE casino_games SET accelerated_close_at=MIN(closes_at,unixepoch()+120)
    WHERE id=NEW.game_id;
  INSERT INTO casino_audit(operation_id,actor,event,entity_id,detail_json,created_at)
    SELECT 'accelerate:'||NEW.game_id,'system','round_accelerated',id,
      json_object('accelerated_close_at',accelerated_close_at,'reason','second_seat'),unixepoch()
    FROM casino_games WHERE id=NEW.game_id;
END;
CREATE INDEX casino_games_lifecycle ON casino_games(state,kind,opens_at);
