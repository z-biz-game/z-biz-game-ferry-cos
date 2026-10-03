// The shell: hash routes in, canvas out, records in between. Nothing here knows why a crossing is
// illegal — that is js/core — and nothing here draws — that is js/view.js. What lives here is
// wiring: which lot the URL asks for, which words the panel prints, which door a gesture goes
// through. There is exactly one door per act (boardRole / unboardRole / departNow) and the view,
// the buttons, the keyboard and the browser harness all use it, so "a real finger" and "a node
// test" cannot drift apart.

import {
  createGame, board, unboard, depart, undo, reset, standing, hint, grade,
} from './core/game.js';
import { solve } from './core/solve.js';
import { store } from './core/storage.js';
import {
  TIERS, ALL, LAWS, lawOf, byId, levelAt, lotsIn, randomLot, dailyLot, tierByKey, stats as poolStats,
} from './core/library.js';
import { hashSeed, todayKey } from './core/rng.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  legend: $('legend'), shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'),
  stars: $('stars'), verdict: $('verdict'), tally: $('tally'), undo: $('undo'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'), toast: $('toast'),
  canvas: $('lot'), wipe: $('wipe'),
};

const LEVELS = ALL.length;
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  label: '',
  day: null,
  seedNote: '',
};

function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

// #/c/12 · #/daily · #/random/rapids/4kq2 · #/lot/ford-05
// The lot id is in the URL, so a shared crossing resolves to the same river elsewhere without
// anyone needing anyone else's save file.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function linkFor(rt) {
  if (!rt) return '#/c/1';
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    const lot = dailyLot(day);
    const idx = ALL.indexOf(lot);
    // Printed rather than implied: the daily crossing is `hashSeed('daily|YYYY-MM-DD') % 24`,
    // so any device can check the arithmetic behind the level it is being shown.
    const seed = hashSeed(`daily|${day}`);
    return {
      lot,
      label: `每日迷津 · ${day}`,
      note: day,
      day,
      seedNote: `hashSeed("daily|${day}") = ${seed} · ${seed} % ${LEVELS} = ${idx}`,
    };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    const key = `${tier.key}|${rt.key}`;
    const seed = hashSeed(`random|${key}`);
    const list = lotsIn(tier.key);
    const lot = randomLot(key, tier.key);
    return {
      lot,
      label: `随渡 · ${tier.label}`,
      note: tier.blurb,
      seedNote: `hashSeed("random|${key}") = ${seed} · ${seed} % ${list.length} = ${list.indexOf(lot)}`,
    };
  }
  if (rt.mode === 'lot') {
    const lot = byId(rt.id) || ALL[0];
    return { lot, label: `关卡 ${lot.id}`, note: tierByKey(lot.tier).blurb };
  }
  const lot = levelAt(rt.index - 1);
  return { lot, label: `第 ${rt.index} 渡`, note: `共 ${LEVELS} 渡 · ${tierByKey(lot.tier).label}` };
}

const view = createView(el.canvas, {
  onBoard: (id) => boardRole(id),
  onUnboard: (id) => unboardRole(id),
  onDepart: () => departNow(),
});

const name = (id) => (app.lot && app.lot.comp.name[id]) || `角色 ${id}`;
const bankName = (b) => (b === 0 ? '此岸' : '彼岸');
// One sentence per refusal, in the model's own words. The view shakes, the panel explains, and
// both of them read the same `why` that js/core returned — no copy is written here.
function faultText(f) {
  const comp = app.lot ? app.lot.comp : null;
  const law = comp ? lawOf(comp.rule) : null;
  switch (f.why) {
    case 'over':
      return `超载：${law.name}只有 ${comp.capacity} 个位子，${name(f.id)} 挤不上去`;
    case 'far':
      return `${name(f.id)} 在${bankName(1 - app.game.bank)}，这一趟够不着船`;
    case 'aboard':
      return `${name(f.id)} 已经在船上了`;
    case 'none':
      return '船上没有这个位置';
    case 'done':
      return '这一渡已经靠岸了';
    case 'ferry':
      return `${law.name}口径：艄公必须在船上才能开 —— 光装乘客没用`;
    case 'empty':
      return `${law.name}口径：空船不许开，至少要 1 人上船（这正是它和艄公船的分岔）`;
    case 'already':
      return `${bankName(f.conflict.bank)}已经出事了：${f.conflict.why}`;
    case 'conflict':
      return `这一步被拒绝：${f.conflict.why} —— 船${f.where === 'departure' ? '离开' : '到达'}的${bankName(f.conflict.bank)}无人监管`;
    default:
      return '这一步不合规矩';
  }
}

