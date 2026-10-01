// Canvas renderer + pointer handling for 迷津渡. This file owns pixels and gestures and decides
// nothing about legality: every "can this one step into the boat?" and every "may this boat cast
// off?" leaves here as a request, and js/core answers. A real mouse event and a node test
// therefore drive the same rules through the same door, which is the whole point of §3 of the
// contract — an injected page script can prove `commit()` works, it cannot prove a finger reaches.
//
// Three gestures only, and they map onto the model one-to-one:
//   * drag a role onto the boat   -> loading, costs nothing (`board`, never counts a trip)
//   * drag a role off the boat    -> unloading, costs nothing (`unboard`)
//   * click the boat, or haul it  -> one single trip (`depart`, the only place a move is counted)
// Anything core refuses is drawn as a shake plus a red flare on the roles involved, and the trip
// counter does not move — including the two law differences the spec demands be visible:
// the boatman crossing alone counts, an empty 'free' boat shakes.

import { standing } from './core/game.js';

const PAD = 16;
// Durations are seconds of *simulation*, not milliseconds of wall clock: the loop advances them
// by a fixed step (SIM_STEP) however the frames arrive, so a 30Hz tablet and a 120Hz phone glide
// the same hull over the same water in the same half-second.
const CROSS_S = 0.34; // cosmetic only: the state has already moved when the glide starts
const SHAKE_S = 0.34;
const HINT_S = 2.6;
const FLARE_S = 2.2;
const SIM_STEP = 1 / 120;
const MAX_DT = 0.05; // a tab that slept must not teleport the hull across three crossings
const RIPPLE_HZ = 0.7; // ripple phase cycles per simulated second
const PARTICLE_MAX = 48;
// Bitmaps come from assets/gen/make_art.py; every one of them is optional at draw time (see
// `artReady`), so a device that cannot fetch them still gets the procedural river it used to.
const ASSETS = {
  water: 'assets/textures/water-night.png',
  sand: 'assets/textures/sand-grain.png',
  glow: 'assets/textures/glow.png',
  seal: 'assets/textures/seal.png',
  tokens: 'assets/sprites/tokens.png',
};
const TOKEN_CELL = 128; // ASSETS.tokens is 4 x 128px, indexed by `kind`
const TOKEN_ORDER = ['ferryman', 'human', 'beast', 'goods'];
// A hull press that travels less than this is a click on the boat, not a haul. Browsers routinely
// deliver a pixel or two of jitter between pointerdown and pointerup, and "cast off" must not turn
// into "nothing happened" because of it. Past the slop the gesture is a haul and only lands if it
// actually reaches the far bank (see `up`).
const TAP_SLOP = 6;

const WATER_TOP = '#16324a';
const WATER_BOT = '#0a1822';
const SHORE = 'rgba(168, 208, 232, 0.16)';
const RIPPLE = 'rgba(186, 222, 246, 0.10)';
const SAND = '#2b2418';
const SAND_EDGE = '#4c3f28';
const REED = 'rgba(126, 148, 96, 0.5)';
const HULL = '#6d4b2d';
const HULL_DARK = '#452f1c';
const DECK = '#8d6238';
const POST = '#5d5340';
const INK = '#e6e9ef';
const DIM = 'rgba(230, 233, 239, 0.42)';
const GLOW = 'rgba(120, 220, 255, 0.9)';
const DANGER = 'rgba(255, 112, 96, 0.95)';

// Indexed by `kind` from js/core/river.js, so two devices draw the same cast the same way.
const SKIN = {
  ferryman: '#c9963f',
  human: '#5b7fa6',
  beast: '#9c5f3d',
  goods: '#7f7c4d',
};

function clamp(lo, hi, v) {
  return Math.max(lo, Math.min(hi, v));
}

// Deterministic jitter (a 32-bit LCG): the wake particles must land in the same place on a 30Hz
// phone and a 120Hz monitor, and Math.random() would make every frame-rate diff a false positive.
function lcg(seed) {
  let x = (seed | 0) || 1;
  return function next() {
    x = (Math.imul(x, 1664525) + 1013904223) | 0;
    return ((x >>> 8) & 0xffffff) / 0x1000000;
  };
}

function motionQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch (err) {
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// A hull seen slightly from above: a straight deck line and two flared bows meeting a keel.
function hullPath(ctx, x, y, w, h, deck) {
  ctx.beginPath();
  ctx.moveTo(x, deck);
  ctx.lineTo(x + w, deck);
  ctx.lineTo(x + w * 0.88, y + h);
  ctx.quadraticCurveTo(x + w / 2, y + h + h * 0.16, x + w * 0.12, y + h);
  ctx.closePath();
}

function within(px, py, box) {
  return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
}

export function createView(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  const onBoard = hooks.onBoard || (() => false);
  const onUnboard = hooks.onUnboard || (() => false);
  const onDepart = hooks.onDepart || (() => false);

  let game = null;
  let screen = { W: 320, H: 240 };
  let geo = null; // last layout, in canvas-local px: what every hit test and the harness read
  let carry = null; // { id, x, y, moved, aboard }
  let haul = null; // boat being dragged: { x0, dx, moved }
  let glide = null; // { from, to, cargo, t, dur }
  let shake = null; // { ids, boat, t, dur }
  let flare = null; // { roles, bank, why, t, dur }
  let mark = null; // { cargo, t, dur } — the hint's "load these"
  let particles = []; // { x, y, vx, vy, t, dur, r } — wake behind a travelling hull
  let raf = 0;
  let paused = false;
  let lastTs = 0;
  let animClock = 0; // cosmetic clock the ripples and the hint ring read
  let simAccumulator = 0; // fixed-step waterline: pause stops it, frame rate cannot move it
  let simTime = 0;
  let simSteps = 0;
  let frames = 0;
  let fxRnd = lcg(20261001);
  const art = { water: null, sand: null, glow: null, seal: null, tokens: null };
  const artReady = { water: false, sand: false, glow: false, seal: false, tokens: false };
  const patterns = { water: null, sand: null };
  const reduceMq = motionQuery();
  let reducedMotion = !!(reduceMq && reduceMq.matches);
  if (reduceMq) {
    const onRM = (ev) => {
      reducedMotion = !!(ev && ev.matches);
      if (reducedMotion) { glide = null; shake = null; particles = []; } // title art goes still
      draw();
    };
    if (reduceMq.addEventListener) reduceMq.addEventListener('change', onRM);
    else if (reduceMq.addListener) reduceMq.addListener(onRM);
  }

  function hasArt(key) {
    const img = art[key];
    return !!(artReady[key] && img && img.width > 1 && img.height > 1);
  }

  function loadArt() {
    if (typeof Image !== 'function') return;
    for (const key of Object.keys(ASSETS)) {
      let img = null;
      try {
        img = new Image();
      } catch (err) {
        return; // no bitmap path here at all; the procedural river stays
      }
      const done = () => { art[key] = img; artReady[key] = true; patterns[key] = null; draw(); };
      const fail = () => { artReady[key] = false; draw(); };
      if (img.addEventListener) {
        img.addEventListener('load', done);
        img.addEventListener('error', fail);
      } else {
        img.onload = done;
        img.onerror = fail;
      }
      img.src = ASSETS[key];
    }
  }

  function patternFor(key) {
    if (patterns[key] !== null) return patterns[key];
    if (!hasArt(key) || typeof ctx.createPattern !== 'function') return null;
    try {
      patterns[key] = ctx.createPattern(art[key], 'repeat');
    } catch (err) {
      patterns[key] = false; // asked once, never again
    }
    return patterns[key] || null;
  }

  function effectsLive() {
    return !!(glide || shake || flare || mark || particles.length);
  }

  // The only place time enters the renderer. `s` is always SIM_STEP, so a glide that takes
  // 0.34s takes 41 steps whether the tab paints at 30 or at 120 fps.
  function stepEffects(s) {
    if (glide) {
      glide.t += s;
      if (glide.t >= glide.dur) glide = null;
    }
    if (shake) {
      shake.t += s;
      if (shake.t >= shake.dur) shake = null;
    }
    if (flare) {
      flare.t += s;
      if (flare.t >= flare.dur) flare = null;
    }
    if (mark) {
      mark.t += s;
      if (mark.t >= mark.dur) mark = null;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.t += s;
      if (q.t >= q.dur) {
        particles.splice(i, 1);
        continue;
      }
      // dt-integrated drift and damping: `*= 0.96` per frame would drain twice as fast at 120Hz.
      q.x += q.vx * s;
      q.y += q.vy * s;
      const damp = Math.pow(0.24, s);
      q.vx *= damp;
      q.vy *= damp;
    }
  }

  function spawnWake(bb, dir) {
    if (reducedMotion) return; // no particles at all under a reduce-motion request
    const n = 12;
    for (let i = 0; i < n; i++) {
      const spread = fxRnd();
      particles.push({
        x: bb.x + (dir < 0 ? bb.w : 0),
        y: bb.y + bb.h * (0.34 + 0.5 * spread),
        vx: dir * (16 + 26 * fxRnd()),
        vy: (fxRnd() - 0.5) * 14,
        t: 0,
        dur: 0.45 + 0.55 * fxRnd(),
        r: bb.h * (0.06 + 0.10 * fxRnd()),
      });
      if (particles.length > PARTICLE_MAX) particles.shift();
    }
  }

  // --- geometry --------------------------------------------------------------------

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(200, Math.round(box.width));
    const H = Math.max(200, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    screen = { W, H };
    draw();
  }

  // A role's grid cell is its id, on either bank, so nobody shuffles when the boat goes: the
  // eye can follow one 羊 across six crossings, which is the entire difficulty of this puzzle.
  function layout() {
    const comp = game.comp;
    const { W, H } = screen;
    const bankW = clamp(60, (W - PAD * 2) * 0.26, 142);
    const waterX0 = Math.round(PAD + bankW);
    const waterX1 = Math.round(W - PAD - bankW);
    const waterW = Math.max(48, waterX1 - waterX0);
    const cols = comp.n > 4 && bankW > 86 ? 2 : 1;
    const rows = Math.ceil(Math.max(comp.n, 2) / cols);
    const pitch = clamp(19, 46, Math.min((bankW - 12) / cols, (H - PAD * 2 - 34) / rows));
    // A seat is the width of a role, never a share of the river. Sizing the hull as
    // `capacity * (waterW / capacity)` makes it span the channel, which collapses
    // `dock[1] - dock[0]` to a couple of pixels: the crossing glide draws nothing, and the second
    // crossing gesture — haul the boat across — becomes arithmetically indistinguishable from a
    // click, so a haul that stops short counts as a landing. The two caps below keep the channel
    // wider than the boat by at least the distance between the docks.
    const seat = Math.floor(Math.max(pitch * 0.8, Math.min((waterW - 30) / comp.capacity, pitch * 1.4)));
    const boatW = Math.min(waterW - 6, Math.round(waterW * 0.6), comp.capacity * seat + 22);
    const boatH = Math.max(36, Math.round(pitch * 2));
    const boatY = Math.round(H / 2 - boatH / 2);
    const dock = [Math.round(waterX0 + 3), Math.round(waterX1 - boatW - 3)];
    // Both role columns stand on sand, mirroring `bankRect` below. Centring the far column on the
    // channel (the obvious reading of "the other half of the river") paints the far bank's
    // castaways in the shipping lane, directly under the hull, and puts a pressable role circle on
    // the one spot a caller would otherwise trust to be open water.
    const bankBox = [
      { x: PAD, y: PAD, w: bankW, h: H - PAD * 2 },
      { x: waterX1, y: PAD, w: Math.max(24, W - waterX1 - PAD), h: H - PAD * 2 },
    ];
    const home = [];
    for (let i = 0; i < comp.n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const side = bankBox[0];
      const cx = side.x + side.w / 2 - (cols * pitch) / 2 + c * pitch + pitch / 2;
      const mirror = bankBox[1];
      const rx = mirror.x + mirror.w / 2 - (cols * pitch) / 2 + c * pitch + pitch / 2;
      const y = PAD + 26 + r * pitch + pitch / 2;
      home.push([{ x: Math.round(cx), y: Math.round(y) }, { x: Math.round(rx), y: Math.round(y) }]);
    }
    return {
      comp, pitch, cols, bankW, waterX0, waterX1, waterW, boatW, boatH, boatY, dock, home,
      bankRect: [
        { x: 0, y: 0, w: waterX0, h: H },
        { x: waterX1, y: 0, w: W - waterX1, h: H },
      ],
    };
  }

  // Where the boat hull sits right now, in canvas px — the glide interpolates between docks.
  function boatBox() {
    const g = geo;
    const here = game.bank;
    let x = g.dock[here];
    if (glide) {
      const t = clamp(0, 1, glide.t / glide.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      x = Math.round(glide.from + (glide.to - glide.from) * e);
    }
    if (haul) x += Math.round(haul.dx);
    return { x, y: g.boatY, w: g.boatW, h: g.boatH };
  }

  function seatBox(bb) {
    // The whole boat plus the crew standing above the deck line: one rect for hit testing.
    return { x: bb.x, y: bb.y, w: bb.w, h: bb.h };
  }

  function roleAt(id) {
    const g = geo;
    const seatR = (bb) => Math.max(8, Math.min(g.pitch * 0.42, ((bb.w - 22) / Math.max(1, g.comp.capacity)) * 0.46));
    if (glide && glide.cargo.indexOf(id) >= 0) {
      // Still riding: pinned to the boat until the cosmetic glide ends.
      const bb = boatBox();
      const k = glide.cargo.indexOf(id);
      const slot = (bb.w - 22) / Math.max(1, g.comp.capacity);
      return {
        x: Math.round(bb.x + 11 + slot * (k + 0.5)),
        y: Math.round(bb.y + g.boatH * 0.3),
        r: seatR(bb),
        riding: true,
      };
    }
    if (game.boat.indexOf(id) >= 0) {
      const bb = boatBox();
      const k = game.boat.indexOf(id);
      const slot = (bb.w - 22) / Math.max(1, g.comp.capacity);
      return {
        x: Math.round(bb.x + 11 + slot * (k + 0.5)),
        y: Math.round(bb.y + g.boatH * 0.3),
        r: seatR(bb),
        aboard: true,
      };
    }
    const b = (game.mask & (1 << id)) ? 0 : 1;
    return { x: g.home[id][b].x, y: g.home[id][b].y, bank: b };
  }

  // --- the water, the banks, the boat ----------------------------------------------

  function drawWater() {
    const g = geo;
    const { H } = screen;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, WATER_TOP);
    grad.addColorStop(1, WATER_BOT);
    ctx.fillStyle = grad;
    ctx.fillRect(g.waterX0, 0, g.waterW, H);

    // Shallows against both shorelines.
    ctx.fillStyle = SHORE;
    ctx.fillRect(g.waterX0, 0, Math.max(2, g.pitch * 0.14), H);
    ctx.fillRect(g.waterX1 - Math.max(2, g.pitch * 0.14), 0, Math.max(2, g.pitch * 0.14), H);

    // The generated water bitmap lies under the crests; it is a still texture, so it costs nothing
    // and it is what makes the river read as painted water rather than as a CSS gradient.
    const wp = patternFor('water');
    if (wp) {
      ctx.save();
      ctx.globalAlpha = reducedMotion ? 0.20 : 0.30;
      ctx.fillStyle = wp;
      ctx.fillRect(g.waterX0, 0, g.waterW, H);
      ctx.restore();
    }
    // Ripples: the same deterministic sine on every device, so a screenshot is reproducible.
    // The phase comes from `animClock` (seconds of simulation), never from a wall-clock `now`,
    // and reduce-motion freezes it at zero instead of removing the water.
    ctx.strokeStyle = RIPPLE;
    ctx.lineWidth = 1.5;
    const lanes = Math.max(4, Math.floor(H / (g.pitch * 1.1)));
    const drift = reducedMotion ? 0 : animClock * RIPPLE_HZ;
    for (let k = 0; k < lanes; k++) {
      const y = Math.round(((k + 0.5) * H) / lanes);
      const phase = (drift + k * 0.37) % 1;
      ctx.beginPath();
      for (let x = g.waterX0 + 4; x <= g.waterX1 - 4; x += 6) {
        const yy = y + Math.sin((x / (28 + k * 3)) + phase * Math.PI * 2) * (g.pitch * 0.07);
        if (x === g.waterX0 + 4) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  function drawBank(bank) {
    const g = geo;
    const r = g.bankRect[bank];
    const inner = bank === 0 ? { x: r.x, y: PAD, w: r.w, h: screen.H - PAD * 2 }
      : { x: g.waterX1, y: PAD, w: screen.W - g.waterX1 - PAD, h: screen.H - PAD * 2 };
    ctx.fillStyle = SAND;
    roundRect(ctx, inner.x, inner.y, inner.w, inner.h, 12);
    ctx.fill();
    const sp = patternFor('sand');
    if (sp) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = sp;
      roundRect(ctx, inner.x, inner.y, inner.w, inner.h, 12);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = SAND_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Reeds along the waterline, and a mooring post: all procedural, no image assets anywhere.
    ctx.strokeStyle = REED;
    ctx.lineWidth = 1.5;
    const edge = bank === 0 ? inner.x + inner.w : inner.x;
    for (let k = 0; k < 5; k++) {
      const y = inner.y + 18 + k * ((inner.h - 30) / 4);
      ctx.beginPath();
      ctx.moveTo(edge - (bank === 0 ? 8 : -8), y);
      ctx.lineTo(edge - (bank === 0 ? 16 : -16), y - 9);
      ctx.stroke();
    }
    ctx.fillStyle = POST;
    roundRect(ctx, bank === 0 ? g.waterX0 - 9 : g.waterX1 + 2, g.boatY + g.boatH * 0.55, 7, Math.max(16, g.pitch * 0.6), 3);
    ctx.fill();

    // The rope only holds when the boat is actually tied up at this bank.
    ctx.save();
    ctx.globalAlpha = game.bank === bank ? 0.5 : 0.16;
    ctx.strokeStyle = 'rgba(214, 226, 236, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bank === 0 ? g.waterX0 - 5 : g.waterX1 + 2, g.boatY + g.boatH * 0.6);
    ctx.lineTo(g.dock[bank] + (bank === 0 ? 4 : g.boatW - 4), g.boatY + g.boatH * 0.42);
    ctx.stroke();
    ctx.restore();

    // Bank name, so "which shore" is never a guess.
    ctx.fillStyle = DIM;
    ctx.font = `600 ${Math.max(9, Math.round(g.pitch * 0.28))}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bank === 0 ? '此岸' : '彼岸', inner.x + inner.w / 2, inner.y + 12);

    // The painter's seal sits on the far bank: one small bitmap, and it is the same 朱印 that is
    // stamped into the app icon.
    if (bank === 1 && hasArt('seal')) {
      const side = Math.max(18, Math.min(g.pitch * 1.5, inner.w * 0.6));
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.drawImage(art.seal, inner.x + inner.w - side - 4, inner.y + inner.h - side - 4, side, side);
      ctx.restore();
    }
  }

  function drawBoat(bb) {
    const g = geo;
    const deck = bb.y + g.boatH * 0.52;
    ctx.save();
    if (shake && shake.boat) {
      const k = 1 - shake.t / shake.dur;
      ctx.translate(Math.sin(animClock * 42) * 5 * k, 0);
    }
    if (glide && !reducedMotion) {
      // Wake behind the hull while it travels.
      ctx.strokeStyle = 'rgba(190, 224, 248, 0.22)';
      ctx.lineWidth = 2;
      const dir = glide.to > glide.from ? -1 : 1;
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath();
        ctx.moveTo(bb.x + (dir < 0 ? bb.w : 0), bb.y + bb.h * (0.4 + k * 0.16));
        ctx.lineTo(bb.x + (dir < 0 ? bb.w + k * 12 : -k * 12), bb.y + bb.h * (0.34 + k * 0.2));
        ctx.stroke();
      }
    }
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = HULL;
    hullPath(ctx, bb.x, bb.y, bb.w, bb.h, deck);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // Deck plank + gunwale.
    ctx.fillStyle = DECK;
    ctx.fillRect(bb.x + 2, deck - 4, bb.w - 4, 5);
    ctx.strokeStyle = HULL_DARK;
    ctx.lineWidth = 1.5;
    hullPath(ctx, bb.x, bb.y, bb.w, bb.h, deck);
    ctx.stroke();
    // Slot marks, so capacity is legible without printing a number next to every seat.
    const slot = (bb.w - 22) / Math.max(1, g.comp.capacity);
    ctx.strokeStyle = 'rgba(255, 244, 226, 0.22)';
    for (let k = 1; k < g.comp.capacity; k++) {
      ctx.beginPath();
      ctx.moveTo(bb.x + 11 + slot * k, deck - 2);
      ctx.lineTo(bb.x + 11 + slot * k, bb.y + bb.h - 6);
      ctx.stroke();
    }
    // A lantern at the bow tells which way the boat points. The generated glow sprite is the
    // halo; the disc on top of it stays procedural so it never blurs out at small sizes.
    const bow = game.bank === 1 ? bb.x + bb.w - 6 : bb.x + 6;
    const lr = Math.max(2.5, g.pitch * 0.09);
    if (hasArt('glow')) {
      const halo = lr * (reducedMotion ? 5 : 6.4);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(art.glow, bow - halo / 2, deck - 9 - halo / 2, halo, halo);
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(224, 166, 60, 0.8)';
    ctx.beginPath();
    ctx.arc(bow, deck - 9, lr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The wake, drawn over the water but under the crew: soft amber-white specks that drift off
  // the stern. Positions were integrated in stepEffects(), so this loop only reads state.
  function drawParticles() {
    if (!particles.length) return;
    ctx.save();
    for (const q of particles) {
      const k = 1 - q.t / q.dur;
      const r = q.r * (0.6 + 0.8 * (1 - k));
      if (hasArt('glow')) {
        ctx.globalAlpha = 0.34 * k;
        ctx.drawImage(art.glow, q.x - r, q.y - r, r * 2, r * 2);
      } else {
        ctx.globalAlpha = 0.26 * k;
        ctx.fillStyle = 'rgba(190, 224, 248, 0.9)';
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawRole(id, pos) {
    const g = geo;
    const comp = g.comp;
    const r = Math.max(8, Math.min(g.pitch * 0.42, pos.r || g.pitch * 0.42));
    const kind = comp.kind[id] || 'human';
    let x = pos.x;
    let y = pos.y;
    let alpha = 1;
    if (carry && carry.id === id) return; // drawn last, under the finger
    if (shake && shake.ids.indexOf(id) >= 0) {
      x += Math.sin(animClock * 46) * 4 * (1 - shake.t / shake.dur);
    }
    if (pos.bank !== undefined && pos.bank !== game.bank) alpha = 0.45; // out of reach, same rule
    if (glide && glide.cargo.indexOf(id) >= 0) alpha = 1;
    if (mark && mark.cargo.indexOf(id) >= 0) {
      const t = reducedMotion ? 0.5 : (animClock % 0.9) / 0.9;
      ctx.strokeStyle = `rgba(120, 220, 255, ${(0.9 - t * 0.5).toFixed(3)})`;
      ctx.lineWidth = 2 + t * 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 4 + t * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    const cell = TOKEN_ORDER.indexOf(kind);
    if (cell >= 0 && hasArt('tokens')) {
      // The generated sheet is the same token the app icon is built from; the letter below is
      // still painted on top, so legibility never depends on a bitmap having arrived.
      ctx.drawImage(art.tokens, cell * TOKEN_CELL, 0, TOKEN_CELL, TOKEN_CELL, x - r, y - r, r * 2, r * 2);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = INK;
      ctx.font = `700 ${Math.max(9, Math.round(r * 1.05))}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(comp.short[id], x, y + r * 0.28);
      ctx.restore();
      if (flare && flare.roles.indexOf(id) >= 0) {
        ctx.strokeStyle = DANGER;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    ctx.fillStyle = SKIN[kind] || SKIN.human;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(12, 16, 22, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Fallback kind marks, all procedural: ears for beasts, a crate corner for goods, an oar for
    // the boatman (the only one who may cast off under the 'ferry' law), a hood for humans.
    ctx.strokeStyle = 'rgba(12, 16, 22, 0.6)';
    if (kind === 'beast') {
      ctx.fillStyle = ctx.strokeStyle;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + s * r * 0.5, y - r * 0.75);
        ctx.lineTo(x + s * r * 0.85, y - r * 1.35);
        ctx.lineTo(x + s * r * 0.15, y - r * 0.95);
        ctx.closePath();
        ctx.fill();
      }
    } else if (kind === 'goods') {
      ctx.strokeRect(x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9);
    } else if (kind === 'ferryman') {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - r * 1.2, y + r * 0.9);
      ctx.lineTo(x + r * 1.2, y - r * 0.9);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y - r * 0.15, r * 0.62, Math.PI, 0);
      ctx.stroke();
    }
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.max(9, Math.round(r * 1.05))}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(comp.short[id], x, y + r * 0.28);
    ctx.restore();

    if (flare && flare.roles.indexOf(id) >= 0) {
      ctx.strokeStyle = DANGER;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawCarry() {
    if (!carry) return;
    const g = geo;
    const over = geo && boatBox();
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = SKIN[g.comp.kind[carry.id] || 'human'];
    ctx.beginPath();
    ctx.arc(carry.x, carry.y, g.pitch * 0.46, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (over && within(carry.x, carry.y, seatBox(over))) {
      ctx.strokeStyle = GLOW;
      ctx.lineWidth = 2;
      const bb = over;
      roundRect(ctx, bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8, 10);
      ctx.stroke();
    }
  }

  function drawFlareText() {
    if (!flare) return;
    const g = geo;
    const text = flare.why;
    ctx.save();
    ctx.globalAlpha = clamp(0, 1, 1 - flare.t / flare.dur);
    ctx.fillStyle = DANGER;
    ctx.font = `700 ${Math.max(10, Math.round(g.pitch * 0.32))}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = flare.bank === 0 ? g.bankRect[0].x + g.bankRect[0].w / 2
      : flare.bank === 1 ? g.bankRect[1].x + g.bankRect[1].w / 2 : screen.W / 2;
    ctx.fillText(text, cx, screen.H - PAD - 6);
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, screen.W, screen.H);
    if (!game) return;
    geo = layout();
    const bb = boatBox();
    drawWater();
    drawBank(0);
    drawBank(1);
    drawParticles();
    drawBoat(bb);
    const st = standing(game);
    for (const id of st.boat) drawRole(id, roleAt(id));
    // `st.left`/`st.right` already follow the committed mask, so a crew that is mid-glide is
    // drawn from roleAt(), which pins them to the travelling hull.
    for (const id of st.left) if (st.boat.indexOf(id) < 0) drawRole(id, roleAt(id));
    for (const id of st.right) if (st.boat.indexOf(id) < 0) drawRole(id, roleAt(id));
    drawCarry();
    drawFlareText();
    // Empty-seat count while loading: the panel prints the numbers, the canvas only shows room.
    if (game.boat.length && !glide) {
      ctx.fillStyle = DIM;
      ctx.font = `600 ${Math.max(9, Math.round(geo.pitch * 0.3))}px "PingFang SC", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${game.boat.length}/${game.comp.capacity}`, bb.x + bb.w / 2, bb.y + bb.h + 12);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // Paused: the accumulator is not fed at all, so no effect ages and nothing is repainted.
    // `lastTs` still follows the clock, otherwise resuming would book the whole pause as one
    // enormous frame and the hull would jump.
    if (paused) {
      lastTs = now;
      return;
    }
    const dt = lastTs ? clamp(0, MAX_DT, (now - lastTs) / 1000) : 0;
    lastTs = now;
    const moving = !!(carry || haul);
    if (dt > 0) {
      frames += 1;
      animClock += dt; // cosmetic clock: still eats the frame dt, which is what it is for
      simAccumulator += dt;
      while (simAccumulator >= SIM_STEP) {
        simAccumulator -= SIM_STEP;
        simTime += SIM_STEP;
        simSteps += 1;
        stepEffects(SIM_STEP);
      }
    }
    // Redraw when something is actually moving; an idle river costs nothing. The `effectsLive()`
    // half of the test is the frame that *ends* an animation: without it the river freezes on the
    // last glide frame, which still pins the landed crew to the hull and paints the hint ring
    // after the hint expired — a picture that contradicts the panel next to it.
    if (moving || effectsLive()) draw();
  }

  // --- gestures -------------------------------------------------------------------

  function local(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function hitRole(p) {
    if (!game || !geo) return null;
    const st = standing(game);
    const ids = st.boat.concat(st.left, st.right);
    let best = null;
    let bestD = Infinity;
    const reach = hitReach();
    for (const id of new Set(ids)) {
      const pos = roleAt(id);
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < reach && d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  function hitBoat(p) {
    if (!game || !geo) return false;
    return within(p.x, p.y, seatBox(boatBox()));
  }

  // How far from a role's centre a press still counts as that role. On a coarse pointer the floor
  // is 22px, i.e. a 44px disc — the same touch minimum the DOM buttons obey — because a drawn
  // circle of 8px is not a thing a thumb can hit. Published through `reach()` below so the harness
  // can prove the point it calls "open water" clears it, instead of guessing at this expression.
  function hitReach() {
    const floor = coarsePointer() ? 22 : 14;
    return geo ? Math.max(floor, geo.pitch * 0.5) : floor;
  }

  function coarsePointer() {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      try {
        const mq = window.matchMedia('(pointer: coarse)');
        if (mq && typeof mq.matches === 'boolean') return mq.matches;
      } catch (err) { /* fall through to the touch-point test */ }
    }
    return !!(window.navigator && window.navigator.maxTouchPoints > 0);
  }

  function capture(ev) {
    if (!canvas.setPointerCapture) return;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* a browser that refuses capture still drags fine inside the canvas */
    }
  }

  function busy() {
    return !!(glide && glide.t < glide.dur);
  }

  function down(ev) {
    if (!game || game.done || paused || busy()) return;
    const p = local(ev);
    const bb = boatBox();
    const deck = bb.y + geo.boatH * 0.5;
    // Below the deck line it is hull and always means "cast off"; a crew circle is never that
    // far from the belly, so the two gestures cannot be confused by a few pixels of finger.
    if (within(p.x, p.y, seatBox(bb)) && p.y >= deck) {
      haul = { x0: p.x, dx: 0, moved: 0 };
      capture(ev);
      draw();
      ev.preventDefault();
      return;
    }
    const id = hitRole(p);
    if (id !== null) {
      carry = { id, x: p.x, y: p.y, moved: 0, aboard: game.boat.indexOf(id) >= 0 };
      capture(ev);
      draw();
      ev.preventDefault();
      return;
    }
    if (within(p.x, p.y, seatBox(bb))) {
      haul = { x0: p.x, dx: 0, moved: 0 };
      capture(ev);
      draw();
      ev.preventDefault();
    }
  }

  function move(ev) {
    if (!carry && !haul) return;
    const p = local(ev);
    if (carry) {
      carry.moved = Math.max(carry.moved, Math.hypot(p.x - carry.x, p.y - carry.y));
      carry.x = p.x;
      carry.y = p.y;
    } else {
      const travel = geo.dock[1 - game.bank] - geo.dock[game.bank];
      // Cosmetic clamp only: how far the hull may follow the finger. `depart` is decided by
      // direction and distance in up(), and counted (or not) by js/core either way.
      haul.dx = clamp(-Math.abs(travel) * 1.1, Math.abs(travel) * 1.1, p.x - haul.x0);
      haul.moved = Math.max(haul.moved, Math.abs(haul.dx));
    }
    ev.preventDefault();
  }

  // Every release ends in exactly one call into the rule layer, and only `onDepart` may count.
  function up(ev) {
    const p = ev ? local(ev) : null;
    if (carry) {
      const id = carry.id;
      const wasAboard = carry.aboard;
      const moved = carry.moved;
      const over = p && hitBoat(p);
      const onBank = p && geo && within(p.x, p.y, geo.bankRect[game.bank]);
      carry = null;
      if (ev) ev.preventDefault();
      if (over && !wasAboard) onBoard(id);
      else if (wasAboard && (onBank || !moved)) onUnboard(id);
      else if (!wasAboard && !moved) onBoard(id);
      draw();
      return;
    }
    if (haul) {
      const g = geo;
      const travel = g.dock[1 - game.bank] - g.dock[game.bank];
      // A haul commits only where the spec says it does: it has to be *to the far bank*. Half way
      // is a haul abandoned, the hull snaps back to its dock and nobody is cast off.
      const far = Math.abs(haul.dx) > Math.abs(travel) * 0.45
        && Math.sign(haul.dx) === Math.sign(travel);
      const clicked = haul.moved <= TAP_SLOP;
      haul = null;
      if (ev) ev.preventDefault();
      if (far || clicked) onDepart();
      else draw();
    }
  }

  loadArt();

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => {
    carry = null;
    haul = null;
    draw();
  });

  function toClient(x, y) {
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left + x), y: Math.round(box.top + y) };
  }

  return {
    attach(next) {
      game = next;
      carry = null;
      haul = null;
      glide = null;
      shake = null;
      flare = null;
      mark = null;
      particles = [];
      fxRnd = lcg(20261001);
      measure();
    },
    detach() {
      game = null;
    },
    measure,
    redraw: draw,
    busy,

    // A successful crossing: remember where it came from so the hull can travel and the crew can
    // ride it. `cargo` are the ids that actually moved.
    crossed(from, cargo) {
      if (!geo) return;
      // reduce-motion keeps the *fact* of the crossing (the state already moved) and drops the
      // travel: no glide, no wake, no ripple animation.
      if (reducedMotion) { draw(); return; }
      glide = {
        from: geo.dock[from], to: geo.dock[game.bank], cargo: (cargo || []).slice(),
        t: 0, dur: CROSS_S,
      };
      spawnWake(boatBox(), geo.dock[game.bank] > geo.dock[from] ? -1 : 1);
      draw();
    },

    // Core said no. Two flavours of feedback, both deliberately non-counting.
    reject({ ids, boat, conflict }) {
      if (!reducedMotion) shake = { ids: ids || [], boat: !!boat, t: 0, dur: SHAKE_S };
      if (conflict) {
        flare = { roles: conflict.roles || [], bank: conflict.bank, why: conflict.why, t: 0, dur: FLARE_S };
      }
      draw();
    },

    showHint(cargo) {
      mark = { cargo: (cargo || []).slice(), t: 0, dur: HINT_S };
      draw();
    },

    clearFlare() {
      flare = null;
      shake = null;
      draw();
    },

    // Everything time-based lives here, so "重开" can actually empty it: the counters, the wake,
    // the glide that is still carrying a crew, the hint ring. Numbers go back to zero, which is
    // what window.ferry.clock() is for.
    reset() {
      glide = null;
      shake = null;
      flare = null;
      mark = null;
      particles = [];
      carry = null;
      haul = null;
      animClock = 0;
      simAccumulator = 0;
      simTime = 0;
      simSteps = 0;
      frames = 0;
      lastTs = 0;
      fxRnd = lcg(20261001);
      draw();
    },

    setPaused(v) {
      paused = !!v;
      lastTs = 0; // the frame after a resume must not book the pause as one huge dt
      if (!paused) draw();
      return paused;
    },

    clock() {
      return {
        animClock,
        simTime,
        simSteps,
        simAccumulator,
        frames,
        paused,
        reducedMotion,
        particles: particles.length,
        glide: glide ? Math.round((glide.t / glide.dur) * 1000) / 1000 : 0,
        shake: shake ? Math.round((shake.t / shake.dur) * 1000) / 1000 : 0,
        mark: mark ? Math.round((mark.t / mark.dur) * 1000) / 1000 : 0,
        flare: flare ? Math.round((flare.t / flare.dur) * 1000) / 1000 : 0,
        simStep: SIM_STEP,
        art: Object.keys(ASSETS).filter(hasArt).join(','),
      };
    },

    reduceMotion() { return reducedMotion; },

    // ---- what an automated finger presses (see tools/playtest.mjs @pointer) ----
    // Client-space centre of a role wherever it stands — bank, boat, or riding a glide.
    rolePoint(id) {
      if (!game || !geo || id < 0 || id >= game.comp.n) return null;
      const pos = roleAt(id);
      const p = toClient(pos.x, pos.y);
      return {
        ...p,
        r: Math.round(pos.r || Math.max(10, geo.pitch * 0.42)),
        aboard: game.boat.indexOf(id) >= 0,
        riding: !!(glide && glide.cargo.indexOf(id) >= 0),
        bank: pos.bank === undefined ? game.bank : pos.bank,
      };
    },
    // Client-space point to press to cast off: the belly of the hull, which is below the deck
    // line and therefore never ambiguous with a crew circle. `cx/cy` is the geometric centre.
    boatPoint() {
      if (!game || !geo) return null;
      const bb = boatBox();
      const press = toClient(bb.x + bb.w / 2, bb.y + bb.h * 0.78);
      const centre = toClient(bb.x + bb.w / 2, bb.y + bb.h / 2);
      return {
        ...press,
        cx: centre.x,
        cy: centre.y,
        bank: game.bank,
        w: bb.w,
        h: bb.h,
        left: Math.round(canvas.getBoundingClientRect().left + bb.x),
      };
    },
    // Client-space centre of a boat resting at a given bank — used to prove the picture really
    // changed sides rather than only the counter.
    dockPoint(bank) {
      if (!game || !geo) return null;
      const b = bank === undefined ? game.bank : bank;
      const p = toClient(geo.dock[b] + geo.boatW / 2, geo.boatY + geo.boatH / 2);
      return { ...p, bank: b };
    },
    cast() {
      return game ? { left: standing(game).left.length, right: standing(game).right.length } : null;
    },
    size() {
      return game ? `${Math.round(geo ? geo.pitch : 0)}px` : '';
    },
    reach() {
      return Math.round(hitReach());
    },
    start() {
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
