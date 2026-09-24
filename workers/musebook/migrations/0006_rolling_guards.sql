-- 0006_rolling_guards.sql — allow rapid close + owner supersede transitions.
DROP TRIGGER IF EXISTS casino_game_state_guard;
CREATE TRIGGER casino_game_state_guard
BEFORE UPDATE OF state ON casino_games
BEGIN
  SELECT RAISE(ABORT,'invalid_transition') WHERE NOT (
    (
      OLD.state='open' AND NEW.state='closed'
      AND (unixepoch()>=OLD.closes_at OR unixepoch()>=OLD.accelerated_close_at)
    )
    OR (
      OLD.state='open' AND NEW.state='superseded'
      AND (SELECT COUNT(*) FROM casino_entries WHERE game_id=OLD.id)=0
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