function say(html) {
  el.hintline.innerHTML = html;
}

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function solvedCount() {
  return Object.values(store.records).filter((r) => r.solved).length;
}

function riskText(lot) {
  if (lot.risk === 'pair') {
    return lot.spec.risk.pairs.map((p) => `${lot.comp.name[p[0]]}↔${lot.comp.name[p[1]]}`).join('、');
  }
  return `${lot.spec.risk.strong} 多过 ${lot.spec.risk.weak}`;
}

function renderCrumbs() {
  const lot = app.lot;
  const tier = tierByKey(lot.tier);
  const law = lawOf(lot.law);
  const g = app.game;
  el.crumbs.innerHTML = `${app.label}<b>${tier.label} · ${lot.title}<span class="band"> ${tier.blurb}</span></b>`
    + `<code class="route">${linkFor(app.route)}</code>`;
  const rec = store.record(lot.id);
  el.readout.innerHTML = [
    field('单程', g.moves, `已用 · 一次靠岸计 1`, 'trips'),
    field('最少', lot.par, 'BFS 量出', 'par'),
    field('最优路线', lot.routes, `条 · ${lot.states} 个可通行局面`),
    field('第几渡', `${app.index}/${LEVELS}`, `${tier.label} · ${lot.law === 'ferry' ? '艄公船' : '自由船'}`),
    field('船的法', law.name, law.rule, 'law'),
    field('乘客', `${lot.comp.n} 人 · 船 ${lot.capacity} 位`, riskText(lot)),
    field('已在船', `${g.boat.length}/${lot.capacity}`, g.boat.length ? g.boat.map(name).join('、') : '未装船'),
    field('最佳', rec && rec.best ? rec.best : '—', rec && rec.perfect ? '等于最少' : '你的纪录', 'best'),
  ].join('');
  el.legend.innerHTML = (() => {
    const comp = lot.comp;
    const aboard = standing(g).boat;
    const chips = [];
    for (let i = 0; i < comp.n; i++) {
      const on = aboard.indexOf(i) >= 0 ? ' aboard' : '';
      chips.push(`<span class="chip k-${comp.kind[i]}${on}">${comp.short[i]} ${comp.name[i]}</span>`);
    }
    return chips.join('');
  })();
  el.undo.disabled = !g.moves || g.done;
  el.hint.disabled = g.done;
  el.share.title = `复制 ${linkFor(app.route)}`;
}

