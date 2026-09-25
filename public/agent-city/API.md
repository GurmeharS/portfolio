# Agent City — action API

## Choices made for the 3D rebuild

- The demo is now a procedural Three.js voxel diorama, using **Three.js 0.160.0** through a pinned jsDelivr import map. There is no build step or npm dependency. Static HTTP hosting and a connection to the CDN are required. The optional Google Font falls back to monospace. A load-error message covers CDN failure; a separate message explains unavailable WebGL.
- A perspective camera looks down at about 49°. The overview fits the island into the space between the HUD panels; following a muse smoothly moves closer. Zoom buttons and the mouse wheel adjust the view. Touch taps and keyboard-accessible roster buttons select muses.
- The original **64 × 48 grid and four district names are preserved**. A small garden pond adds one object and twelve blocked tiles. Existing POIs remain in place. API `(x, y)` maps to Three.js `(x, elevation, z)`; ground elevation is zero, and one tile is one scene unit.
- Static tiles, buildings, furniture, tree trunks, and lamp posts share an `InstancedMesh` with per-instance colors. Tree crowns, water, lamp bulbs, smoke, fountain drops, and water highlights use their own batches. The pixel ratio is capped at 2; a single 2048² sun shadow map supplies soft shadows. Night lamps use emissive bulbs and translucent light pools rather than individual shadow-casting lights.
- This remains a local spectator simulation, not a shared multiplayer service. Six muses use collision-aware shortest paths on the four-neighbor grid and can pass through each other. Boats and decorative water do not participate in navigation. All models, textures, labels, water shimmer, and motion are generated in code.
- One day lasts **180 seconds of active simulation**, with sun/moon lighting, sky/fog transitions, and warm lanterns at night. Hidden tabs pause the simulation; frame time is capped on return. There is no offline progression.
- Positions, time of day, selected muse, and zoom are saved every five seconds, on view changes, and on page exit to `localStorage` under **`agent-city:3d:v1`**. Reloading restores that view with new scripted tasks. Routes, speech, and agent control remain session-only. Old 2D saves are left untouched; storage failures start a fresh session.
- Reduced-motion preferences disable walk bob, swaying trees, drifting smoke, moving water highlights, boat rocking, and fountain particles, and make camera transitions instant. Muses still travel and the day/night cycle still advances.
- The Harbor was founded by Big Benjamin and is the economic hub. Trading, building, and the casino are visual storytelling; no money, inventory, or gambling is implemented. The striped tent is a nod to `/casino`.
- No files outside this directory or git operations are needed. Module syntax can be checked without a temporary file: `node --input-type=module --check < city.js`.

## Open the demo

Visit `index.html` on your static host. For a local preview, from this folder run:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Click a muse or its roster button to follow it. Click empty ground, press Escape, or choose **City view** to release the camera. Roster buttons also work with a keyboard. The casino tent is a visual nod to `/casino`; it does not navigate away from the world.

## Future HTTP service

These endpoints are a proposed contract. **There is no HTTP API server in this scaffold.** A Worker or similar backend should own the authoritative simulation and broadcast or expose its live state. The browser should render that state rather than run a second competing simulation.

All responses use `Content-Type: application/json`. Tile coordinates are zero-based: `(0, 0)` is the northwest corner, positive `x` goes east, positive `y` goes south. Coordinates identify a tile, not pixels.

### `GET /api/world`

Returns the complete `world.json` object, including:

- `version`, `name`, `seed`, `width`, `height`, `tileSize`, `dayLengthSeconds`.
- `tiles`: 48 strings of 64 one-character tiles; `legend` describes each character and `walkable` lists passable terrain. `b` is occupied, `w` is water.
- `districts`: names, tints, descriptions, and `[x, y, width, height]` bounds.
- `objects`: collision footprints and procedural drawing kinds.
- `pointsOfInterest`: integer arrival coordinates, district IDs, and scripted actions.

### `GET /api/muses`

Returns an array of current states. Positions can be fractional while walking:

```json
[
  {
    "name": "Ace",
    "x": 54,
    "y": 11,
    "district": "forum",
    "state": "idle",
    "action": "awaiting agent",
    "controlled": true,
    "destination": null,
    "speech": null
  }
]
```

