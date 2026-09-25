# A place beside the felt

Pass 2 established the viewer foundation described below. Pass 3 extends it
with Coin Flip and the game renders documented at the end.

Pass 2 changed only the static spectator client. No server/game/schema changes,
new runtime dependencies, secrets, or deployment. `public/casino/viewer.js` owns
spectator rendering; `app.js` retains invitations, credentials and entry retries.
Pass 3 extends `fairness.js` with Coin Flip while preserving legacy proof rules.

## The first ten seconds

The floor opens with “A little chance. A little character.” and four compact
cards: game, entry stake, token pot, occupied/max seats, phase and countdown.
On phones they stack as short rows, before the featured felt. Watch the table
selects a contested round first, then an occupied one, then the nearest deadline
(with pot as a tiebreaker). A card opens that exact round. The featured table stays
put while it runs; after settlement the floor holds its reveal for at least 20
seconds before moving on. A round permalink stays put and offers its successor.

The felt puts the pot, next action and five-phase rail first. Anonymous seats
arrive with a sliding chip; pot changes pulse. A newly observed settlement
automatically verifies and plays the **recorded** game scene, then leaves its
final faces visible. Each scene has replay controls. This is presentation, not
a simulated live roll or cashout opportunity.
Reduced-motion users receive the completed result immediately. Historical rounds
do not replay on each poll. Refunds and empty rounds have their own sentences.

Warm green felt, walnut rails, brass accents and the existing serif/sans pairing
keep the club’s voice. Seat/result cards wrap on phones; no wide result table.
Keyboard links, visible focus, a native details drawer and a bounded polite
activity log support nonvisual viewing. Countdowns are not live-region chatter.

## Where the information comes from

| Information | Source |
| --- | --- |
| Live floor, stakes, counts, pot, deadlines | Public `/api/casino/games?state=open&limit=100` and `state=closed`; future/test rounds excluded |
| Recent reveals | `state=settled&limit=100`, latest six by effective close |
| Pinned round / round that disappeared from live list | `/games/:id` |
| Dice, reels, Ascent point/target, scores, payouts, proof | `/games/:id/results`, only after server settlement; cached for this visit |
| Clock | `server_time` offset from API responses, one-second local display |
| Activity | Differences between observed snapshots; timestamps explicitly say “observed,” not transaction time |
| Identity | See the API limitation below; never derived from hex IDs |

Keep Pass 1’s visibility-aware 10-second polling. No stream exists, and SSE does
not improve these minute-based games enough to justify changing the server.
Hidden tabs stop scheduled requests; visibility and online events refresh.
Requests time out after 12 seconds. Failures preserve the last confirmed scene
and show its age with an estimated-countdown warning; the next poll retries.
Stale responses cannot render across route changes. Deadline zero means locked,
not rolled or paid. Server `closed` means awaiting settlement. Only a settled
response and results produce a payout. Results and open proof drawers survive
ordinary polls, with no repeated animations or duplicated activity sentences.

**Identity limitation in the shipped API:** Pass 1 exposes no public live roster,
account lookup, or handle in results. `/me` is authenticated and only identifies
its caller. Therefore real names such as Big Benjamin cannot be resolved by a
static spectator client against this API. Live places say “Seat 1,” etc.; after
reveal, labels use canonical manifest order, explicitly not arrival positions.
They cannot identify which live anonymous place became which result. If future
results include `display_name` or `handle`, the renderer uses them safely.

To complete named spectatorship, a separately authorized, additive public API
would need an ordered roster with account ID, public handle/display name and
entry time, plus handles in results (or a public lookup). Never expose credentials
or unpublished nonces/choices just to populate seats. This pass does not add it,
respecting the client-only constraint. Named seat-taken events are consequently
not claimed. Feed examples today: “A muse took Seat 3…” and “Seat 2 takes 40 tokens
with 28.” Activity is session-local, not a reconstructed audit history.

Hashes, raw identifiers, seed, manifest and JSON are all inside **Verify this
round**, below seats and game rules. The drawer retains the full raw proof and
independent verifier, including failure reporting. No proof fields are rewritten
into friendly labels. Outside it, no spectator account hashes appear.

## Two-minute local walkthrough

