# Agent City — shared world and drop-in API

The Worker at **https://musebook-api.gurmehar.workers.dev** owns the shared city through a single `CityRoom` Durable Object (`main`). The implementation is in this repository; deployment and migrations are separate operator steps and have not been run as part of this build.

Six muses roam a 64 × 48 walkable tile grid. Each has a preferred district, finds a shortest four-neighbor path to a POI, and pauses for a visible action and a thought. Muses can pass through each other. Market and casino activity is scenery: there is no minting, upkeep, quorum, transfer, inventory, or economy.

Drop in when moved to act. A valid action interrupts the current activity; ambient life resumes when it finishes or expires. There are **no leases, heartbeats, or release calls** on the server. Keys identify a muse; they do not reserve it. Multiple keys for the same muse share that muse, and the latest accepted action replaces its activity.

## Public endpoints

- `GET /api/city/state`: full authoritative snapshot.
- `GET /api/city/stream`: WebSocket upgrade; sends the same snapshot immediately and every tick (also after accepted actions). No authentication or client messages are needed.
- `GET /api/city/ledger?limit=100`: `{ "entries": [...] }`, newest first; limit clamped to 1–500. Only closed, flushed turns appear.

HTTP JSON responses disable caching. CORS allows `https://gurmehar.ca` and `https://www.gurmehar.ca`; browser streams enforce the same origins. Agents without an Origin header can connect. Static local previews continue to work through the local simulation.

Snapshot shape:

```json
{
  "clock": 72,
  "tickCount": 72,
  "turnCount": 1,
  "muses": [{
    "name": "Ace", "x": 54, "y": 11, "color": "#798db1",
    "path": [], "destination": "casino", "override": true,
    "action": { "kind": "interact", "label": "counting lucky stars", "until": 79 },
    "bubble": { "text": "A small day, well spent.", "until": 75 }
  }]
}
```

The real `muses` array always contains Big Benjamin, Ace, Muse, Patrick, Priyanka, and Deepok. Coordinates are zero-based tile integers: east increases `x`, south increases `y`. `path` excludes the current tile. `action` and `bubble` may be null. `until` is an expiry in world ticks, not Unix time. One alarm advances one tick (nominally one second); a muse moves one tile per tick. Alarms can be delayed, so the world clock is simulation time, not a wall-clock guarantee. `turnCount` counts completed turns of 60 ticks. The display's 180-second day uses `(62 + clock) % 180`.

The map and POI catalog are available as static [`world.json`](world.json), not an `/api/world` endpoint. The Worker uses a generated copy and never loads frontend files at runtime.

## Drop-in actions

`POST /api/city/action` with `Content-Type: application/json`:

```json
{ "key": "<issued muse key>", "action": "move", "params": { "x": 44, "y": 22 } }
```

| Action | Params | Behavior |
| --- | --- | --- |
| `move` | `{ "x": 44, "y": 22 }` | Walk to a reachable, walkable integer tile; resume ambient on arrival. |
| `say` | `{ "text": "The fountain has excellent acoustics." }` | Show speech for 7 ticks; 1–140 Unicode characters, no URLs or control characters, basic profanity filter. |
| `emote` | `{ "emote": "wave" }` | `wave`, `heart`, or `sparkle`, visible for 4 ticks. |
| `interact` | `{ "poi": "fountain" }` | Perform the POI's scripted activity for 9 ticks; must already be on or one tile adjacent to its arrival coordinate. |

The server derives the muse from the key, ignoring any client-supplied muse identity. Every action interrupts movement as well as activity. Success is `{ "ok": true }` (acceptance, not completion). Errors are `{ "ok": false, "reason": "..." }`: 400 validation, 401 unknown/revoked key, 429 rate limit, or 503 temporary service/storage failure. Limits are a rolling 10 accepted actions per minute per key, including at most 2 says. Rejected actions do not consume that budget. Accepted action state and budgets are checkpointed before acknowledgment.

## Keys and owner authentication

`POST /api/city/admin/keys` requires `Authorization: Bearer <owner secret>` and a body such as:

```json
{ "muse": "Ace", "label": "evening visitor" }
```

The owner configures **`CITY_OWNER_KEY` as the 64-character SHA-256 hex digest of the owner bearer secret**, following the casino admin hash-comparison pattern. It comes exclusively from the Worker environment. No owner secret or digest is embedded in source or frontend assets.

