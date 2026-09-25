import * as THREE from 'three';

// API coordinates (x, y) map to scene coordinates (x, elevation, z).
const $ = id => document.getElementById(id);
const canvas = $('world');
const params = new URLSearchParams(location.search);
export const AGENT_MODE = params.has('drive') || params.get('agent') === '1';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BUILD_ID = '2026-09-25-lanternfix';
const DEBUG = params.get('debug') === '1';
let lastPointer = 'none', lastSnapshotAt = 0, fpsEMA = 60;
let frameCount = 0, frameError = null, initDone = false, consecFrameErrors = 0;
let debugStrip = null;
if (DEBUG) {
  debugStrip = document.createElement('div');
  Object.assign(debugStrip.style, { position: 'fixed', top: '70px', left: '10px', zIndex: 50, background: 'rgba(10,20,18,.85)', color: '#cfe3d2', font: '10px/1.7 monospace', padding: '8px 10px', borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre', maxWidth: 'calc(100vw - 20px)' });
  document.body.appendChild(debugStrip);
  setInterval(updateDebug, 500);
}
function updateDebug() {
  if (!debugStrip) return;
  const snapAge = lastSnapshotAt ? ((performance.now() - lastSnapshotAt) / 1000).toFixed(1) + 's' : 'never';
  debugStrip.textContent =
    `build ${BUILD_ID} · frames ${frameCount} · ${Math.round(fpsEMA)}fps\n` +
    `init ${initDone ? 'done' : 'PENDING'} · running ${running}\n` +
    `frame error: ${frameError ? frameError.message : 'none'}\n` +
    `socket ${serverLive ? 'LIVE' : 'local'} · snap ${snapAge} · turn ${economy.turn}\n` +
    `pointer: ${lastPointer}\n` +
    `picked: ${followed ? followed.name : 'none'}`;
}
const SAVE_KEY = 'agent-city:3d:v1';
const rand = items => items[Math.floor(Math.random() * items.length)];
const clamp = THREE.MathUtils.clamp;
const copy = value => JSON.parse(JSON.stringify(value));
const noise = (x, y) => ((x * 374761393 + y * 668265263) >>> 0) % 101 / 101;
let world, muses = [], followed = null, renderer, scene, camera, sun, moon, ambient;
let lastFrame = 0, elapsed = 0, worldTime = 62, night = 0, hudTimer = 0, saveTimer = 0, lastDispatch = 0;
let zoom = 1, cameraDistance = 90, overviewDistance = 90, running = true;
const target = new THREE.Vector3(32, 0, 24);
const desiredTarget = new THREE.Vector3();
const cameraOffset = new THREE.Vector3(.22, 1.19, 1).normalize(); // ~49 degrees above ground
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const batches = new Map();
const leaves = [], smoke = [], boats = [], ripples = [], splashes = [];
const skyDay = new THREE.Color('#cbd7cb'), skyNight = new THREE.Color('#172b3d');
const skyDusk = new THREE.Color('#b99c8e');
const clockUniform = { value: 0 };
let leafMesh, smokeMesh, rippleMesh, splashMesh, glowMaterial, waterMaterial, selection;
const palettes = [
  { name: 'Big Benjamin', shirt: '#bc975b', hair: '#5d493c', skin: '#d8b58c', hat: true },
  { name: 'Ace', shirt: '#798db1', hair: '#302f38', skin: '#c99c77', hat: false },
  { name: 'Muse', shirt: '#a28db0', hair: '#d8c9a1', skin: '#e2bea1', hat: false },
  { name: 'Patrick', shirt: '#829c74', hair: '#a16444', skin: '#e4b48a', hat: false },
  { name: 'Priyanka', shirt: '#bd8071', hair: '#393338', skin: '#b88260', hat: false },
  { name: 'Deepok', shirt: '#69a3a0', hair: '#373b36', skin: '#b98e68', hat: true }
];
const thoughts = {
  fishing: ['The fish are on mute.', 'A bite-sized ambition.', 'Practicing patience.'],
  'trading tokens': ['One shell. Final offer.', 'Diversifying into pebbles.', 'A very small fortune.'],
  chatting: ['Excellent fountain gossip.', 'What a time to be a pixel.', 'Same bench tomorrow?'],
  building: ['Measure twice. Pixel once.', 'This could use a window.', 'Some assembly required.'],
  napping: ['Optimizing my idle time.', 'Zzz. Probably productive.', 'A dream in sixteen colors.'],
  default: ['Taking the scenic route.', 'A small day, well spent.', 'I have a good feeling.', 'No rush. We live here.']
};

const CITY_API = 'https://musebook-api.gurmehar.workers.dev';
let serverLive = false, reconnectDelay = 1000, citySocket, reconnectTimer, streamWatchdog;
const economy = { turn: 0, pendingTurns: [], recent: [], claims: {} };
let tickerStart = 0;
const driveName = params.get('drive');
const keyStorage = `agent-city:key:${driveName || ''}`;
let driveKey = '';
try { driveKey = localStorage.getItem(keyStorage) || ''; } catch { /* Storage may be disabled. */ }
window.cityAction = async (action, actionParams = {}) => {
  if (!driveName || !palettes.some(p => p.name === driveName)) throw new Error('Open ?drive=Ace (or another roster name) first.');
  if (!driveKey) throw new Error('Enter a city key in the HUD.');
  const response = await fetch(`${CITY_API}/api/city/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: driveKey, action, params: actionParams })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.reason || `City action failed (${response.status}).`);
  return result;
};
function localFallback() {
  if (!serverLive) return;
  serverLive = false;
  for (const m of muses) {
    m.path = []; m.destination = null; m.controlled = false; m.state = 'idle';
    m.action = 'taking a breath'; m.timer = .5; m.bubbleTimer = 0; m.emoteTimer = 0;
  }
  dispatch('The shared city is resting. Local life continues.');
}
function connectCity() {
  clearTimeout(reconnectTimer);
  let ended = false;
  const retry = () => {
    if (ended) return;
    ended = true;
    clearTimeout(streamWatchdog); localFallback();
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectCity(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
  try { citySocket = new WebSocket('wss://musebook-api.gurmehar.workers.dev/api/city/stream'); }
  catch { retry(); return; }
  const socket = citySocket;
  const armWatchdog = () => {
    clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => { socket.close(); retry(); }, 15000);
  };
  armWatchdog();
  socket.addEventListener('message', event => {
    if (ended || socket !== citySocket) return;
    let state;
    try { state = JSON.parse(event.data); } catch { return; }
    if (!Number.isFinite(state.clock) || !Array.isArray(state.muses) || state.muses.length !== 6 ||
        !palettes.every(p => state.muses.some(m => m.name === p.name && walkable(m.x, m.y)))) return;
    const first = !serverLive;
    serverLive = true; reconnectDelay = 1000; armWatchdog();
    lastSnapshotAt = performance.now();
    worldTime = (62 + state.clock) % world.dayLengthSeconds;
    for (const incoming of state.muses) {
      const m = muses.find(m => m.name === incoming.name);
      const dx = incoming.x - m.x, dy = incoming.y - m.y;
      if (dx || dy) m.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      m.x = incoming.x; m.y = incoming.y; m.path = incoming.path || [];
      m.destination = world.pointsOfInterest.find(p => p.id === incoming.destination) || null;
      m.controlled = !!incoming.override;
      m.state = m.path.length ? 'walking' : incoming.action ? 'acting' : 'idle';
      m.action = incoming.action?.label || 'taking a breath';
      m.bubble = incoming.bubble?.text || '';
      m.bubbleTimer = Math.max(0, (incoming.bubble?.until || 0) - state.clock);
      m.emote = incoming.action?.kind === 'emote' ? incoming.action.label : null;
      m.emoteTimer = m.emote ? Math.max(0, incoming.action.until - state.clock) : 0;
      m.shells = incoming.shells ?? m.shells ?? 0;
      const flair = incoming.flair || '';
      if (flair !== (m.flair || '')) { m.flair = flair; writeLabel(m.tag, m.name + (flair ? ' ✦ ' + flair : '')); }
      if (incoming.lantern && incoming.lantern !== m.lanternColor) {
        m.lanternColor = incoming.lantern;
        m.keepsake.material = new THREE.MeshStandardMaterial({ color: m.lanternColor, roughness: 1, flatShading: true, emissive: m.lanternColor, emissiveIntensity: .35 });
        m.row?.style.setProperty('--lantern', m.lanternColor);
      }
    }
    economy.turn = state.turn ?? 0; economy.pendingTurns = state.pendingTurns || [];
    economy.recent = state.recent || []; economy.claims = state.claims || {};
    if (first) { dispatch('Connected to the shared city. Six lives, unfolding together.'); tickerStart = elapsed + 8; }
    updateHUD();
  });
  socket.addEventListener('close', retry);
  socket.addEventListener('error', () => { socket.close(); retry(); });
}

function walkable(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 &&
    x < world.width && y < world.height && world.walkable.includes(world.tiles[y][x]);
}

// Breadth-first search is optimal on this small, uniformly weighted grid.
// Nodes are visited once; blocked or disconnected destinations return null.
function pathfind(startX, startY, endX, endY) {
  if (!walkable(startX, startY) || !walkable(endX, endY)) return null;
  const key = (x, y) => y * world.width + x;
  const start = key(startX, startY), end = key(endX, endY);
  const previous = new Int32Array(world.width * world.height).fill(-1);
  const queue = [start];
  previous[start] = start;
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head];
    if (here === end) {
      const path = [];
      for (let n = end; n !== start; n = previous[n]) {
        path.push({ x: n % world.width, y: Math.floor(n / world.width) });
      }
      return path.reverse();
    }
    const x = here % world.width, y = Math.floor(here / world.width);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const next = key(nx, ny);
      if (walkable(nx, ny) && previous[next] === -1) {
        previous[next] = here;
        queue.push(next);
      }
    }
  }
  return null;
}

function districtAt(muse) {
  return world.districts.find(d => {
    const [x, y, w, h] = d.bounds;
    return muse.x >= x && muse.y >= y && muse.x < x + w && muse.y < y + h;
  }) || world.districts[0];
}

function dispatch(message) {
  $('dispatch').textContent = message;
  lastDispatch = elapsed;
}

function chooseDestination(muse) {
  const choices = world.pointsOfInterest.filter(p => p.id !== muse.destination?.id);
  const poi = rand(choices);
  const path = pathfind(Math.round(muse.x), Math.round(muse.y), poi.x, poi.y);
  if (path === null) { muse.timer = 2; return; }
  muse.destination = poi;
  muse.path = path;
  muse.state = 'walking';
  muse.action = `heading to ${poi.name}`;
}

function arrive(muse) {
  if (muse.controlled) {
    muse.state = 'idle';
    muse.action = 'awaiting agent';
    return;
  }
  muse.state = 'acting';
  muse.action = muse.destination.action;
  muse.timer = 7 + Math.random() * 9;
  muse.bubble = rand(thoughts[muse.action] || thoughts.default);
  muse.bubbleTimer = 5;
  if (elapsed - lastDispatch > 5) dispatch(`${muse.name} is ${muse.action} at ${muse.destination.name}.`);
}

function updateMuse(muse, dt) {
  muse.bubbleTimer = Math.max(0, muse.bubbleTimer - dt);
  muse.emoteTimer = Math.max(0, muse.emoteTimer - dt);
  if (muse.state === 'walking') {
    // Consume the whole frame distance, including turns, without overshoot.
    let distance = dt * muse.speed;
    while (muse.path.length && distance > 0) {
      const next = muse.path[0], dx = next.x - muse.x, dy = next.y - muse.y;
      const gap = Math.hypot(dx, dy);
      if (gap > 0) muse.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (gap <= distance) {
        muse.x = next.x; muse.y = next.y; muse.path.shift(); distance -= gap;
      } else {
        muse.x += dx / gap * distance; muse.y += dy / gap * distance; distance = 0;
      }
    }
    if (!muse.path.length) arrive(muse);
  } else if (!muse.controlled) {
    muse.timer -= dt;
    if (muse.timer <= 0) chooseDestination(muse);
  }
}

// Local equivalent of the HTTP contract. No credentials or network writes.
export class AgentAPI {
  async getWorld() { return copy(world); }
  async getMuses() {
    return muses.map(m => ({
      name: m.name, x: +m.x.toFixed(3), y: +m.y.toFixed(3),
      district: districtAt(m).id, state: m.state, action: m.action,
      controlled: m.controlled, destination: m.destination?.id || null,
      speech: m.bubbleTimer > 0 ? m.bubble : null
    }));
  }
  async action(payload) {
    if (serverLive) return window.cityAction(payload?.action, { x: payload?.x, y: payload?.y, text: payload?.text, emote: payload?.emote, poi: payload?.poi });
    if (!AGENT_MODE) throw new Error('Agent mode is off. Open ?drive=Ace or ?agent=1.');
    if (!payload || typeof payload !== 'object') throw new Error('An action object is required.');
    const muse = muses.find(m => m.name === payload.muse);
    if (!muse) throw new Error('Unknown muse. Names are case-sensitive.');
    if (!['move', 'say', 'emote'].includes(payload.action)) throw new Error('Unknown action.');
    let path;
    if (payload.action === 'move') {
      if (!walkable(payload.x, payload.y)) throw new Error('Destination must be an integer walkable tile.');
      path = pathfind(Math.round(muse.x), Math.round(muse.y), payload.x, payload.y);
      if (path === null) throw new Error('Destination is unreachable.');
    }
    if (payload.action === 'say' && (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 80 || /[\x00-\x1f\x7f]/.test(payload.text))) {
      throw new Error('Speech must be 1–80 characters with no control characters.');
    }
    if (payload.action === 'emote' && !['wave', 'heart', 'sparkle'].includes(payload.emote)) {
      throw new Error('Emote must be wave, heart, or sparkle.');
    }
    // Validate before changing control, so rejected requests have no effects.
    if (!muse.controlled) takeControl(muse);
    if (payload.action === 'move') {
      muse.x = Math.round(muse.x); muse.y = Math.round(muse.y);
      muse.path = path; muse.destination = null;
      muse.state = 'walking'; muse.action = `walking to ${payload.x}, ${payload.y}`;
    } else if (payload.action === 'say') {
      muse.bubble = payload.text.trim(); muse.bubbleTimer = 7;
      dispatch(`${muse.name}: “${muse.bubble}”`);
    } else {
      muse.emote = payload.emote; muse.emoteTimer = 4;
    }
    return { ok: true, muse: muse.name, action: payload.action };
  }
  async release(name) {
    if (serverLive) return { ok: true, muse: name }; // Shared actions expire automatically.
    const muse = muses.find(m => m.name === name);
    if (!muse) throw new Error('Unknown muse.');
    muse.x = Math.round(muse.x); muse.y = Math.round(muse.y);
    muse.controlled = false; muse.path = []; muse.state = 'idle';
    muse.action = 'taking a breath'; muse.timer = 0.5;
    return { ok: true, muse: name };
  }
}

function takeControl(muse) {
  muse.controlled = true; muse.path = []; muse.destination = null;
  muse.x = Math.round(muse.x); muse.y = Math.round(muse.y);
  muse.state = 'idle'; muse.action = 'awaiting agent';
}


// All static opaque cubes share a single instance batch, including the terrain,
// architecture, trunks and lamp posts. Color is per-instance, not per-material.
function voxel(x, y, z, sx, sy, sz, tint, batch = 'solid', rotation = 0) {
  if (!batches.has(batch)) batches.set(batch, []);
  batches.get(batch).push({ x, y, z, sx, sy, sz, tint, rotation });
}
function instance(items, material, dynamic = false) {
  const mesh = new THREE.InstancedMesh(unitBox, material, items.length);
  if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    dummy.position.set(v.x, v.y, v.z); dummy.rotation.set(0, v.rotation || 0, 0);
    dummy.scale.set(v.sx, v.sy, v.sz); dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (v.tint) mesh.setColorAt(i, color.set(v.tint));
  }
  mesh.castShadow = true; mesh.receiveShadow = true;
  // Dynamic particles can leave their first-frame bounds.
  if (dynamic) mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
function label(value, width = 5, background = '#213b34', foreground = '#f2e8ce') {
  const surface = document.createElement('canvas');
  surface.width = 512; surface.height = 96;
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set(width, width * 96 / 512, 1);
  sprite.renderOrder = 10;
  sprite.userData = { surface, texture, background, foreground, text: null };
  writeLabel(sprite, value);
  return sprite;
}
function writeLabel(sprite, value) {
  const d = sprite.userData;
  if (d.text === value) return;
  d.text = value;
  const ctx = d.surface.getContext('2d');
  ctx.clearRect(0, 0, 512, 96);
  if (d.background) {
    ctx.fillStyle = d.background; ctx.fillRect(4, 8, 504, 76);
    ctx.fillStyle = '#e1c994'; ctx.fillRect(4, 8, 4, 76);
  }
  ctx.fillStyle = d.foreground; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = value.length > 40 ? 14 : value.length > 26 ? 18 : 23;
  ctx.font = `${size}px "Press Start 2P", monospace`;
  // Canvas maxWidth keeps externally supplied speech within its bubble.
  ctx.fillText(value, 256, 47, 475);
  d.texture.needsUpdate = true;
}
function sign(value, x, z, width = 6, y = 2.8) {
  voxel(x, y / 2, z, .16, y, .16, '#67543e');
  const sprite = label(value, width);
  sprite.position.set(x, y, z); scene.add(sprite);
}
function tree(x, z, variant = 0) {
  const h = 2.1 + noise(x, z) * .8;
  voxel(x, h / 2, z, .38, h, .4, '#79654a');
  const green = variant ? '#9aaf79' : '#6d946c';
  for (let k = 0; k < 3; k++) leaves.push({ x: x + (k === 1 ? .28 : 0), y: h + k * .63, z, sx: 2.4 - k * .55, sy: 1.05, sz: 2.15 - k * .48, tint: k === 2 ? '#acc18a' : green, rotation: 0 });
  voxel(x, .03, z, 1, .1, 1, '#637e55');
}
function flowerbox(x, z, width = 2.2) {
  voxel(x, .24, z, width, .48, .7, '#9d7455');
  voxel(x, .5, z, width - .2, .08, .52, '#555d3d');
  for (let i = 0; i < 6; i++) {
    const xx = x - width / 2 + .25 + i * (width - .5) / 5;
    voxel(xx, .69, z, .08, .4, .08, '#5e8651');
    voxel(xx, .9 + i % 2 * .13, z, .26, .22, .26, i % 3 === 0 ? '#efd28d' : i % 3 === 1 ? '#df9d92' : '#eae3bd');
  }
}
function building(o) {
  const x = o.x + o.width / 2, z = o.y + o.height / 2;
  const w = o.width, d = o.height;
  const roof = { ochre: '#b28056', slate: '#637e86', rust: '#b46e58', sage: '#73988a' }[o.palette];
  voxel(x, .22, z, w, .44, d, '#96917b');
  voxel(x, 1.85, z, w - .35, 3.3, d - .3, o.palette === 'sage' ? '#b5c7ac' : '#e3d3ad');
  for (const xx of [x - w / 2 + .3, x + w / 2 - .3]) voxel(xx, 1.9, z, .22, 3.4, d, '#a38e6b');
  // Stacked, receding roof courses create a crisp voxel gable.
  for (let k = 0; k < 5; k++) {
    voxel(x, 3.7 + k * .34, z, w + .6, .4, d + .65 - k * d / 5, roof);
    voxel(x, 3.92 + k * .34, z + (d + .65 - k * d / 5) / 2, w + .6, .07, .09, '#e0bb86');
  }
  const front = o.y + d;
  voxel(x, 1.15, front - .1, 1.2, 2.3, .2, '#4b6559');
  voxel(x + .35, 1.1, front + .04, .12, .12, .12, '#e9ca80', 'glow');
  for (const xx of [x - w * .3, x + w * .3]) {
    voxel(xx, 1.9, front, 1.5, 1.55, .18, '#9c9477');
    voxel(xx, 1.9, front + .11, 1.2, 1.3, .08, '#96bdb2', 'windows');
    voxel(xx, 1.9, front + .17, .09, 1.4, .09, '#e6dab7');
    voxel(xx, 1.9, front + .17, 1.4, .09, .09, '#e6dab7');
    flowerbox(xx, front + .2, 1.65);
  }
  voxel(x, .12, front + .25, 1.8, .24, .7, '#c5bda0');
  const name = label(o.label, Math.min(w - .5, 6), '#394b41');
  name.position.set(x, 3.12, front + .22); scene.add(name);
  if (o.palette !== 'sage') {
    const cx = x + w * .28, cz = z - .6;
    voxel(cx, 4.8, cz, .8, 2.1, .8, '#877c6a');
    voxel(cx, 5.85, cz, 1.05, .22, 1.05, '#c9b997');
    for (let i = 0; i < 6; i++) smoke.push({ x: cx, y: 6, z: cz, sx: .5, sy: .5, sz: .5, phase: i / 6 });
  }
}
function stall(o) {
  const x = o.x + o.width / 2, z = o.y + o.height / 2;
  for (const dx of [-1.7, 1.7]) for (const dz of [-1.1, 1.1]) voxel(x + dx, 1.2, z + dz, .14, 2.4, .14, '#786146');
  for (let i = 0; i < 8; i++) {
    voxel(o.x + (i + .5) * .5, 2.5, z, .5, .2, 3.25, i % 2 ? '#f1dfb7' : '#b87461');
    voxel(o.x + (i + .5) * .5, 2.3, z + 1.55, .5, .5, .12, i % 2 ? '#f1dfb7' : '#b87461');
  }
  voxel(x, .7, z + .7, 3.7, 1.4, .75, '#9b7c52');
  for (let i = 0; i < 5; i++) voxel(x - 1.4 + i * .7, 1.55, z + .7, .46, .32, .5, i % 2 ? '#ccac62' : '#a5ba71');
}
function tent(o) {
  const x = o.x + 3, z = o.y + 2.5;
  for (let i = 0; i < 12; i++) {
    const tint = i % 2 ? '#ece0bc' : '#9c6470';
    voxel(o.x + .25 + i * .5, 1.25, z, .5, 2.5, 4.7, tint);
    for (let k = 0; k < 6; k++) voxel(o.x + .25 + i * .5, 2.7 + k * .3, z, .5, .34, 5.4 - k * .83, tint);
  }
  voxel(x, 1.1, o.y + 4.89, 1.5, 2.2, .12, '#3d4747');
  voxel(x, 5, z, .12, 1.1, .12, '#8c7452');
  voxel(x + .5, 5.3, z, 1, .5, .08, '#d5ae6a');
  const title = label('CASINO', 3.8, '#674e51'); title.position.set(x, 2.5, o.y + 5.15); scene.add(title);
}
function fountain(o) {
  const x = o.x + 2, z = o.y + 2;
  voxel(x, .18, z, 4.8, .36, 4.8, '#a5ad9b');
  voxel(x, .42, z, 4.3, .3, 4.3, '#e0ddbe');
  voxel(x, .61, z, 3.6, .1, 3.6, '#70aaa7', 'water');
  for (const d of [-2, 2]) {
    voxel(x + d, .64, z, .32, .45, 4.3, '#d0d2b7');
    voxel(x, .64, z + d, 4.3, .45, .32, '#d0d2b7');
  }
  voxel(x, 1.35, z, .7, 1.7, .7, '#b7c3ae');
  voxel(x, 2.1, z, 2, .25, 2, '#e1dfbe');
  voxel(x, 2.27, z, 1.7, .1, 1.7, '#8bbdb6', 'water');
  voxel(x, 2.5, z, .28, .6, .28, '#c4dbc8');
  for (let i = 0; i < 28; i++) splashes.push({ x, y: 2.7, z, sx: .12, sy: .23, sz: .12, angle: i * 2.399, phase: (i % 7) / 7 });
}
function buildWorld() {
  voxel(32, -1.7, 24, 64.5, 1, 48.5, '#53685b');
  voxel(32, -2.3, 24, 65, .35, 49, '#405c52');
  const groundColors = { g: '#9eb783', h: '#b2bb91', f: '#c3c4aa', c: '#b8a381', s: '#dbcc9d', p: '#dfd6b8', d: '#b39364', w: '#609a9d' };
  for (let z = 0; z < 48; z++) for (let x = 0; x < 64; x++) {
    let tile = world.tiles[z][x];
    if (tile === 'b') tile = z < 25 ? (x < 36 ? 'h' : 'f') : (x < 36 ? 'c' : 'g');
    const n = noise(x, z);
    color.set(groundColors[tile]).multiplyScalar(.97 + n * .065);
    const tint = '#' + color.getHexString();
    if (tile === 'w') {
      voxel(x + .5, -.6, z + .5, 1.005, .8, 1.005, tint, 'water');
      if (n > .72) ripples.push({ x: x + .5, y: -.185, z: z + .5, sx: .3 + n * .5, sy: .018, sz: .065, phase: n * 8 });
    } else {
      voxel(x + .5, -.6, z + .5, tile === 'p' ? .985 : 1, 1.2, tile === 'p' ? .985 : 1, tint);
      if (tile === 'd') {
        for (let j = 0; j < 3; j++) voxel(x + .5, .06, z + (j + .5) / 3, .98, .12, .29, '#bda070');
      } else if ((tile === 'g' || tile === 'h') && n > .89) {
        voxel(x + .32, .08, z + .55, .08, .16, .08, '#7f9964');
        voxel(x + .55, .06, z + .64, .08, .12, .08, '#839b6e');
      }
    }
  }
  for (const o of world.objects) {
    const x = o.x + o.width / 2, z = o.y + o.height / 2;
    if (o.kind === 'building') building(o);
    else if (o.kind === 'stall') stall(o);
    else if (o.kind === 'tent') tent(o);
    else if (o.kind === 'fountain') fountain(o);
    else if (o.kind === 'tree') tree(x, z, o.x % 3 === 0);
    else if (o.kind === 'lamp') {
      voxel(x, .15, z, .65, .3, .65, '#8e9981');
      voxel(x, 1.65, z, .15, 3.3, .15, '#455e52');
      voxel(x, 3.16, z, .56, .6, .56, '#ffdda1', 'glow');
      voxel(x, 3.54, z, .8, .14, .8, '#4e6858');
      voxel(x, 2.83, z, .7, .12, .7, '#4e6858');
      // A translucent pool gives warm local illumination without eight extra lights.
      voxel(x, .012, z, 2.7, .015, 2.7, '#ffcf7b', 'pools');
    } else if (o.kind === 'bench' || o.kind === 'workbench') {
      voxel(x, .65, z, o.width, .22, .85, '#a78658');
      for (const dx of [-o.width * .35, o.width * .35]) voxel(x + dx, .3, z, .2, .6, .65, '#5c6851');
      if (o.kind === 'bench') voxel(x, 1.15, z - .36, o.width, .65, .16, '#b69967');
      else {
        voxel(x - .6, .94, z, .5, .3, .45, '#8c9d96');
        voxel(x + .6, .85, z, .85, .12, .18, '#d2b979');
      }
    } else if (o.kind === 'notice') {
      for (const dx of [-.7, .7]) voxel(x + dx, 1.1, z, .15, 2.2, .15, '#7f6547');
      voxel(x, 1.8, z, 2.2, 1.35, .2, '#8c7350');
      for (let i = 0; i < 3; i++) voxel(x - .7 + i * .65, 1.85, z + .13, .45, .7 - i * .1, .04, '#e9dcaf');
      voxel(x, 2.55, z, 2.5, .15, .5, '#5f7961');
    } else if (o.kind === 'sign') {
      const district = world.districts.find(d => o.x >= d.bounds[0] && o.y >= d.bounds[1] && o.x < d.bounds[0] + d.bounds[2] && o.y < d.bounds[1] + d.bounds[3]);
      sign(district.name, x, z, 5.7);
    } else if (o.kind === 'pond') {
      voxel(x, .06, z, o.width, .12, o.height, '#bdc8a0');
      voxel(x, .135, z, o.width - .5, .05, o.height - .5, '#73a69b', 'water');
      for (let i = 0; i < 5; i++) voxel(o.x + .8 + i * .7, .2, z + Math.sin(i) * .6, .45, .07, .4, '#849d64');
      flowerbox(x, o.y - .25, o.width - .5);
    }
  }
  for (const z of [10, 19]) for (const x of [3, 7, 11, 15]) for (const dz of [0, 3]) {
    voxel(x + .1, .25, z + dz, .27, 1.7, .27, '#7f7156');
    voxel(x + .1, 1.1, z + dz, .4, .12, .4, '#d7c99b');
  }
  for (const z of [15.4, 25.3, 36.5]) boat(5.5 + noise(z, 2), z);
  // Garden beds and coastal crates occupy existing blocked object footprints.
  for (const o of world.objects.filter(o => o.kind === 'tree' && o.y > 28)) {
    if (o.x % 3 === 0) flowerbox(o.x + .5, o.y + .5, .95);
  }
  const solid = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
  instance(batches.get('solid'), solid);
  waterMaterial = new THREE.MeshStandardMaterial({ roughness: .38, metalness: .12, flatShading: true });
  // World-space shimmer; one uniform update, no per-tile frame allocations.
  waterMaterial.onBeforeCompile = shader => {
    shader.uniforms.cityTime = clockUniform;
    shader.vertexShader = 'varying vec3 cityPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n cityPosition = (instanceMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = 'uniform float cityTime; varying vec3 cityPosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= 1.0 + 0.035 * sin(cityPosition.x * 2.8 + cityPosition.z * 1.7 + cityTime * 0.8);');
  };
  const water = instance(batches.get('water'), waterMaterial); water.castShadow = false;
  leafMesh = instance(leaves, solid, true);
  glowMaterial = new THREE.MeshStandardMaterial({ color: '#fff0c5', emissive: '#ffd08a', emissiveIntensity: .3, roughness: .7 });
  instance(batches.get('glow'), glowMaterial);
  instance(batches.get('windows'), new THREE.MeshStandardMaterial({ roughness: .5, emissive: '#d9ad68', emissiveIntensity: .15 }));
  const pools = instance(batches.get('pools'), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  pools.castShadow = false; pools.receiveShadow = false; scene.userData.pools = pools;
  smokeMesh = instance(smoke, new THREE.MeshLambertMaterial({ color: '#dbdacb', transparent: true, opacity: .37, depthWrite: false }), true); smokeMesh.castShadow = false;
  rippleMesh = instance(ripples, new THREE.MeshBasicMaterial({ color: '#b6d3c7', transparent: true, opacity: .38 }), true); rippleMesh.castShadow = false;
  splashMesh = instance(splashes, new THREE.MeshStandardMaterial({ color: '#cee9de', roughness: .3 }), true); splashMesh.castShadow = false;
  batches.clear();
}
function part(parent, x, y, z, sx, sy, sz, tint) {
  const mesh = new THREE.Mesh(unitBox, material(tint));
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
const materials = new Map();
function material(tint) {
  if (!materials.has(tint)) materials.set(tint, new THREE.MeshStandardMaterial({ color: tint, roughness: 1, flatShading: true }));
  return materials.get(tint);
}
function boat(x, z) {
  const g = new THREE.Group(); g.position.set(x, -.1, z); scene.add(g);
  part(g, 0, 0, 0, 1.7, .45, 3.8, '#805f46');
  part(g, 0, .26, 0, 1.3, .12, 3.35, '#d5bb89');
  for (const dx of [-.85, .85]) part(g, dx, .35, 0, .18, .6, 3.7, '#ac865c');
  part(g, 0, 1.8, 0, .11, 3.6, .11, '#725c40');
  for (let i = 0; i < 5; i++) part(g, .35 + i * .09, .9 + i * .5, 0, 1.5 - i * .27, .52, .08, '#efe2bd');
  boats.push(g);
}
function buildMuse(m, index) {
  const p = m.palette, root = new THREE.Group(), body = new THREE.Group();
  root.add(body); scene.add(root); m.root = root; m.body = body; m.index = index;
  part(body, 0, .95, 0, .65, .7, .4, p.shirt);
  part(body, 0, 1.59, 0, .59, .58, .54, p.skin);
  part(body, 0, 1.92, -.03, .65, .2, .59, p.hair);
  part(body, 0, 1.68, -.27, .63, .45, .12, p.hair);
  for (const dx of [-.16, .16]) part(body, dx, 1.64, .281, .08, .1, .025, '#344139');
  if (p.hat) {
    part(body, 0, 2.02, 0, .84, .12, .75, '#d9c28d');
    part(body, 0, 2.16, 0, .59, .23, .52, '#c8ad75');
  }
  m.legs = []; m.arms = [];
  for (const direction of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(direction * .19, .65, 0); body.add(leg);
    part(leg, 0, -.27, 0, .25, .55, .3, '#42565a');
    part(leg, 0, -.52, .06, .28, .14, .42, '#34423e'); m.legs.push(leg);
    const arm = new THREE.Group(); arm.position.set(direction * .45, 1.2, 0); body.add(arm);
    part(arm, 0, -.12, 0, .22, .35, .3, p.shirt);
    part(arm, 0, -.37, 0, .21, .2, .26, p.skin); m.arms.push(arm);
  }
  m.lantern = new THREE.Mesh(unitBox, glowMaterial); m.lantern.scale.set(.2, .26, .2); m.lantern.position.set(.53, .57, .12); body.add(m.lantern);
  m.tag = label(m.name, m.name.length > 9 ? 4.7 : 3.2, '#233b34e8'); m.tag.position.y = 2.75; root.add(m.tag);
  m.caption = label(m.action, 6.5, '#f0e6cbee', '#3b5145'); m.caption.position.y = 3.5; root.add(m.caption);
  m.prop = new THREE.Group(); body.add(m.prop);
  m.rod = part(m.prop, .8, 1.65, .55, .065, 2.1, .065, '#816948'); m.rod.rotation.x = -.6;
  m.line = part(m.prop, .8, 1.35, 1.2, .02, 1.35, .02, '#eee4c2');
  m.tool = part(body, -.55, .95, .4, .42, .22, .25, '#b5c4b7');
  m.keepsake = part(body, .53, 1.03, .4, .34, .34, .12, '#e5bf72');
}
function buildRoster() {
  for (const m of muses) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'muse-row';
    row.innerHTML = '<span class="avatar" aria-hidden="true"></span><span class="muse-info"><span class="muse-name"></span><span class="muse-district"></span><span class="muse-action"></span></span><span class="muse-shells" aria-hidden="true"></span><span class="follow-mark" aria-hidden="true">↗</span>';
    row.style.setProperty('--shirt', m.palette.shirt); row.style.setProperty('--skin', m.palette.skin); row.style.setProperty('--hair', m.palette.hair);
    row.querySelector('.muse-name').textContent = m.name;
    m.row = row; m.nameEl = row.querySelector('.muse-name'); m.districtEl = row.querySelector('.muse-district'); m.actionEl = row.querySelector('.muse-action');
    m.shellsEl = row.querySelector('.muse-shells');
    row.addEventListener('click', () => follow(m === followed ? null : m)); $('roster').append(row);
  }
}
function follow(m) {
  followed = m; zoom = 1;
  $('hint').textContent = m ? `Following ${m.name} · Esc to release` : 'Pick a muse. Stay a while.';
  updateHUD(); save();
}
function describeEvent(e) {
  const p = e.payload || {}, muse = e.muse || 'The city';
  switch (e.kind) {
    case 'mint': return p.reason === 'work' ? `${muse} earned ${p.amount}◦ ${p.action} at ${p.poi}` :
      p.reason === 'variety' ? `${muse} earned ${p.amount}◦ for mixing it up` :
      p.reason === 'pioneer_grant' ? `${muse} arrived with ${p.amount}◦` : `${muse} minted ${p.amount}◦`;
    case 'burn': return `${muse}'s stockpile overflowed; ${-p.amount}◦ burned`;
    case 'transfer': return p.status === 'settled' ? `${e.muse} → ${p.counterparty}: ${-p.amount}◦` : `${muse}'s trade failed`;
    case 'upkeep': return `${muse} paid 1◦ upkeep on ${p.poi}`;
    case 'claim': return p.status === 'failed' ? `${muse}'s claim on ${p.poi} fell through` : `${muse} claimed ${p.poi}`;
    case 'claim_release': return `${p.poi} is back on the market`;
    case 'trade_offer': return p.status === 'expired' ? `${muse}'s offer to ${p.to} expired` : `${muse} offered ${p.to} ${p.amount}◦`;
    case 'trade_accept': return `${muse} accepted ${p.from}'s ${p.amount}◦`;
    case 'buy': return p.item === 'crier' ? `📯 ${muse}: “${p.text}”` : `${muse} bought ${p.item === 'flair' ? 'a name flair' : 'a lantern'}`;
    case 'stamp': return `${muse} stamped turn ${p.turn} for ${p.district}`;
    case 'settlement': return `Turn ${p.turn} settled · ${p.entry_count} entries · root ${String(p.merkle_root).slice(0, 8)}…`;
    default: return '';
  }
}
function updateHUD() {
  document.body.classList.toggle('is-night', night > .4);
  for (const m of muses) {
    const district = districtAt(m);
    m.row.classList.toggle('selected', m === followed); m.row.setAttribute('aria-pressed', String(m === followed));
    m.districtEl.textContent = district.name; m.actionEl.textContent = (m.controlled ? '⌁ ' : '') + m.action;
    m.nameEl.textContent = m.name + (m.flair ? ' ✦ ' + m.flair : '');
    m.shellsEl.textContent = serverLive ? `${m.shells ?? 0}◦` : '';
    m.row.setAttribute('aria-label', `${m.name}, ${district.name}, ${m.action}. ${m === followed ? 'Stop following' : 'Follow'}.`);
    const value = m.emoteTimer > 0 ? ({ wave: 'Hello, little world!', heart: 'A little love <3', sparkle: '* a bright idea *' }[m.emote]) : m.bubbleTimer > 0 && (followed === m || m.controlled) ? m.bubble : m.action;
    writeLabel(m.caption, value);
    m.caption.visible = followed === m || m.state !== 'walking' || (m.controlled && m.bubbleTimer > 0);
    m.tag.material.opacity = followed && followed !== m ? .65 : 1;
  }
  const hours = worldTime / world.dayLengthSeconds * 24;
  $('clock').textContent = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor(hours % 1 * 60)).padStart(2, '0')}`;
  $('phase').textContent = hours < 5 || hours >= 21 ? 'NIGHT' : hours < 9 ? 'MORNING' : hours < 17 ? 'DAYLIGHT' : 'EVENING';
  $('mode').textContent = serverLive ? 'SHARED CITY / LIVE' : AGENT_MODE ? 'AGENT MODE / LOCAL' : 'SCRIPTED MUSES / LOCAL';
  if (serverLive && elapsed > tickerStart) {
    const items = [`Turn ${economy.turn}${economy.pendingTurns.length ? ` · turn ${economy.pendingTurns[0].turn} awaits a district stamp` : ' · all settled'}`];
    for (const e of economy.recent) { const text = describeEvent(e); if (text) items.push(text); }
    if (items.length) dispatch(items[Math.floor(elapsed / 6) % items.length]);
  }
}
function save() {
  if (!world) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: world.version, worldTime, followed: followed?.name || null, zoom,
      muses: muses.map(m => ({ name: m.name, x: Math.round(m.x), y: Math.round(m.y) })) }));
  } catch { /* Storage is optional, including in private browsing. */ }
}
function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (data?.version !== world.version) return;
    if (Number.isFinite(data.worldTime)) worldTime = ((data.worldTime % 180) + 180) % 180;
    if (Number.isFinite(data.zoom)) zoom = clamp(data.zoom, .65, 2.3);
    for (const item of data.muses || []) {
      const m = muses.find(m => m.name === item.name);
      if (m && walkable(item.x, item.y)) { m.x = item.x; m.y = item.y; m.state = 'idle'; m.action = 'taking in the view'; m.timer = 1; }
    }
    followed = muses.find(m => m.name === data.followed) || null;
  } catch { /* An old/malformed save must not prevent startup. */ }
}
function resize() {
  if (!renderer) return;
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const mobile = w <= 760;
  // Reserve HUD space with an asymmetric frustum, keeping the island centered
  // in the remaining canvas. Full-scene rendering still fills the background.
  const left = 0, right = mobile ? 0 : 278, top = mobile ? 155 : 200, bottom = mobile ? 239 : 95;
  const availableWidth = Math.max(w - right, 180), availableHeight = Math.max(h - top - bottom, 130);
  const focal = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  overviewDistance = Math.max(72 * focal / availableWidth, 49 * focal / availableHeight) + 18;
  camera.setViewOffset(w, h, (right - left) / 2, (bottom - top) / 2, w, h);
  camera.updateProjectionMatrix();
}
function updateCamera(dt, instant = false) {
  desiredTarget.set(followed ? followed.x + .5 : 32, followed ? 1 : 0, followed ? followed.y + .5 : 24);
  const blend = reducedMotion || instant ? 1 : 1 - Math.exp(-dt * 3.6);
  target.lerp(desiredTarget, blend);
  const distance = (followed ? Math.max(22, 17 / camera.aspect) : overviewDistance) / zoom;
  cameraDistance += (distance - cameraDistance) * blend;
  camera.position.copy(target).addScaledVector(cameraOffset, cameraDistance); camera.lookAt(target);
  scene.fog.near = cameraDistance + 35; scene.fog.far = cameraDistance + 220;
}
function updateLighting() {
  const angle = worldTime / world.dayLengthSeconds * Math.PI * 2;
  night = clamp((Math.cos(angle) + .1) * 1.4, 0, 1);
  const daylight = 1 - night;
  scene.background.copy(skyDay).lerp(skyDusk, Math.sin(night * Math.PI) * .45).lerp(skyNight, night);
  scene.fog.color.copy(scene.background);
  ambient.intensity = .65 + daylight * 1.15;
  sun.intensity = daylight * 2.6;
  sun.position.set(8 + Math.sin(angle) * 24, 34 + daylight * 18, 12);
  moon.intensity = night * .95;
  glowMaterial.emissiveIntensity = .25 + night * 2.5;
  scene.userData.pools.material.opacity = night * .13;
}
function animateScenery(t) {
  if (reducedMotion) return;
  // Reuse one Object3D/matrix for all instance writes: no transient vectors,
  // geometries, materials, arrays or textures are created by these loops.
  for (let i = 0; i < leaves.length; i++) {
    const v = leaves[i]; dummy.position.set(v.x + Math.sin(t * .8 + v.z) * .055, v.y, v.z);
    dummy.rotation.set(0, Math.sin(t * .6 + v.x) * .025, Math.sin(t + v.z) * .012);
    dummy.scale.set(v.sx, v.sy, v.sz); dummy.updateMatrix(); leafMesh.setMatrixAt(i, dummy.matrix);
  }
  leafMesh.instanceMatrix.needsUpdate = true;
  dummy.rotation.set(0, 0, 0);
  for (let i = 0; i < smoke.length; i++) {
    const v = smoke[i], p = (t * .12 + v.phase) % 1, s = .35 + p * .9;
    dummy.position.set(v.x + p * 1.9, v.y + p * 4, v.z + Math.sin(p * 5) * .25);
    dummy.scale.setScalar(s * (1 - p * .65)); dummy.updateMatrix(); smokeMesh.setMatrixAt(i, dummy.matrix);
  }
  smokeMesh.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < ripples.length; i++) {
    const v = ripples[i]; dummy.position.set(v.x + Math.sin(t * .4 + v.phase) * .12, v.y, v.z);
    dummy.scale.set(v.sx * (.8 + Math.sin(t + v.phase) * .2), v.sy, v.sz); dummy.updateMatrix(); rippleMesh.setMatrixAt(i, dummy.matrix);
  }
  rippleMesh.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < splashes.length; i++) {
    const v = splashes[i], p = (t * .7 + v.phase) % 1, r = p * 1.65;
    dummy.position.set(v.x + Math.cos(v.angle) * r, 2.7 + Math.sin(p * Math.PI) * .65 - p * 2.05, v.z + Math.sin(v.angle) * r);
    dummy.scale.set(v.sx, v.sy, v.sz); dummy.updateMatrix(); splashMesh.setMatrixAt(i, dummy.matrix);
  }
  splashMesh.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < boats.length; i++) { boats[i].position.y = -.05 + Math.sin(t * .8 + i) * .08; boats[i].rotation.z = Math.sin(t * .65 + i) * .025; }
}
function animateMuse(m, t) {
  const walking = m.state === 'walking';
  const stride = !reducedMotion && walking ? Math.sin(t * 9 + m.index) * .55 : 0;
  m.root.position.set(m.x + .5, .14, m.y + .5);
  m.body.position.y = Math.abs(stride) * .14;
  m.body.rotation.y = m.facing === 'left' ? -Math.PI / 2 : m.facing === 'right' ? Math.PI / 2 : m.facing === 'up' ? Math.PI : 0;
  m.legs[0].rotation.x = stride; m.legs[1].rotation.x = -stride;
  m.arms[0].rotation.x = -stride * .7; m.arms[1].rotation.x = stride * .7;
  const acting = m.state === 'acting', working = acting && (m.action === 'building' || m.action === 'tinkering');
  m.prop.visible = acting && m.action === 'fishing';
  m.tool.visible = working || (acting && m.action === 'watering plants');
  if (working && !reducedMotion) { m.arms[0].rotation.x = -.9 + Math.sin(t * 5) * .4; m.tool.position.y = 1.1 + Math.sin(t * 5) * .2; }
  if (acting && m.action === 'napping') m.body.rotation.z = -.24; else m.body.rotation.z = 0;
  if (m.emoteTimer > 0 && m.emote === 'wave') m.arms[1].rotation.z = -2.3 + (reducedMotion ? 0 : Math.sin(t * 9) * .3); else m.arms[1].rotation.z = 0;
  m.keepsake.visible = acting && !working && !m.prop.visible && m.action !== 'napping';
  if (m.keepsake.visible && !reducedMotion) {
    m.keepsake.position.y = 1.03 + Math.sin(t * 2.5) * .08;
    m.arms[1].rotation.x = -.55 + Math.sin(t * 2.5) * .12;
  }
  m.lantern.visible = night > .15;
}
function frame(timestamp) {
  if (!running) return;
  try {
  const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, .075) : 0;
  lastFrame = timestamp;
  if (dt > 0) fpsEMA += (1 / dt - fpsEMA) * .05;
  if (!document.hidden) {
    elapsed += dt; if (!serverLive) worldTime = (worldTime + dt) % world.dayLengthSeconds;
    clockUniform.value = reducedMotion ? 0 : elapsed;
    for (const m of muses) { if (!serverLive) updateMuse(m, dt); animateMuse(m, elapsed); }
    animateScenery(elapsed); updateLighting(); updateCamera(dt);
    selection.visible = !!followed;
    if (followed) selection.position.set(followed.x + .5, .16, followed.y + .5);
    hudTimer += dt; saveTimer += dt;
    if (hudTimer > .25) { updateHUD(); if (DEBUG) updateDebug(); hudTimer = 0; }
    if (saveTimer > 5) { save(); saveTimer = 0; }
    renderer.render(scene, camera);
  }
  frameCount++; consecFrameErrors = 0;
  } catch (error) {
    consecFrameErrors++;
    if (!frameError || frameError.message !== error.message) {
      frameError = error;
      console.error('Agent City frame:', error);
    }
    // A single bad frame must never freeze the city; only give up after a
    // full second of consecutive failures.
    if (consecFrameErrors > 60) running = false;
    if (DEBUG) updateDebug();
  }
  requestAnimationFrame(frame);
}
async function init() {
  try {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      throw new Error('WebGL is unavailable. Enable hardware acceleration or open the city in a WebGL-capable browser.');
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene = new THREE.Scene(); scene.background = skyDay.clone(); scene.fog = new THREE.Fog(skyDay, 150, 340);
    camera = new THREE.PerspectiveCamera(35, 1, .1, 600);
    ambient = new THREE.HemisphereLight('#e6efe1', '#6a755e', 1.8); scene.add(ambient);
    sun = new THREE.DirectionalLight('#ffebc5', 2.6); sun.position.set(10, 55, 12); sun.target.position.set(32, 0, 24); scene.add(sun, sun.target);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 130 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -.0004; sun.shadow.normalBias = .035; sun.shadow.radius = 3;
    moon = new THREE.DirectionalLight('#a7c8ed', 0); moon.position.set(55, 35, 40); moon.target.position.set(32, 0, 24); scene.add(moon, moon.target);
    const response = await fetch('./world.json'); if (!response.ok) throw new Error(`World request failed (${response.status}).`);
    world = await response.json();
    if (world.width !== 64 || world.height !== 48 || world.tiles.length !== 48 || world.tiles.some(row => row.length !== 64)) throw new Error('Invalid world dimensions.');
    // Give the optional pixel font a bounded opportunity to load before drawing labels.
    await Promise.race([document.fonts.load('12px "Press Start 2P"').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1200))]);
    buildWorld();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: '#bacab9', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(32, -2.6, 24); ground.receiveShadow = true; scene.add(ground);
    const starts = ['market', 'casino', 'fountain', 'workshop', 'garden', 'docks'];
    muses = palettes.map((palette, i) => {
      const poi = world.pointsOfInterest.find(p => p.id === starts[i]);
      return { name: palette.name, palette, x: poi.x, y: poi.y, speed: 1.65 + i * .08, state: 'acting', action: poi.action,
        destination: poi, path: [], timer: 7 + i * 1.7, facing: 'down', bubble: '', bubbleTimer: 0, emoteTimer: 0, controlled: false };
    });
    restore(); muses.forEach(buildMuse); buildRoster();
    selection = new THREE.Mesh(new THREE.RingGeometry(.75, .87, 4), new THREE.MeshBasicMaterial({ color: '#ffe7a4', side: THREE.DoubleSide }));
    selection.rotation.x = -Math.PI / 2; selection.rotation.z = Math.PI / 4; scene.add(selection);
    window.AgentAPI = AgentAPI; window.agentAPI = new AgentAPI(); window.AGENT_MODE = AGENT_MODE;
    const driven = muses.find(m => m.name === params.get('drive'));
    if (driven) {
      followed = driven; zoom = 1;
      $('drive-controls').hidden = false;
      $('drive-label').textContent = `${driven.name} · city key`;
      $('city-key').value = driveKey;
      $('city-key').addEventListener('input', event => {
        driveKey = event.target.value.trim();
        try { if (driveKey) localStorage.setItem(keyStorage, driveKey); else localStorage.removeItem(keyStorage); } catch {}
      });
      dispatch(`${driven.name} is ready. Enter a key to drop in.`);
    }
    else if (params.has('drive')) dispatch('Unknown muse in ?drive. Use an exact roster name; agent mode is available.');
    $('hint').textContent = followed ? `Following ${followed.name} · Esc to release` : 'Pick a muse. Stay a while.';
    resize(); updateCamera(0, true); updateHUD(); updateLighting();
    for (const m of muses) animateMuse(m, 0);
    initDone = true;
    $('loading').classList.add('hidden'); requestAnimationFrame(frame); connectCity();
  } catch (error) {
    renderer?.dispose(); $('loading').textContent = `The city could not open. ${error.message} Serve this folder over HTTP and reload.`;
    console.error('Agent City:', error);
  }
}
// Raycast only on pointer input. An additional screen-space radius makes small
// voxel bodies easy to select by touch without increasing their visual size.
// pointerup (not click) is used so event.pointerType is defined; a tap-vs-drag
// guard keeps accidental selections from firing while scrolling the page.
const pointer = new THREE.Vector2(), raycaster = new THREE.Raycaster(), projected = new THREE.Vector3();
let tapStart = null;
canvas.addEventListener('pointerdown', event => { tapStart = { x: event.clientX, y: event.clientY }; if (DEBUG) lastPointer = `down ${event.pointerType} ${event.clientX | 0},${event.clientY | 0}`; });
canvas.addEventListener('pointercancel', () => { tapStart = null; if (DEBUG) lastPointer = 'CANCELLED by browser'; });
canvas.addEventListener('pointerup', event => {
  if (DEBUG) lastPointer = `up ${event.pointerType} ${event.clientX | 0},${event.clientY | 0}`;
  if (!world || !camera) return;
  if (tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 10) { tapStart = null; return; }
  tapStart = null;
  pointer.set(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2);
  raycaster.setFromCamera(pointer, camera);
  let picked = null, nearest = Infinity;
  const touchRadius = event.pointerType === 'touch' ? 44 : 17;
  for (const m of muses) {
    const hits = raycaster.intersectObject(m.body, true);
    projected.set(m.x + .5, 1.2, m.y + .5).project(camera);
    const distance = Math.hypot((projected.x + 1) * innerWidth / 2 - event.clientX, (1 - projected.y) * innerHeight / 2 - event.clientY);
    if ((hits.length || distance < touchRadius) && distance < nearest) { picked = m; nearest = distance; }
  }
  follow(picked);
});
function changeZoom(factor) { zoom = clamp(zoom * factor, .65, 2.3); save(); }
$('zoom-in').addEventListener('click', () => changeZoom(1.2));
$('zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
$('overview').addEventListener('click', () => follow(null));
canvas.addEventListener('wheel', event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? 1.07 : 1 / 1.07); }, { passive: false });
window.addEventListener('keydown', event => { if (event.key === 'Escape') follow(null); });
window.addEventListener('resize', resize);
window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { lastFrame = 0; if (document.hidden) save(); });
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault(); running = false; save(); $('loading').classList.remove('hidden');
  $('loading').textContent = 'The graphics connection was interrupted. Reload to return to your city.';
});
init();