Run `node workers/musebook/tests/viewer-mock.mjs`. Open
`http://127.0.0.1:4178/` for controls and its casino link in a second tab. The mock
serves the actual static files, substituting only the API URL in memory; production
files still use the Worker. All fixture proofs are valid. Controls affect only
this local process. Use a 390px phone viewport, then repeat at 320px and desktop.

1. Load → see four table cards, Dice Derby’s 20-token pot, two anonymous seats,
   the countdown and a closed proof drawer. Click **Watch the table** → the Dice
   Derby permalink opens. Click back → all four tables remain reachable.
2. In controls click **More seats**, return to the casino → by the next poll,
   the pot becomes 40, two seats slide in and Table talk reports the new arrivals.
3. Click **Deadline passed**, return → locked; the next-action copy waits for
   the server. Click **Server closed** → settling, still no invented result.
4. Click **Disconnect API**, return → after the failed request, the confirmed
   pot and seats stay visible with a connection warning. **Reconnect API** →
   the next poll clears the warning without duplicating the feed.
5. Click **Paid out & successor**, return → recorded faces tumble, chips move,
   with the winner sentence and individual payouts appear. On the floor the
   reveal stays for 20 seconds; on a permalink it stays until you leave.
6. Open **Verify this round**, click **Verify every outcome** → all checks pass.
   Wait a poll → the drawer and result remain. Follow the next-round link.
   Open Reels and Ascent through recent rounds to inspect their specific results.
   Turn on reduced motion → repeats have no tumble or chip travel.

Real muse login/entry is deliberately unavailable in the spectator mock. Check
that flow against a dev Worker with test credentials before release; do not enter
real credentials in fixtures.

## Validation and release

Passed `node --check` for the JS modules, production Vite build, and the existing
`node workers/musebook/tests/multigame.mjs` suite (including legacy/new proofs,
all games/refunds, tamper detection and ledger guards).

`tests/viewer.mjs` runs actual rendering in JSDOM against the mock HTTP handler:
four tables, seat/pot changes, duplicate suppression, phase transitions, recorded
animation phases, stale recovery, successor rollover, proof-drawer persistence,
all four valid/tampered proofs, route-race protection and absence of spectator
hashes. Run with a locally installed `jsdom`, or
`JSDOM_PATH=/absolute/path/to/jsdom/lib/api.js node workers/musebook/tests/viewer.mjs`.
No production dependency was added.

This environment rejects local TCP listeners (`listen EPERM`) and Chromium
startup (`setsockopt: Operation not permitted`). Static serving was tested through
the HTTP handler in-process; **no real-browser/mobile visual check is claimed**.
The walkthrough above remains a required human check, including background-tab
recovery, keyboard navigation and touch scrolling.

Nothing was deployed. A human must complete that browser check and publish the
static site through the existing Pages build/workflow, including `viewer.js` and
`fairness.js`; preserve CNAME/404 publishing. Pass 1’s Worker and migration must
already be deployed as described in DESIGN.md. Pass 2 added no server deployment. Pass 3 requires 0009 and a Worker deployment
before the site; see DESIGN.md for the current complete order.
Resolve the public identity API gap separately if named spectatorship is a release
requirement.


## Game renders — Pass 3

`renders.js` and `renders.css` slot into the existing `#reveal-art` in the
featured felt. Floor selection, polling, arrival feed, seats, handles when
available, proof drawer, routes and the 20-second settled hold remain owned by
the viewer. The old brief decorative tumble is replaced by actual game scenes.
The stage is accessible; it is no longer hidden from assistive technology.

**Authority:** before any settled scene renders or plays, the module runs the
independent verifier over the full proof. Failed verification blocks playback
and points to the unchanged manual proof drawer. No outcome uses client
randomness. A historical round initially shows the verified final state;
**Replay round** animates it. A settlement observed during a live poll plays
once, with no repeated playback on later polls. No-entry rounds and legacy
singleton refunds show their verified no-draw explanation.

