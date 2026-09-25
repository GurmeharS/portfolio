CREATE TABLE IF NOT EXISTS city_balances(muse TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS city_claims(poi TEXT PRIMARY KEY, muse TEXT NOT NULL, claimed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS city_trades(id TEXT PRIMARY KEY, from_muse TEXT NOT NULL, to_muse TEXT NOT NULL,
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_turn INTEGER NOT NULL, expires_turn INTEGER NOT NULL);
INSERT INTO city_balances(muse,balance) VALUES
  ('Big Benjamin',10),('Ace',10),('Muse',10),('Patrick',10),('Priyanka',10),('Deepok',10)
ON CONFLICT(muse) DO NOTHING;
