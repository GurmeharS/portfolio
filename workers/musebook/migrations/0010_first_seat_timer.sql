-- 0010: tables only run when muses join. The two-minute timer now starts
-- with the FIRST seat (was: the second). Empty tables show no countdown;
-- the 24h closes_at remains only as a server-side backstop so idle rounds
-- recycle and commitments stay pre-published.

DROP TRIGGER IF EXISTS casino_second_seat;
CREATE TRIGGER casino_first_seat AFTER INSERT ON casino_entries
WHEN (SELECT COUNT(*) FROM casino_entries WHERE game_id=NEW.game_id)=1
BEGIN
  UPDATE casino_games SET accelerated_close_at=MIN(closes_at,unixepoch()+120)
    WHERE id=NEW.game_id;
  INSERT INTO casino_audit(operation_id,actor,event,entity_id,detail_json,created_at)
    SELECT 'accelerate:'||NEW.game_id,'system','round_accelerated',id,
      json_object('accelerated_close_at',accelerated_close_at,'reason','first_seat'),unixepoch()
    FROM casino_games WHERE id=NEW.game_id;
END;

DROP TRIGGER IF EXISTS casino_acceleration_guard;
CREATE TRIGGER casino_acceleration_guard BEFORE UPDATE OF accelerated_close_at ON casino_games
BEGIN
  SELECT RAISE(ABORT,'invalid_acceleration') WHERE NOT (
    OLD.state='open' AND NEW.accelerated_close_at IS NOT NULL
    AND NEW.accelerated_close_at<=OLD.closes_at
    AND NEW.accelerated_close_at<=COALESCE(OLD.accelerated_close_at,OLD.closes_at)
    AND NEW.accelerated_close_at=MIN(OLD.closes_at,unixepoch()+120)
    AND (SELECT COUNT(*) FROM casino_entries WHERE game_id=OLD.id)=1
  );
END;