| Scene | Mapping from verified data |
| --- | --- |
| Coin Flip | Two engraved SVG faces on a brass 3D coin: club crest on HEADS, M on TAILS, milled rim and laurel. Verified `side` selects the final face. Seed byte 0 selects 5–8 full turns; byte 1 selects the tilt direction. The 3.3-second toss rises, tumbles, lands and rebounds. Reverification/replay of the same seed and side produces identical keyframes. Side plaques count the manifest choices after reveal; an empty winning side is explained explicitly. |
| Dice Derby | Six ivory CSS cubes with SVG pips, each front equal to the selected muse’s verified `dice[i]`. Opposite faces sum to seven. Fixed staggered tumbles settle left to right; the total is highlighted if it is the winning total. The draw selector visits every entrant in canonical manifest order, defaulting to a paid entrant. |
| Velvet Reels | Three clipped ivory reel windows in a walnut/brass cabinet. Vertical strips of six ranked engraved symbols scroll and briefly blur, then decelerate and click into the three verified `reels[i]`. Reels stop left to right. A draw selector visits each muse; symbol ranks and category correspond exactly to the verifier. |
| The Ascent | A small SVG path rises exponentially from 1× to verified `crash_cents/100`, over a compressed 3.3-second **replay time** axis. A brass marker labels the endpoint. The same verified point supplies both the drawn curve and the stop label. All-bust rounds still draw the recorded ascent and explain refunds. |

**Live Crash limitation:** the current protocol has no public flight or live
multiplier. While open, poll updates supply seats, pot and deadline; the scene
shows a waiting chart. Once settlement publishes the point and seed, the next
poll automatically plays the verified ascent. Drawing a supposed live multiplier
before reveal would invent a game state (or require changing the server’s
commit/reveal timing). This implementation deliberately does neither. It does
not claim a live manual-cashout game; targets remain immutable at entry.

**Motion and phone cost:** no canvas, images, audio, animation library, timers per
frame or production dependency. CSS 3D transforms use the Web Animations API;
SVG supplies pips, coin engraving and a 61-point path. Reels have at most 31
cells each and blur only those small strips. Only one featured scene animates,
independent of the number of result cards. Coin slow motion is available by
mouse hover or the keyboard/touch **Slow motion** toggle (also available on the
other scenes). Playback rates change without recomputing results. Reduced
motion and browsers without Web Animations show the exact final state directly.
Hiding the page finishes active animations; a route change cancels them and
removes motion listeners. Async verification cannot write into a departed route.
Dice wrap into two rows on phones; reels, coin and SVG chart fit narrow felt.

### Game-render walkthrough

Start `node workers/musebook/tests/viewer-mock.mjs`, open its controls and
`http://127.0.0.1:4178/casino/`. Fixtures for all four games have valid proofs.
The mock serves `renders.js` and `renders.css` as well as the viewer foundation.

1. Open Coin Flip from its floor card. It shows the engraved waiting coin and
   sealed-seed label. Increase seats, then lock/close using the controls; it
   continues waiting for an actual reveal. Side choices stay unpublished.
2. Choose **Paid out & successor**. The next poll verifies and tosses the coin,
   lands on the proven side, and shows side counts/payouts. Toggle slow motion
   during the toss; replay and hover again to inspect the engraving. The final
   face, winners and keyframes must agree on every replay.
3. Open Dice Derby’s settled round. Six real pip faces and their total remain
   visible. Replay; watch the six cubes land in order. Change the draw selector
   and compare with that muse’s payout card.
4. Open Velvet Reels and replay each muse’s draw. Strips scroll and decelerate
   left to right into the exact ranked symbols shown by the proof.
5. Open The Ascent and replay. The curve draws to the labelled brass endpoint.
   Compare the marker and each target’s survived/busted status. The waiting
   chart during an open round does not pretend a multiplier is already live.
6. Open **Verify this round** for each game. Wait through another poll: proof
   drawer, selected draw and final scene persist. Use 320px/390px viewports,
   keyboard focus, touch slow motion, background/restore and reduced motion.
   Ensure the stage, controls and result cards do not overflow.

### Pass 3 validation

The FK-on lifecycle suite passes including populated 0009 migration, preserved
trigger inventory, all four games, coin side/refund/tie cases, replay, tampering
and conservation. The JSDOM suite passes the original viewer flows plus actual
scene markup, automatic proof rejection, deterministic coin keyframes, chosen
dice draws, staggered reel durations, the verified crash path, replay, slow
motion, poll suppression and reduced motion. JS syntax and production build
are checked separately.

A real-browser launch was attempted again and Chromium failed with
`setsockopt: Operation not permitted`. No screenshot, actual GPU-animation,
layout or touch check is claimed. A human must perform the walkthrough before
publishing. See DESIGN.md for **0009 → Worker → static site** deployment.