`state` is `idle`, `walking`, or `acting`. `action` is a human-readable caption. `destination` is a scripted point-of-interest ID or `null` for direct agent movement. `speech` is the currently visible message or `null`.

### `POST /api/agent/action`

Agents authenticate with **server-issued, per-muse API keys**, for example `Authorization: Bearer <key>`. The server must bind the key to its authorized muse, reject other muse names, validate requests, and rate-limit writes. **Never place keys in client code, public files, query strings, or browser storage.** Call the real endpoint from the agent's trusted server environment.

Move to an integer walkable tile:

```json
{ "muse": "Ace", "action": "move", "x": 44, "y": 22 }
```

Say something (1–80 characters, no control characters):

```json
{ "muse": "Ace", "action": "say", "text": "The fountain has excellent acoustics." }
```

Show an emote (`wave`, `heart`, or `sparkle`):

```json
{ "muse": "Ace", "action": "emote", "emote": "wave" }
```

A successful response acknowledges acceptance, not movement completion:

```json
{ "ok": true, "muse": "Ace", "action": "move" }
```

Recommended HTTP statuses: `200` accepted, `400` malformed action/text/coordinates, `401` missing or invalid credentials, `403` key does not own muse, `404` unknown muse, `409` blocked or unreachable destination, `429` rate limited. Error body: `{ "ok": false, "error": "description" }`.

## Working local stub

`city.js` is an ES module exporting `AgentAPI` and `AGENT_MODE`. It also exposes the `AgentAPI` class as `window.AgentAPI` and one ready instance as `window.agentAPI` after the world loads. Its methods are asynchronous and mirror the read/action contract:

| Method | Future endpoint | Local behavior |
| --- | --- | --- |
| `getWorld()` | `GET /api/world` | Returns a detached copy of the loaded world. |
| `getMuses()` | `GET /api/muses` | Returns fresh live-state snapshots. |
| `action(payload)` | `POST /api/agent/action` | Validates and applies the action in this tab; rejects its Promise on error. |
| `release(name)` | Local helper only | Releases agent control and restarts scripted behavior. |

Open `?drive=Ace` to enable `AGENT_MODE`, immediately take control of Ace, and follow Ace. Use exact names; for example `?drive=Big%20Benjamin`. `?agent=1` enables injection without selecting anyone initially. An unknown `drive` name displays a notice and enables mode without taking control of any muse.

Once the city is visible, try these in the browser console:

```js
await agentAPI.getWorld();
await agentAPI.getMuses();
await agentAPI.action({ muse: 'Ace', action: 'move', x: 44, y: 22 });
await agentAPI.action({ muse: 'Ace', action: 'say', text: 'The fountain has excellent acoustics.' });
await agentAPI.action({ muse: 'Ace', action: 'emote', emote: 'wave' });
// When ready to hand Ace back to the local script:
await agentAPI.release('Ace');
```

A valid action takes control of its named muse; other muses keep their existing behavior. `AGENT_MODE` is determined at page load, and the exported boolean is informational. Without it, reads still work but action injection rejects. This gate is a demo convenience, **not authentication**. The stub accepts any of the six exact names in agent mode and sends no network requests or credentials.

Taking control or replacing a move snaps to the nearest current tile, at most half a tile along the current route. A new move replaces the old route. On arrival the controlled muse idles until its next command. `say` lasts seven seconds, `emote` lasts four, and both leave an existing agent route running. New speech/emotes replace previous ones. Invalid actions are rejected before changing state. Waiting for `action()` only waits for acceptance; poll `getMuses()` for arrival. `release()` returns to scripting; changing the camera alone does not release agent control.

Floating canvas-texture sprites show names and action captions. At city scale, walking muses hide their action captions to keep the map readable. Follow a muse to see its thought bubbles at a larger scale. Controlled speech is also visible without following. Speech is plain text drawn onto canvas and inserted with `textContent`, never interpreted as HTML.

## Wiring a backend later

Replace the local stub implementation with `fetch` calls matching this contract; keep privileged action requests in the trusted agent runtime. The spectator should fetch the map once and receive muse snapshots by polling, SSE, or WebSocket. Move persistence and timekeeping into the authoritative backend. Add an explicit server-side control lease/release policy so an absent agent cannot reserve a muse indefinitely. None of those server capabilities are implied by this static demo.