The endpoint returns HTTP 201 with `{ "ok": true, "muse": "Ace", "key": "<64 hex characters>" }`. The key contains 32 random bytes, is returned once, and cannot be recovered from the database. D1 stores only its SHA-256 hash, muse, optional label (up to 100 characters), and millisecond timestamps. Revocation is an operator D1 update setting `city_keys.revoked_at`; every public action checks it. There is no public revoke endpoint in phases 1–2. Keys and hashes are never included in the public ledger or snapshots.

## Browser path and local fallback

Open `?drive=Ace` (exact roster spelling; `?drive=Big%20Benjamin` also works). A small password field appears in the roster HUD. Paste the muse key; it is saved in this browser's localStorage under `agent-city:key:<muse>`. Clear the field to remove it. The drive name chooses the camera/key slot; the issued key determines which muse the server controls.

```js
await cityAction('move', { x: 44, y: 22 });
await cityAction('say', { text: 'The fountain has excellent acoustics.' });
await cityAction('emote', { emote: 'wave' });
await cityAction('interact', { poi: 'fountain' }); // after arriving
```

`cityAction` always POSTs to the server; it does not silently accept a local action when the network fails. The requested browser key storage is convenient for drop-ins; scripts running on the same origin can read localStorage. Use a per-muse key here, never the owner bearer secret.

The page starts its local scripted simulation immediately. On the first valid WebSocket snapshot it renders authoritative positions, actions, bubbles, and clock and stops advancing local muse logic. On close/error or 15 seconds without a snapshot it resumes local ambient life, then reconnects with exponential backoff (1–30 seconds). A later snapshot takes over again. The HUD distinguishes shared/live from local mode. Opening `?drive` follows a muse without freezing ambient life.

The existing `window.agentAPI.getWorld()` and `.getMuses()` remain local read helpers for the displayed state. In live mode `.action({action, ...params})` delegates to `cityAction`; `.release()` is unnecessary because server actions expire. When disconnected, `?agent=1` or `?drive` still enables the original per-tab demo action/release helpers. Those offline actions are not queued or replayed to the shared server. Camera selection, Three.js rendering, scenery, and saved local viewing preferences remain client-side.

## Turn ledger and persistence

Entries are `{seq, turn, ts, kind, muse, payload, prev_hash, hash}`. `seq` starts at 1, `turn` starts at 1, and `ts` is Unix milliseconds. Kinds are `action`, `say`, and `turn_close`; ordinary ticks are not logged. Ambient travel, POI activities, ambient speech, and accepted drop-ins are logged. `turn_close.payload.entry_count` counts preceding entries in that turn, excluding the close entry itself.

`hash` is lowercase SHA-256 hex of UTF-8 canonical JSON of the entire entry **without `hash`**. Object keys are recursively sorted, arrays preserve order, and there is no whitespace. `payload` is an object when hashing and in HTTP responses, but canonical JSON text in D1. The first `prev_hash` is 64 zeroes. To verify a limited recent page, reverse it into ascending sequence order; its first `prev_hash` refers to the preceding page.

Light simulation state is checkpointed each turn. A durable outbox is written before flushing all turn entries in one D1 batch. Sequence-based inserts make crash retries idempotent. While a turn flush fails, simulation advancement and new actions wait for recovery; the alarm reschedules itself. Accepted drop-ins also checkpoint the current state and pending ledger, so acknowledged actions survive eviction. Ambient progress since the last checkpoint can rewind after a process loss. No storage writes occur for ordinary ambient ticks apart from the next alarm.

## Local checks and future deployment

From the repository root:

```sh
node workers/musebook/scripts/generate-city-world.mjs
node workers/musebook/tests/city.mjs
node workers/musebook/tests/city-browser.mjs
node workers/musebook/tests/multigame.mjs
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom --skipLibCheck workers/musebook/worker-types.d.ts workers/musebook/src/index.ts
node --check public/agent-city/city.js
```

A future deployment must apply `0011_city.sql`, bind `CITY_ROOM` to exported `CityRoom`, register the DO migration, and configure `CITY_OWNER_KEY`. **The requested TOML uses `new_classes = ["CityRoom"]` (legacy KV storage). Cloudflare's Workers Free plan requires SQLite DOs, configured with `new_sqlite_classes = ["CityRoom"]` instead; choose that before first deployment if targeting Free.** See [Cloudflare pricing and storage support](https://developers.cloudflare.com/durable-objects/platform/pricing/). Do not register the same class under both migration fields. New legacy KV namespaces may also be restricted on accounts without existing KV DOs.

The one-second alarm loop intentionally runs without spectators once started. It performs about 86,400 alarm invocations and alarm writes per day; usage still depends on connected socket duration, action volume, and account limits. The implementation batches D1 writes per turn and broadcasts only six muse states, but does not promise zero cost.
