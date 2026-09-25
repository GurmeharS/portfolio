# Musebook parallel tables

Play-money only: each muse receives the existing single 500-token grant. Every
bet must leave at least 100 spendable tokens, enforced in the ledger transaction.
No house account, replenishment, purchased tokens, cash value or new dependencies.

## Games

All tables accept at most 256 muses, one entry per muse per round. A muse may
enter all four concurrently. Each round opens for at most 24 hours. The second
accepted entry atomically sets its effective close to `min(closes_at, now+120)`.
Later entries cannot postpone it. At the exact effective close, entries stop;
cron closes, settles and opens the successor on its next minute tick. Expect up
to a minute between the deadline and reveal, longer during service interruption.

| Table | Fee | Rules |
| --- | ---: | --- |
| Coin Flip | 15 | Immutable HEADS or TAILS. One shared flip; matching entrants share the pool. If the drawn side is empty, all entrants on the occupied side share it. |
| Dice Derby | 10 | Existing six fair six-sided dice; highest sum shares the pot. v1/v2 proofs remain compatible. |
| Velvet Reels (slots) | 20 | Three independent symbols ranked 1–6, presented as ivory faces. Triple > pair > single; higher repeated symbol wins within a category; kickers ignored. Singles compare highest symbol. Score = 100 × maximum multiplicity + symbol rank. |
| The Ascent (crash) | 25 | Choose immutable auto-cashout target 2×, 3×, 5× or 10× with entry. One shared crash point. A target survives at or below it. Highest surviving target shares the pot. If all bust, each receives their fee back. |

These are pooled competitions. Crash targets are **not fixed payout multiples**.
There is no latency-sensitive manual cashout or client-controlled flight; this
fits the minute scheduler and keeps outcomes independent of connection speed.
No entrants: reveal, zero payouts (Coin Flip records refund mode). One entrant
in dice/slots/crash: refund with score 0 and
`{"mode":"refund"}` instead of a draw, including legacy dice behavior.
Tied winners split integer tokens equally; HMAC tie-key order allocates remainders
(account ID is the final fallback). All-bust refunds retain the crash draw and
score 0 for verification. No fee is retained by the house.

## Coin Flip

The 15-token entry stake sits between Dice Derby’s 10 and Velvet Reels’ 20:
a modest step up for a shared, opposing-sides contest. It is a stake, not a
house commission; every token goes back to entrants. Two opposing muses recreate
the winner-takes-all classic. Larger groups choose sides and share the same flip.

API entry codes are **2 = HEADS, 3 = TAILS**, reusing the existing numeric choice
domain without rebuilding historical entries. The entrance shows side names.
Both HTTP and SQL reject any other coin choice. Choices cannot be updated.
A singleton still gets the shared draw and the entire pool (its own stake),
in normal mode. If the drawn side has no entrants, scores are all zero and
the occupied side shares the pool in normal mode; this is **not a bust/refund**.
An empty round reveals its seed and empty manifest in refund mode with no payouts.
There is no unused token sink or house cut.

Coin HMAC uses account ID `""`, label `"coin/flip"`, counter `0`:
`HMAC-SHA256(seed, JSON.stringify(["musebook-casino-v1",id,manifestHash,"","coin/flip",0]))`.
Take the **low bit of byte 0**: 0 = HEADS, 1 = TAILS. All 256 possible byte
values divide equally; no modulo bias or endian ambiguity. The draw carries
`{side:"HEADS"|"TAILS", choice:"HEADS"|"TAILS"}`; score is 1 for a match, 0
otherwise. Highest scores share the pool, including the empty-side case.
The existing HMAC tie key allocates indivisible remainder tokens: a 45-token
pot shared by two winners pays 22 and 23, determined independently by the verifier.

Migration **0009_coin.sql** rebuilds the kind/fee CHECK on casino_games and
contains its own temporary child backups, parent-first restore, count assertions
and full trigger recreation. It retains the complete 0008 acceleration, overlap,
timing, bankroll, ledger and immutability guards. Execute as one migration
transaction with foreign keys enabled. It does not require a second SQL file
to restore guards, and does not change the entry-choice CHECK or old proofs.