function renderTotals() {
  const s = store.stats;
  el.totals.innerHTML = `已渡 <b>${solvedCount()}</b>/${LEVELS}`
    + ` · 分毫不差 <b>${s.perfect}</b>`
    + ` · 单程累计 <b>${s.crossings}</b>`
    + ` · 提示 <b>${s.hints}</b>`;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of TIERS) {
      html += `<p class="tier">${tier.label} ${tier.min}-${tier.max} 单程 · ${tier.blurb}</p>`;
      for (const lot of lotsIn(tier.key)) {
        const n = ALL.indexOf(lot) + 1;
        const rec = store.record(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.perfect ? 'perfect' : rec && rec.solved ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" title="${lot.id} · ${lot.law} · par ${lot.par}" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = `<p class="tier">选一段水面 · ${app.seedNote}</p>`;
    for (const tier of TIERS) {
      const on = tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.min}-${tier.max} 单程</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一段水面</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">每日一渡 · 所有设备同一个局面</p><p class="seed">${app.seedNote}</p>`
      + `<p class="tier">${done ? '今天已渡' : '今天还没渡'}</p>`
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 渡</button>`;
  } else {
    el.shelf.innerHTML = `<p class="tier">分享的这一渡</p><p class="seed">${app.seedNote || `#/lot/${app.lot.id}`}</p>`;
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function token() {
  return Math.random().toString(36).slice(2, 8);
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderTotals();
  renderShelf();
}

// --- the three doors ---------------------------------------------------------------

function boardRole(id) {
  const r = board(app.game, id);
  if (!r.ok) {
    view.reject({ ids: [id], boat: false });
    say(faultText(r));
  } else {
    view.clearFlare();
    const law = lawOf(app.lot.law);
    const need = app.game.comp.rule === 'ferry' && !standing(app.game).boat.includes(app.game.comp.ferryman)
      ? ` · 还差艄公` : '';
    say(`装上 ${name(id)} · 船上 ${app.game.boat.length}/${app.lot.capacity}${need} —— 装船不计单程`);
  }
  renderCrumbs();
  return r;
}

function unboardRole(id) {
  const ok = unboard(app.game, id);
  say(ok ? `${name(id)} 下船 · 仍然不计单程` : `${name(id)} 不在船上`);
  renderCrumbs();
  return ok;
}

// The only place a trip is ever counted: `depart` in js/core/game.js increments once per crossing,
// and every refusal leaves `moves` where it was.
function departNow() {
  const g = app.game;
  if (!g) return { ok: false, why: 'none' };
  const from = g.bank;
  const loaded = g.boat.slice();
  const r = depart(g);
  if (!r.ok) {
    view.reject({ ids: (r.conflict && r.conflict.roles) || loaded, boat: true, conflict: r.conflict || null });
    say(faultText(r));
    renderCrumbs();
    return r;
  }
  view.crossed(from, r.cargo);
  renderCrumbs();
  if (g.done) finish();
  else {
    const left = app.lot.par - g.moves;
    say(`${r.cargo.map(name).join('、') || '空船'} 渡了过去 · 已用 <b>${g.moves}</b> 单程`
      + ` · 认证最少 ${app.lot.par}（还${left >= 0 ? '剩' : '超'} ${Math.abs(left)}）`);
  }
  return { ...r, from };
}

function finish() {
  const lot = app.lot;
  const g = app.game;
  const rec = store.solve(lot.id, { moves: g.moves, par: lot.par, hints: app.hints });
  if (app.day) store.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    store.unlock(Math.max(store.unlocked, app.index + 1));
    nextIndex = app.index < LEVELS ? app.index + 1 : 0;
  }
  const gr = grade(g);
  el.stars.textContent = stars(gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = `你的 <b>${g.moves}</b> 单程 · 搜索最少 <b>${lot.par}</b>`
    + ` · 最优路线 <b>${lot.routes}</b> 条 · 提示 <b>${app.hints}</b>`
    + `<br>${lawOf(lot.law).name}口径 · ${lawOf(lot.law).note}`
    + (rec.best === g.moves ? '<br>这是这一渡的最好成绩' : '');
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  render();
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/rapids would mean a different lot on every visit and an unreproducible
    // link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一档还没有烤好的关卡');
    return;
  }
  app.day = r.day || null;
  app.seedNote = r.seedNote || '';
  app.index = rt.mode === 'campaign' ? rt.index : ALL.indexOf(r.lot) + 1;
  app.lot = r.lot;
  app.label = r.label;
  app.game = createGame(r.lot);
  app.hints = 0;
  view.attach(app.game);
  el.curtain.hidden = true;
  say(`${lawOf(r.lot.law).name}：${lawOf(r.lot.law).rule} —— ${lawOf(r.lot.law).note}`);
  render();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  const done = () => toast('链接已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (undo(app.game)) {
    view.clearFlare();
    renderCrumbs();
    say(app.game.moves === 0 ? '回到起点 · 装船与单程都清零' : `退回一步 · 已用 ${app.game.moves} 单程`);
  }
});

el.hint.addEventListener('click', () => {
  const h = hint(app.game);
  if (!h) {
    say('搜索从当前位置找不到出路 —— 这一局已经走进死局，撤销或重开（前沿耗尽才说“不可解”，见 js/core/solve.js）');
    return;
  }
  app.hints++;
  view.showHint(h.cargo);
  const law = lawOf(app.lot.law);
  say(`提示（高亮者上船）：<b>${h.cargo.map(name).join('、')}</b> —— 之后还需 <b>${h.left}</b> 单程`
    + `${h.needsBoatman ? ' · 艄公必须在船上' : ` · ${law.name}不许空船`}`
    + ` · 用过提示就不算「分毫不差」`);
  renderCrumbs();
});

function restart() {
  reset(app.game);
  app.hints = 0;
  el.curtain.hidden = true;
  view.attach(app.game); // clears the glide/shake effects as well as the state
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice instead of
// firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
  else if (k === 'enter' || k === ' ') {
    // Keyboard route to the same door a click on the hull uses, so the crossing needs a mouse
    // in the browser test but not in everyday play.
    ev.preventDefault();
    departNow();
  }
});

view.start();
// Deliberately not paused on visibilitychange: the crossing glide, the shake and the win card are
// driven from the same loop, and a tab that reports itself hidden (headless Chrome does) must
// still be able to finish a lot.
apply();

// The test hook. Everything an automated finger needs is here: where to press (client px, straight
// out of the same layout the renderer used), what the certified route is, and one `play()` that
// replays it through boardRole/departNow rather than around them.
window.ferry = {
  version: 1,
  // 简报 §3：把 view 挂到台面上，否则减弱动效/暂停这类判据任何探针都读不到内部状态。
  view,
  setReduceMotion: (on) => view.setReduceMotion(on),
  isReducedMotion: () => view.isReducedMotion(),
  get state() {
    const g = app.game;
    const lot = app.lot;
    const st = g ? standing(g) : null;
    const f = g && g.fault;
    return {
      mode: app.mode,
      label: app.label,
      hash: linkFor(app.route),
      id: lot && lot.id,
      title: lot && lot.title,
      tier: lot && lot.tier,
      index: app.index,
      levels: LEVELS,
      law: lot && lot.law,
      capacity: lot && lot.capacity,
      roles: lot ? lot.comp.n : 0,
      par: lot && lot.par,
      routes: lot && lot.routes,
      states: lot && lot.states,
      trips: g ? g.moves : 0,
      hints: app.hints,
      done: !!(g && g.done),
      busy: view.busy(),
      curtain: !el.curtain.hidden,
      boat: st ? st.boat.slice() : [],
      bank: st ? st.bank : 0,
      left: st ? st.left.slice() : [],
      right: st ? st.right.slice() : [],
      fault: f ? { why: f.why, roles: (f.conflict && f.conflict.roles) || [], where: f.where || null } : null,
      unlocked: store.unlocked,
      solved: solvedCount(),
      perfect: Object.values(store.records).filter((r) => r.perfect).length,
      daily: app.day,
      seed: app.seedNote,
      readout: el.readout.textContent,
      line: el.hintline.textContent,
      verdict: el.verdict.textContent,
      stars: el.stars.textContent,
    };
  },
  get pool() { return poolStats(); },
  get laws() { return LAWS; },
  names() { return app.lot ? Array.from(app.lot.comp.short) : []; },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  route() { return linkFor(app.route); },
  lot() { return app.lot ? app.lot.spec : null; },
  // The certified shortest route for this lot's start line — recomputed here from the same
  // solver the baker used, so a test can prove the browser agrees with the printed number.
  plan() { return solve({ comp: app.lot.comp }, { limit: 200000 }).route.map((s) => s.cargo); },
  // Replay a list of cargoes through the same two doors a finger uses (board, then depart).
  play(cargos) {
    const out = [];
    for (const cargo of cargos || []) {
      for (const id of cargo) {
        if (standing(app.game).boat.indexOf(id) < 0) boardRole(id);
      }
      const r = departNow();
      out.push({ ok: !!r.ok, why: r.why || null, trips: app.game.moves });
      if (!r.ok) break;
    }
    return { steps: out, trips: app.game.moves, done: app.game.done };
  },
  board(id) { return boardRole(id); },
  unboard(id) { return unboardRole(id); },
  cross() { return departNow(); },
  undoStep() { el.undo.click(); return app.game.moves; },
  hintOnce() { el.hint.click(); return { hints: app.hints, line: el.hintline.textContent }; },
  store,
  // Client-space coordinates: an automated finger presses these instead of redoing the geometry.
  rolePoint(id) { return view.rolePoint(id); },
  boatPoint() { return view.boatPoint(); },
  dockPoint(bank) { return view.dockPoint(bank); },
  // How far from a role's centre a press still hits it, in client px — so a test that means to
  // press *nothing* can prove its coordinate clears every hit box.
  reach() { return view.reach(); },
  seedOf(s) { return hashSeed(String(s)); },
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 是不够的，
// 玩家在系统里把开关拨回来，页面还停在上一次读到的答案上。
// addEventListener 是标准接口，老 Safari 只有 addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) {
  view.setReduceMotion(on);
}
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
