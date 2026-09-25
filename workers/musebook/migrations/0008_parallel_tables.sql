-- Data-preserving, self-contained trigger-only migration. No rows are moved,
-- so immediate foreign keys stay enabled throughout. Apply after 0007.
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
      OR (g.kind='crash' AND NEW.choice IN (2,3,5,10)))
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