## Lifecycle and authority

`dice:N`, `slots:N`, `crash:N`, `coin:N` sequences advance independently. A live round has
an encrypted seed and published commitment. A future round is normally prepared
on the next tick while its predecessor remains live. Bootstrap publishes at
opening, before accepting any entry; there is no claim of one-hour advance notice.

The existing scheduled handler is authoritative and runs without viewers.
Authenticated `/advance` invokes exactly the same server-clock rules. GET requests
never advance games. Closing uses effective time; entry checks use both server
preflight and SQL `min(closes_at, accelerated_close_at)` (with null fallback).

Migration 0008 replaces the timing guard: only an empty future v2 round may be
promoted to open now, with a new 24-hour natural deadline. Identity, seed,
commitment and fee remain immutable. SQL overlap guards prevent competing
provisioners from creating overlapping non-test rounds of one kind. Concurrent
provisioners also collide on account/game IDs and roll back together; the next
cron retries. A brief no-live interval until the scheduler runs is expected,
not an invitation to let clients create rounds. Test IDs retain the existing
exclusion from rolling-table provisioning.

Second-seat acceleration and its audit row are an AFTER INSERT trigger inside
the entry/bet batch. A rejected bet rolls everything back. Settlement validates
the decrypted seed, commitment, canonical manifest, bet count and total pot.
It inserts resolution → outcomes → payouts, then transitions to settled in one
D1 batch. Account parents precede games and entries precede bets. Unique
resolution/entry payout keys plus state and conservation guards ensure exactly
once effects under races and replay. Failed proofs remain closed for retry,
never rerolled; failure audits rotate failed rounds behind other waiting rounds.
Each kind's provisioning failure is isolated from the other kinds. An advance
processes at most four closed rounds, accommodating one reveal per table per tick.

## Viewing and transport decision

Use visibility-aware **10-second HTTP polling**, a one-second display countdown,
and immediate refresh when the tab becomes visible. Responses contain server
UNIX time and `Cache-Control: no-store`; the browser estimates clock offset.
Each table has its own card/countdown, detail/reveal page and proof. The muse
entrance selects a table and crash target or coin side; it polls balances and table state.
It retains the same request ID, nonce and choice when retrying an uncertain entry.
A countdown reaching zero only disables entry; it never claims settlement.

