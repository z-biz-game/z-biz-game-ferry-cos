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
const CROSS_MS = 340; // cosmetic only: the state has already moved when the glide starts
const SHAKE_MS = 340;
const HINT_MS = 2600;
const FLARE_MS = 2200;
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
  let glide = null; // { from, to, cargo, until }
  let shake = null; // { ids, boat, until }
  let flare = null; // { roles, bank, until, why }
  // 减弱动效闸门。shake 的位移是 x += Math.sin(now / 22) * 4 * (...)：一段纯装饰的来回摆动。
  // 减弱动效下**只去掉位移，不去掉 shake 本身**——shake 身上还挂着 ids，
  // 它是"刚才被拒的是哪几个子"这条信息唯一的载体，连它一起删掉，玩家就收不到任何反馈了。
  // 于是：形状/高亮照旧，位移恒为 0；信息留住，晃动没有。
  let reduceMotion = false;
  let mark = null; // { cargo, until } — the hint's "load these"
  let raf = 0;

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
      const t = clamp(0, 1, 1 - (glide.until - performance.now()) / CROSS_MS);
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

  // The cosmetic glide is over the instant `busy()` says so; the animation loop only comes along
  // on the next frame to drop the object. Reading the raw `glide` where a *position* is asked for
  // would keep publishing "this role is still riding the hull" for up to a frame after the counter
  // reported the landing, and a caller that waited on `busy` (the harness does exactly that) would
  // then press a point the next frame no longer owns. Positions use the live view of it.
  function glideNow() {
    return glide && performance.now() < glide.until ? glide : null;
  }

  function roleAt(id) {
    const g = geo;
    const seatR = (bb) => Math.max(8, Math.min(g.pitch * 0.42, ((bb.w - 22) / Math.max(1, g.comp.capacity)) * 0.46));
    const gl = glideNow();
    if (gl && gl.cargo.indexOf(id) >= 0) {
      // Still riding: pinned to the boat until the cosmetic glide ends.
      const bb = boatBox();
      const k = gl.cargo.indexOf(id);
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

  function drawWater(now) {
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

    // Ripples: the same deterministic sine on every device, so a screenshot is reproducible.
    ctx.strokeStyle = RIPPLE;
    ctx.lineWidth = 1.5;
    const lanes = Math.max(4, Math.floor(H / (g.pitch * 1.1)));
    for (let k = 0; k < lanes; k++) {
      const y = Math.round(((k + 0.5) * H) / lanes);
      const phase = (now / 1400 + k * 0.37) % 1;
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
  }

  function drawBoat(bb, now) {
    const g = geo;
    const deck = bb.y + g.boatH * 0.52;
    ctx.save();
    if (shake && shake.boat && now < shake.until && !reduceMotion) {
      const k = (shake.until - now) / SHAKE_MS;
      ctx.translate(Math.sin(now / 24) * 5 * k, 0);
    }
    if (glide) {
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
    // A lantern at the bow tells which way the boat points.
    const bow = game.bank === 1 ? bb.x + bb.w - 6 : bb.x + 6;
    ctx.fillStyle = 'rgba(224, 166, 60, 0.8)';
    ctx.beginPath();
    ctx.arc(bow, deck - 9, Math.max(2.5, g.pitch * 0.09), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawRole(id, pos, now) {
    const g = geo;
    const comp = g.comp;
    const r = Math.max(8, Math.min(g.pitch * 0.42, pos.r || g.pitch * 0.42));
    const kind = comp.kind[id] || 'human';
    let x = pos.x;
    let y = pos.y;
    let alpha = 1;
    if (carry && carry.id === id) return; // drawn last, under the finger
    if (shake && shake.ids.indexOf(id) >= 0 && now < shake.until && !reduceMotion) {
      x += Math.sin(now / 22) * 4 * ((shake.until - now) / SHAKE_MS);
    }
    if (pos.bank !== undefined && pos.bank !== game.bank) alpha = 0.45; // out of reach, same rule
    if (glide && glide.cargo.indexOf(id) >= 0) alpha = 1;
    if (mark && now < mark.until && mark.cargo.indexOf(id) >= 0) {
      const t = (now % 900) / 900;
      ctx.strokeStyle = `rgba(120, 220, 255, ${(0.9 - t * 0.5).toFixed(3)})`;
      ctx.lineWidth = 2 + t * 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 4 + t * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = SKIN[kind] || SKIN.human;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(12, 16, 22, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Kind marks, all procedural: ears for beasts, a crate corner for goods, an oar for the
    // boatman (the only one who may cast off under the 'ferry' law), a hood for humans.
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

    if (flare && now < flare.until && flare.roles.indexOf(id) >= 0) {
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

  function drawFlareText(now) {
    if (!flare || now >= flare.until) return;
    const g = geo;
    const text = flare.why;
    ctx.save();
    ctx.globalAlpha = clamp(0, 1, (flare.until - now) / 700);
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
    const now = performance.now();
    ctx.clearRect(0, 0, screen.W, screen.H);
    if (!game) return;
    geo = layout();
    const bb = boatBox();
    drawWater(now);
    drawBank(0);
    drawBank(1);
    drawBoat(bb, now);
    const st = standing(game);
    for (const id of st.boat) drawRole(id, roleAt(id), now);
    // `st.left`/`st.right` already follow the committed mask, so a crew that is mid-glide is
    // drawn from roleAt(), which pins them to the travelling hull.
    for (const id of st.left) if (st.boat.indexOf(id) < 0) drawRole(id, roleAt(id), now);
    for (const id of st.right) if (st.boat.indexOf(id) < 0) drawRole(id, roleAt(id), now);
    drawCarry();
    drawFlareText(now);
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
    const moving = !!(glide || shake || flare || mark || carry || haul);
    if (glide && now >= glide.until) glide = null;
    if (shake && now >= shake.until) shake = null;
    if (flare && now >= flare.until) flare = null;
    if (mark && now >= mark.until) mark = null;
    // Redraw when something is actually moving; an idle river costs nothing. The `moving` half of
    // the test is the frame that *ends* an animation: without it the river freezes on the last
    // glide frame, which still pins the landed crew to the hull and paints the hint ring after the
    // hint expired — a picture that contradicts the panel next to it.
    if (moving || glide || shake || flare || mark || carry || haul) draw();
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

  // How far from a role's centre a press still counts as that role. Wider than the drawn circle on
  // purpose — a finger is not a pixel — and published through `reach()` below so the harness can
  // prove the point it calls "open water" clears it, instead of guessing at this expression.
  function hitReach() {
    return geo ? Math.max(11, geo.pitch * 0.5) : 11;
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
    return !!(glide && performance.now() < glide.until);
  }

  function down(ev) {
    if (!game || game.done || busy()) return;
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
      measure();
    },
    detach() {
      game = null;
    },
    measure,
    redraw: draw,
    setReduceMotion(v) { reduceMotion = !!v; if (reduceMotion) draw(); return reduceMotion; },
    isReducedMotion: () => reduceMotion,
    busy,

    // A successful crossing: remember where it came from so the hull can travel and the crew can
    // ride it. `cargo` are the ids that actually moved.
    crossed(from, cargo) {
      if (!geo) return;
      glide = {
        from: geo.dock[from], to: geo.dock[game.bank], cargo: (cargo || []).slice(),
        until: performance.now() + CROSS_MS,
      };
      draw();
    },

    // Core said no. Two flavours of feedback, both deliberately non-counting.
    reject({ ids, boat, conflict }) {
      shake = { ids: ids || [], boat: !!boat, until: performance.now() + SHAKE_MS };
      if (conflict) {
        flare = {
          roles: conflict.roles || [], bank: conflict.bank, why: conflict.why,
          until: performance.now() + FLARE_MS,
        };
      }
      draw();
    },

    showHint(cargo) {
      mark = { cargo: (cargo || []).slice(), until: performance.now() + HINT_MS };
      draw();
    },

    clearFlare() {
      flare = null;
      shake = null;
      draw();
    },

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
        riding: pos.riding === true, // roleAt() already resolved the glide against the clock
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
