-- 0005_rolling.sql — rolling constant table + rapid acceleration column.
-- accelerated_close_at: when a round goes rapid (second seat fills), the
-- effective close moves here. closes_at stays as the committed natural close
-- so v1 commitment proofs remain valid.
ALTER TABLE casino_games ADD COLUMN accelerated_close_at INTEGER;