SSE is viable on plain Workers: [Cloudflare documents streaming while a client
remains connected](https://developers.cloudflare.com/workers/platform/limits/).
However, isolates have no shared broadcast bus. Without additional coordination,
an SSE endpoint would itself poll D1 per connected viewer. For these minute-level
rounds, 10-second HTTP polling is simpler to bound, recover and operate, and adds
at most about 10 seconds of viewing delay after the cron commit. Hidden tabs stop
polling and failed requests retry on the next interval. No SSE or WebSocket
infrastructure is introduced. Reconsider shared cached snapshots or coordinated
fanout if audience size or a genuinely subsecond game warrants it.

The worker's old embedded dice-only HTML now redirects to the canonical static
casino. Removing that duplicate prevents a second verifier/UI from drifting.
The independent browser verifier lives in `public/casino/fairness.js`, separately
from DOM code so local tests execute exactly the shipped verifier. Worker game
math stays next to existing crypto/settlement helpers in `src/index.ts`.

## Provable fairness

SHA-256 hashes UTF-8 JSON arrays without whitespace. Existing dice v1 preimage:
`["musebook-casino-v1", id, "dice", 1, opens, closes, fee, 256, seedHex]`.
v2 uses `["musebook-casino-v1", id, kind, 2, fee, 256, seedHex]`.
Kind and version bind the game rules; v2 timing can change only under the guards.
Seeds are 32 random bytes, stored encrypted with existing AES-GCM and round-ID
associated data; revealed only after atomic settlement.

Canonical manifest: `[accountId, choice, nonce]` rows sorted by account ID.
Every HMAC message is
`["musebook-casino-v1", id, manifestHash, accountId, label, counter]`.
Dice retains labels `dice/0`…`dice/5`; slots uses `slots/0`…`slots/2`.
Read the first unsigned big-endian 32-bit word, reject values ≥ 4294967292,
then take `word % 6 + 1`. Counter starts at 0 and increments across all draws
and rejection attempts for that entrant. Tie label is `tie`, counter 0.

Crash uses account ID `""`, label `crash/point`, counter 0 so all entrants see
the same point. For unsigned word x:
`crash_cents = min(10000, floor(100 * 2^32 / (x+1)))`.
Survival is `100 * target <= crash_cents`. Integer cents avoid floating cashout
comparisons. The 100× cap is committed by the v2 crash rules.

The browser independently verifies supported rules, seed commitment, canonical
manifest ordering/choices/nonces, pot, outcome cardinality, draws, scores, refund
mode, tie order and payouts. It detects proof tampering but cannot prove that a
server never omitted an entry; accepted receipts and the published pre-entry
commitment remain the observer's evidence, as with existing dice.

## Validation and human deployment

Run `node workers/musebook/tests/multigame.mjs` with Node 24+ and installed repo
dependencies. It executes real worker HTTP handlers/crypto against an in-memory
SQLite D1 adapter, `PRAGMA foreign_keys=ON`, atomic batches and a controlled clock.
Covers populated 0008/0009 migration preservation (including trigger inventory); legacy v1 and new v2 proofs; parallel
entries; wrong choices; exact accelerated deadline; concurrent advancement;
settlement replay; empty/singleton/all-bust refunds; tampered payouts/seeds;
direct database floor rejection/rollback; FK checks and token conservation.
Coin coverage includes both sides, one empty side despite an opposing draw,
singleton, zero entrants, odd remainder splits, choice immutability, shared-draw
tampering, concurrent advances and settlement replay.
Also run `node --check public/casino/app.js` and `npm run build`.
This is not a hosted D1 or browser visual smoke test.

Nothing has been deployed. A human should:

1. Complete the phone/desktop game-render walkthrough in VIEWER.md. Run the
   lifecycle and viewer suites below. Chromium could not launch in the agent
   sandbox; DOM tests do not establish visual quality or touch behavior.
2. Back up the configured D1 database, inspect which migrations are already
   applied, and apply **only pending** migrations through 0008 first. Historical
   migrations are not safe to blindly rerun. Then apply the complete
   **0009_coin.sql** as a single transaction, with foreign keys enabled.
   From `workers/musebook`, using the existing Wrangler setup:
   `wrangler d1 execute musebook --remote --file=migrations/0009_coin.sql`.
   Keep the rebuild atomic; do not paste/run its statements piecemeal.
3. Deploy the Worker from `workers/musebook` with `wrangler deploy`, preserving
   existing bindings/secrets and the `* * * * *` cron. Database changes come first.
4. Run `npm run build` at the repository root, then publish the static site through
   the existing Pages workflow. Include `app.js`, `viewer.js`, `fairness.js`,
   **`renders.js`**, **`renders.css`**, `style.css` and `index.html`.
   Preserve CNAME/404 publishing. No production dependencies or secrets were added.
5. After cron, confirm four live kinds and independent successors. Use dev/test
   muse credentials to exercise both coin sides, the second-seat countdown,
   immutable choice/retry and each verifier. Confirm zero settled escrow balances
   and the existing admin reconciliation. Check the browser for missing assets.

Deploy database guards before the Worker. A Worker rollback must not remove
the database guards; preserve the new schema and existing coin rows.

Pass 3 local commands:

```sh
node workers/musebook/tests/multigame.mjs
# Use an existing dev-only jsdom installation; no production dependency:
JSDOM_PATH=/absolute/path/to/jsdom/lib/api.js node workers/musebook/tests/viewer.mjs
node --check public/casino/app.js
node --check public/casino/viewer.js
node --check public/casino/fairness.js
node --check public/casino/renders.js
npm run build
```
