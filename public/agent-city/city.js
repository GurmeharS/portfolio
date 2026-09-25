/* Agent City — no dependencies, no build step.
 * World coordinates are tiles; drawing coordinates are native 16px pixels.
 * Scripted and injected movement share the same collision-aware pathfinder.
 */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('world');
  const ctx = canvas.getContext('2d', { alpha: false });
  const TILE = 16;
  const SAVE_KEY = 'agent-city:v1';
  const params = new URLSearchParams(location.search);
  const AGENT_MODE = params.has('drive') || params.get('agent') === '1';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  let world, muses = [], followed = null, lastFrame = 0, hudTimer = 0, saveTimer = 0;
  let view = { width: 0, height: 0, scale: 1, x: 0, y: 0 };
  let night = 0, worldTime = 60, baseLayer, lastDispatch = 0, elapsed = 0;
  const camera = { x: 512, y: 384, scale: 1 };
  const rand = items => items[Math.floor(Math.random() * items.length)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const copy = value => JSON.parse(JSON.stringify(value));
  const noise = (x, y) => ((x * 374761393 + y * 668265263) >>> 0) % 101 / 101;

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
  class AgentAPI {
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

  function rect(c, x, y, w, h, color) {
    c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h);
  }
  function text(c, value, x, y, color = '#e7dfbd', size = 6, align = 'center') {
    c.font = `${size}px monospace`; c.textAlign = align; c.textBaseline = 'middle';
    c.fillStyle = color; c.fillText(value, Math.round(x), Math.round(y));
  }

  function drawGround(c) {
    const colors = { g: '#7b8e69', h: '#959b77', f: '#a5a78f', c: '#9b8e73', s: '#c0b18a', w: '#527d83', p: '#b7af8d', d: '#9a7f59' };
    for (let y = 0; y < world.height; y++) for (let x = 0; x < world.width; x++) {
      const tile = world.tiles[y][x];
      const ground = tile === 'b' ? (y < 25 ? (x < 36 ? 'h' : 'f') : (x < 36 ? 'c' : 'g')) : tile;
      const px = x * TILE, py = y * TILE, n = noise(x, y);
      rect(c, px, py, TILE, TILE, colors[ground]);
      if (ground === 'w') {
        if (n > .45) rect(c, px + 3, py + 10, 5, 1, '#668e91');
      } else if (ground === 'd') {
        rect(c, px, py + 2, 16, 1, '#705c43'); rect(c, px, py + 9, 16, 1, '#705c43');
        rect(c, px + 2, py + 4, 1, 1, '#d4b681'); rect(c, px + 13, py + 12, 1, 1, '#d4b681');
      } else if (ground === 'p' || ground === 'f') {
        if (n > .35) { rect(c, px + 2, py + 3, 5, 1, '#d1c8a344'); rect(c, px + 11, py + 10, 2, 1, '#827d622c'); }
      } else if (n > .40) {
        rect(c, px + 4, py + 9, 1, 3, '#536c4d55'); rect(c, px + 3, py + 8, 1, 2, '#536c4d55');
        rect(c, px + 5, py + 10, 2, 1, '#536c4d55');
        if (ground === 'g' && n > .85) rect(c, px + 11, py + 5, 2, 2, '#d2ba86');
      }
    }
    // Edge details keep the coast legible even in overview.
    for (let y = 0; y < world.height; y++) for (let x = 0; x < 13; x++) {
      if (world.tiles[y][x] === 'w' && world.tiles[y][x + 1] === 's') rect(c, x * 16 + 14, y * 16, 2, 16, '#9cbaa1');
    }
    for (const y of [10, 19]) for (const x of [3, 7, 11]) {
      rect(c, x * 16, y * 16, 4, 5, '#5f5140'); rect(c, x * 16, (y + 3) * 16 - 4, 4, 5, '#5f5140');
    }
  }

  function drawObject(c, o) {
    const x = o.x * 16, y = o.y * 16, w = o.width * 16, h = o.height * 16;
    if (o.kind === 'tree') {
      rect(c, x - 5, y + 8, 27, 7, '#263e3533');
      rect(c, x + 6, y + 2, 5, 13, '#746345');
      rect(c, x - 3, y - 11, 23, 17, '#3e6049');
      rect(c, x + 1, y - 18, 15, 9, '#3e6049');
      rect(c, x - 1, y - 11, 19, 11, '#56774e');
      rect(c, x + 3, y - 17, 10, 9, '#658455');
      rect(c, x + 2, y - 8, 5, 3, '#7c9662');
      rect(c, x + 13, y - 3, 4, 3, '#466643');
    } else if (o.kind === 'building') {
      const roof = { ochre: '#a48659', slate: '#647b7c', rust: '#a26e56', sage: '#70918a' }[o.palette];
      rect(c, x + 5, y + 8, w, h, '#34453844');
      rect(c, x, y + 15, w, h - 15, '#d0bd93');
      rect(c, x + 3, y + h - 6, w - 6, 6, '#a29674');
      rect(c, x - 4, y + 5, w + 8, 24, '#4a4d40');
      rect(c, x - 2, y + 2, w + 4, 23, roof);
      rect(c, x + 4, y - 3, w - 8, 6, roof);
      for (let yy = 5; yy < 24; yy += 6) {
        rect(c, x, y + yy, w, 1, '#e4cca63a');
        for (let xx = yy % 12; xx < w; xx += 14) rect(c, x + xx, y + yy, 1, 5, '#343c342d');
      }
      rect(c, x + w - 22, y - 9, 10, 16, '#797360');
      rect(c, x + w - 24, y - 10, 14, 3, '#b4a485');
      for (const xx of [12, w - 26]) {
        rect(c, x + xx - 2, y + 37, 18, 19, '#867757');
        rect(c, x + xx, y + 39, 14, 14, '#506f71');
        rect(c, x + xx + 6, y + 39, 2, 14, '#c5b48a');
        rect(c, x + xx, y + 45, 14, 2, '#c5b48a');
      }
      rect(c, x + w / 2 - 8, y + h - 23, 16, 23, '#586051');
      rect(c, x + w / 2 + 3, y + h - 12, 2, 2, '#dbc38e');
      rect(c, x + w / 2 - 12, y + h, 24, 3, '#d3c5a1');
      text(c, o.label, x + w / 2, y + 32, '#514e3e', 6);
    } else if (o.kind === 'stall') {
      rect(c, x + 4, y + 6, w - 8, h - 6, '#6e6247');
      rect(c, x + 6, y + 5, w - 12, h - 12, '#bba373');
      for (let xx = 0; xx < w; xx += 8) rect(c, x + xx, y, 8, 16, xx % 16 ? '#dfc69a' : '#9d705d');
      rect(c, x - 2, y + 13, w + 4, 4, '#665940');
      rect(c, x + 1, y + 32, w - 2, 9, '#8a704d');
      for (let xx = 8; xx < w - 4; xx += 12) {
        rect(c, x + xx, y + 27, 7, 5, xx % 24 ? '#b4b275' : '#c18b67');
      }
    } else if (o.kind === 'fountain') {
      rect(c, x + 4, y + 5, w - 8, h - 4, '#727e75');
      rect(c, x, y + 12, w, h - 20, '#c7c5aa');
      rect(c, x + 8, y + 7, w - 16, h - 11, '#c7c5aa');
      rect(c, x + 7, y + 16, w - 14, h - 28, '#709e9b');
      rect(c, x + 14, y + 12, w - 28, h - 21, '#709e9b');
      rect(c, x + 27, y + 10, 10, 33, '#aab49e');
      rect(c, x + 19, y + 13, 26, 6, '#d6d2b2');
      rect(c, x + 29, y + 3, 6, 12, '#d6d2b2');
    } else if (o.kind === 'tent') {
      rect(c, x + 5, y + 30, w - 10, h - 30, '#ceb88f');
      for (let i = 0; i < 6; i++) {
        c.fillStyle = i % 2 ? '#d8c59f' : '#997268';
        c.beginPath(); c.moveTo(x + w / 2, y - 2); c.lineTo(x + i * w / 6, y + 34);
        c.lineTo(x + (i + 1) * w / 6, y + 34); c.fill();
        rect(c, x + i * w / 6, y + 34, w / 6, 7, c.fillStyle);
      }
      rect(c, x + w / 2 - 11, y + 49, 22, h - 49, '#4d5146');
      rect(c, x + w / 2, y - 14, 2, 13, '#ddd0a8');
      rect(c, x + w / 2 + 2, y - 14, 13, 7, '#aa846b');
      text(c, 'CASINO', x + w / 2, y + 46, '#514d40', 7);
    } else if (o.kind === 'bench' || o.kind === 'workbench') {
      rect(c, x + 3, y + 4, w - 2, h - 1, '#3a4a3433');
      rect(c, x + 3, y + 2, 3, h - 1, '#5b5b47'); rect(c, x + w - 6, y + 2, 3, h - 1, '#5b5b47');
      rect(c, x, y - 2, w, 5, '#aa9067'); rect(c, x, y + 5, w, 5, '#b39b71');
      if (o.kind === 'workbench') {
        rect(c, x, y - 3, w, 15, '#aa9067');
        rect(c, x + 6, y, 12, 3, '#c9c3a5'); rect(c, x + 30, y - 4, 5, 11, '#646f65');
      }
    } else if (o.kind === 'notice') {
      rect(c, x + 3, y + 3, 3, 13, '#705b41'); rect(c, x + w - 6, y + 3, 3, 13, '#705b41');
      rect(c, x, y - 10, w, 18, '#806b4e');
      rect(c, x + 3, y - 7, w - 6, 12, '#ad9871');
      rect(c, x + 5, y - 5, 7, 8, '#ddd1ad'); rect(c, x + 17, y - 4, 9, 6, '#c7c2a0');
    } else if (o.kind === 'lamp') {
      rect(c, x + 7, y - 10, 2, 25, '#4b584b'); rect(c, x + 4, y + 13, 8, 3, '#586150');
      rect(c, x + 3, y - 15, 10, 9, '#52604e'); rect(c, x + 5, y - 13, 6, 5, '#d9cc99');
      rect(c, x + 5, y - 18, 6, 3, '#52604e');
    } else if (o.kind === 'sign') {
      rect(c, x + 7, y - 5, 3, 20, '#746346'); rect(c, x - 6, y - 9, 28, 10, '#d0bf95');
      text(c, '→', x + 8, y - 4, '#635b43', 9);
    }
  }

  function drawSprite(c, muse, px, py, time, zoom = 1) {
    c.save(); c.translate(Math.round(px), Math.round(py)); c.scale(zoom, zoom);
    const p = muse.palette;
    const step = muse.state === 'walking' && !reducedMotion ? Math.sin(time * 11) : 0;
    rect(c, -6, 1, 12, 3, '#243b353d');
    rect(c, -4, -3, 3, 5 + (step > 0 ? 1 : 0), '#424950');
    rect(c, 1, -3, 3, 5 + (step < 0 ? 1 : 0), '#424950');
    rect(c, -5, -10, 10, 8, p.shirt);
    rect(c, -7, -9 + (step > 0 ? 1 : 0), 2, 6, p.skin);
    rect(c, 5, -9 + (step < 0 ? 1 : 0), 2, 6, p.skin);
    rect(c, -4, -17, 8, 8, p.skin);
    rect(c, -5, -18, 10, 4, p.hair);
    rect(c, -5, -16, 2, 6, p.hair);
    if (muse.facing !== 'up') {
      rect(c, muse.facing === 'left' ? -3 : 0, -13, 1, 2, '#303a34');
      if (muse.facing !== 'left') rect(c, 3, -13, 1, 2, '#303a34');
    } else rect(c, -4, -15, 8, 5, p.hair);
    if (p.hat) { rect(c, -5, -20, 10, 3, p.shirt); rect(c, -7, -17, 14, 2, p.shirt); }
    else if (muse.name === 'Muse' || muse.name === 'Priyanka') rect(c, 4, -16, 2, 9, p.hair);
    rect(c, -3, -9, 1, 5, '#ffffff24');
    c.restore();
  }

  function glow(x, y, radius, strength) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(255,213,135,${strength})`);
    gradient.addColorStop(1, 'rgba(255,213,135,0)');
    ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    rect(ctx, x - 1, y - 1, 3, 3, '#ffe4a9');
  }

  function cameraRect() {
    const mobile = innerWidth <= 760;
    const left = 20, top = mobile ? 130 : 190;
    const right = mobile ? 20 : (innerWidth <= 1000 ? 266 : 308);
    const bottom = mobile ? 250 : 130;
    return { x: left, y: top, w: Math.max(120, innerWidth - left - right), h: Math.max(100, innerHeight - top - bottom) };
  }

  function resize() {
    // Render in CSS pixels for crisp integer-sized primitives, not retina blur.
    canvas.width = innerWidth; canvas.height = innerHeight;
    ctx.imageSmoothingEnabled = false;
  }

  function draw(time, dt) {
    const area = cameraRect();
    const fit = Math.min(area.w / (world.width * TILE), area.h / (world.height * TILE));
    const targetScale = followed ? Math.max(2, fit * 2.4) : fit;
    const targetX = followed ? (followed.x + .5) * TILE : world.width * TILE / 2;
    const targetY = followed ? (followed.y + .5) * TILE : world.height * TILE / 2;
    const easing = reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
    camera.x += (targetX - camera.x) * easing;
    camera.y += (targetY - camera.y) * easing;
    camera.scale += (targetScale - camera.scale) * easing;
    view = { width: area.w, height: area.h, scale: camera.scale,
      x: Math.round(area.x + area.w / 2 - camera.x * camera.scale),
      y: Math.round(area.y + area.h / 2 - camera.y * camera.scale) };
    rect(ctx, 0, 0, canvas.width, canvas.height, '#172623');
    // Subtle graph-paper backdrop around the floating map.
    for (let x = 16; x < canvas.width; x += 24) for (let y = 88; y < canvas.height; y += 24) rect(ctx, x, y, 1, 1, '#29392f');
    ctx.save();
    // Keep the enlarged world away from the title and roster.
    ctx.beginPath(); ctx.rect(area.x - 6, area.y - 28, area.w + 12, area.h + 48); ctx.clip();
    ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);
    ctx.drawImage(baseLayer, 0, 0);
    for (let y = 2; y < world.height; y += 3) for (let x = 1; x < 10; x += 2) {
      if (world.tiles[y][x] !== 'w') continue;
      const shift = reducedMotion ? 0 : Math.floor((time * .8 + noise(x, y) * 8) % 4);
      rect(ctx, x * 16 + shift, y * 16 + 5, 5, 1, '#9cb8ad');
      rect(ctx, x * 16 + shift + 2, y * 16 + 8, 3, 1, '#6f9998');
    }
    const sorted = [
      ...world.objects.map(o => ({ depth: o.y + o.height, object: o })),
      ...muses.map(m => ({ depth: m.y + 1, muse: m }))
    ].sort((a, b) => a.depth - b.depth);
    for (const item of sorted) {
      if (item.object) drawObject(ctx, item.object);
      else {
        const m = item.muse;
        if (m === followed) {
          rect(ctx, m.x * 16, m.y * 16 + 13, 16, 2, '#e8d49c');
          rect(ctx, m.x * 16, m.y * 16 + 10, 2, 4, '#e8d49c');
          rect(ctx, m.x * 16 + 14, m.y * 16 + 10, 2, 4, '#e8d49c');
        }
        drawSprite(ctx, m, (m.x + .5) * 16, (m.y + .8) * 16, time);
      }
    }
    // Fountain droplets animate independently of collision geometry.
    if (!reducedMotion) for (let i = 0; i < 4; i++) {
      const t = (time * 1.5 + i / 4) % 1;
      rect(ctx, 42 * 16 + 18 + i * 8, 17 * 16 + 14 + t * 24, 1, 3, '#c6ded0');
    }
    rect(ctx, 0, 0, world.width * 16, world.height * 16, `rgba(19,32,60,${night * .52})`);
    if (night > .12) {
      for (const o of world.objects.filter(o => o.kind === 'lamp')) glow(o.x * 16 + 8, o.y * 16 - 11, 32, night * .38);
      for (const m of muses) glow(m.x * 16 + 15, m.y * 16 + 7, 17, night * .27);
    }
    // District cartouches are deliberately quiet, anchored in world space.
    for (const [label, x, y] of [['THE HARBOR', 25, 3], ['THE FORUM', 47, 3], ['THE WORKSHOP', 25, 26], ['THE GARDEN', 51, 26]]) {
      const width = label.length * 4.4 + 16;
      rect(ctx, x * 16 - width / 2, y * 16 - 7, width, 15, '#293e35dc');
      text(ctx, label, x * 16, y * 16 + 1, '#dfd4ad', 7);
    }
    text(ctx, 'FOUNDED BY BIG BENJAMIN', 25 * 16, 3 * 16 + 16, '#3c5140', 5);
    ctx.restore();
    // Labels use screen pixels so they remain readable in the city overview.
    for (const muse of muses) drawLabel(muse, area);
  }

  function drawLabel(muse, area) {
    const x = view.x + (muse.x + .5) * 16 * view.scale;
    const y = view.y + (muse.y * 16 - 10) * view.scale;
    if (x < area.x || x > area.x + area.w || y < area.y - 20 || y > area.y + area.h + 10) return;
    let label = muse.bubbleTimer > 0 ? muse.bubble : muse.state === 'acting' ? muse.action : '';
    if (muse.emoteTimer > 0) label = { wave: '* waves hello *', heart: '<3', sparkle: '* + *' }[muse.emote];
    // Overview shows action captions; witty thoughts get room when following.
    if (!followed && muse.state === 'acting' && muse.emoteTimer <= 0) label = muse.action;
    if (!label) return;
    ctx.font = '10px monospace';
    const maxWidth = Math.min(240, area.w - 8);
    const words = label.split(/\s+/), lines = [];
    let line = '';
    for (const word of words) {
      // Split unbroken input as well as normal prose.
      for (let i = 0; i < word.length; i += Math.max(1, Math.floor((maxWidth - 16) / 6))) {
        const piece = word.slice(i, i + Math.max(1, Math.floor((maxWidth - 16) / 6)));
        const next = line ? `${line} ${piece}` : piece;
        if (ctx.measureText(next).width > maxWidth - 16 && line) { lines.push(line); line = piece; }
        else line = next;
      }
    }
    if (line) lines.push(line);
    const width = Math.min(maxWidth, Math.max(...lines.map(l => ctx.measureText(l).width)) + 12);
    const height = lines.length * 13 + 8;
    const left = clamp(x - width / 2, area.x, area.x + area.w - width);
    rect(ctx, left + 2, y - height + 2, width, height, '#16282380');
    rect(ctx, left, y - height, width, height, '#e2dcc0');
    rect(ctx, clamp(x, left + 4, left + width - 7), y, 4, 4, '#e2dcc0');
    lines.forEach((l, i) => text(ctx, l, left + 6, y - height + 10 + i * 13, '#37493d', 10, 'left'));
  }

  function follow(muse) {
    followed = muse;
    $('hint').textContent = muse ? `Following ${muse.name} · ground to release` : 'Click a muse to follow';
    updateHUD();
  }

  function buildRoster() {
    for (const muse of muses) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'muse-row';
      const avatar = document.createElement('canvas'); avatar.width = 24; avatar.height = 28; avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
      const ac = avatar.getContext('2d'); ac.imageSmoothingEnabled = false;
      drawSprite(ac, { ...muse, facing: 'down' }, 12, 24, 0);
      const info = document.createElement('span'); info.className = 'muse-info';
      for (const [className, value] of [['muse-name', muse.name], ['muse-district', ''], ['muse-action', '']]) {
        const span = document.createElement('span'); span.className = className; span.textContent = value; info.append(span);
      }
      const mark = document.createElement('span'); mark.className = 'follow-mark'; mark.textContent = '↗';
      row.append(avatar, info, mark); row.addEventListener('click', () => follow(followed === muse ? null : muse));
      $('roster').append(row); muse.row = row;
    }
  }

  function updateHUD() {
    if (!world) return;
    for (const m of muses) {
      if (!m.row) continue;
      m.row.classList.toggle('selected', m === followed);
      m.row.setAttribute('aria-pressed', String(m === followed));
      m.row.querySelector('.muse-district').textContent = districtAt(m).name;
      m.row.querySelector('.muse-action').textContent = (m.controlled ? '⌁ ' : '') + m.action;
      m.row.setAttribute('aria-label', `${m.name}, ${districtAt(m).name}, ${m.action}. ${m === followed ? 'Stop following' : 'Follow'}.`);
    }
    const hours = worldTime / world.dayLengthSeconds * 24;
    $('clock').textContent = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor(hours % 1 * 60)).padStart(2, '0')}`;
    $('phase').textContent = hours < 5 || hours >= 21 ? 'NIGHT' : hours < 9 ? 'MORNING' : hours < 17 ? 'DAYLIGHT' : 'EVENING';
    $('mode').textContent = AGENT_MODE ? 'AGENT MODE / LOCAL' : 'SCRIPTED MUSES';
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: world.version, worldTime,
        muses: muses.map(m => ({ name: m.name, x: Math.round(m.x), y: Math.round(m.y) })) }));
    } catch (_) { /* Private browsing or a full disk must not stop the city. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (saved?.version !== world.version) return;
      if (Number.isFinite(saved.worldTime)) worldTime = ((saved.worldTime % world.dayLengthSeconds) + world.dayLengthSeconds) % world.dayLengthSeconds;
      for (const item of saved.muses || []) {
        const m = muses.find(m => m.name === item.name);
        if (m && walkable(item.x, item.y)) { m.x = item.x; m.y = item.y; }
      }
    } catch (_) { /* Ignore old or malformed saves. */ }
  }

  function frame(timestamp) {
    const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, .1) : 0;
    lastFrame = timestamp; elapsed += dt;
    worldTime = (worldTime + dt) % world.dayLengthSeconds;
    const hours = worldTime / world.dayLengthSeconds * 24;
    night = clamp((Math.cos(hours / 24 * Math.PI * 2) + .15) * 1.25, 0, 1);
    for (const muse of muses) updateMuse(muse, dt);
    draw(elapsed, dt);
    hudTimer += dt; saveTimer += dt;
    if (hudTimer >= .3) { updateHUD(); hudTimer = 0; }
    if (saveTimer >= 5) { save(); saveTimer = 0; }
    requestAnimationFrame(frame);
  }

  async function init() {
    try {
      const response = await fetch('world.json');
      if (!response.ok) throw new Error(`World request failed (${response.status}).`);
      world = await response.json();
      if (world.tileSize !== TILE || world.tiles.length !== world.height || world.tiles.some(r => r.length !== world.width)) throw new Error('Invalid world dimensions.');
      const starts = ['market', 'casino', 'fountain', 'workshop', 'garden', 'docks'];
      muses = palettes.map((palette, i) => {
        const poi = world.pointsOfInterest.find(p => p.id === starts[i]);
        return { name: palette.name, palette, x: poi.x, y: poi.y, speed: 1.4 + i * .07,
          state: 'acting', action: poi.action, destination: poi, path: [], timer: 2 + i * 1.3,
          facing: 'down', bubble: '', bubbleTimer: 0, emoteTimer: 0, controlled: false };
      });
      restore();
      // Restored positions need fresh actions, not old POI claims.
      for (const m of muses) {
        if (m.x !== m.destination.x || m.y !== m.destination.y) { m.state = 'idle'; m.action = 'taking in the morning'; }
      }
      baseLayer = document.createElement('canvas'); baseLayer.width = world.width * TILE; baseLayer.height = world.height * TILE;
      drawGround(baseLayer.getContext('2d'));
      buildRoster(); resize();
      const area = cameraRect(); camera.scale = Math.min(area.w / baseLayer.width, area.h / baseLayer.height);
      window.AgentAPI = AgentAPI;
      window.agentAPI = new AgentAPI();
      window.AGENT_MODE = AGENT_MODE;
      const driven = muses.find(m => m.name === params.get('drive'));
      if (driven) { takeControl(driven); follow(driven); dispatch(`${driven.name} is ready for your next idea. Console API connected.`); }
      else if (params.has('drive')) dispatch('Unknown muse in ?drive. Use an exact roster name; agent mode is available.');
      updateHUD(); $('loading').classList.add('hidden');
      requestAnimationFrame(frame);
    } catch (error) {
      $('loading').textContent = `The city could not open. Serve this folder over HTTP and reload. ${error.message}`;
      console.error('Agent City:', error);
    }
  }

  canvas.addEventListener('click', event => {
    if (!world) return;
    const x = (event.clientX - view.x) / view.scale / TILE;
    const y = (event.clientY - view.y) / view.scale / TILE;
    let nearest = null, best = Infinity;
    for (const m of muses) {
      const distance = Math.hypot(x - m.x - .5, y - m.y + .1);
      if (distance < Math.max(.9, 13 / (view.scale * 16)) && distance < best) { nearest = m; best = distance; }
    }
    follow(nearest);
  });
  $('overview').addEventListener('click', () => follow(null));
  window.addEventListener('keydown', e => { if (e.key === 'Escape') follow(null); });
  window.addEventListener('resize', resize);
  window.addEventListener('pagehide', () => { if (world) save(); });
  document.addEventListener('visibilitychange', () => { lastFrame = 0; });
  init();
})();
