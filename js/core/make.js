// The generator. There is no hand-authored level file in this repo, and that is deliberate: a
// crossing is only worth offering once the search has said how many single trips it takes.
//
// This runs at build time (tools/bake.mjs), never on a tap — see the measured numbers in
// DESIGN.md 3.3. Nothing shipped imports this file.
//
// Why it mutates instead of scattering. `scatter()` below is the obvious generator and
// `test/balance.mjs` measures it — 2026-09-27 run, top band (13-15 single trips): 2 016 probes,
// 1.0% of them landed in the band and 35.1% were measured unsolvable outright. A long route is
// not random: it needs a chain of roles that each force the boat to come back. So the shipped
// generator starts from a classic cast whose answer is already known (wolf-goat-cabbage is 7,
// M&C 3+3 free is 11) and applies local mutations, re-measuring with the BFS solver after every
// one and keeping it only if the measured number went *up* toward that level's target — with a
// small, bounded allowance for steps that measure the same number, because pure hill-climbing
// collapses a band onto a handful of shapes. What the shipped ladder (lateral allowance included)
// actually yields, same run: 8 distinct 题面 out of 60 seeds in `shoal`, 36 out of 60 in
// `labyrinth` — the `唯一题面` column. Measured acceptance: `node test/balance.mjs`.
//
// That rule buys three things at once: every level is solvable (verified after every step), every
// accepted mutation is one the search agreed to, and the band you play in is a measured number
// rather than an opinion about difficulty.

import { compile, validate, signature } from './river.js';
import { solve } from './solve.js';
import { rngFrom } from './rng.js';

const BOATMAN = { id: 0, name: '艄公', short: '艄', kind: 'ferryman', cls: 'ferryman' };
const STRONG = '野人';
const WEAK = '传教士';
// Roles nobody conflicts with: they only cost boat-loads. Eight names so a top-band cast of seven
// passengers never has to reuse one.
const INNOCENT_NAMES = ['客商', '木箱', '瓦罐', '药庐', '书箧', '盐袋', '陶埙', '干粮'];

function clone(spec) {
  return JSON.parse(JSON.stringify(spec));
}

// The two families the classic puzzles come from.
export function pairSpec(names, pairs, capacity) {
  return {
    title: names.join(''),
    roles: [Object.assign({}, BOATMAN)].concat(names.map((name, i) => ({
      id: i + 1,
      name,
      short: name.slice(0, 1),
      kind: i % 3 === 2 ? 'goods' : 'beast',
    }))),
    boat: { rule: 'ferry', capacity },
    risk: { type: 'pair', pairs },
  };
}

export function majoritySpec(m, c, rule, capacity) {
  const roles = rule === 'ferry' ? [Object.assign({}, BOATMAN)] : [];
  for (let i = 0; i < m; i++) {
    roles.push({ id: roles.length, name: `${WEAK}${i + 1}`, short: '教', kind: 'human', cls: WEAK });
  }
  for (let i = 0; i < c; i++) {
    roles.push({ id: roles.length, name: `${STRONG}${i + 1}`, short: '野', kind: 'beast', cls: STRONG });
  }
  return {
    title: `${m}教${c}野`,
    roles,
    boat: { rule, capacity },
    risk: { type: 'majority', strong: STRONG, weak: WEAK },
  };
}

// The classic casts. Every answer below comes out of `solve` at run time; the comments are the
// hand-written values from test/anchors.test.mjs, kept here as orientation for a reader. Casts the
// search rejects as unsolvable stay in the list on purpose — `seedPool()` measures them out, and
// they are the reason the last two rows of the spec's §0 table are still visible in this file.
const SEEDS = [
  () => pairSpec(['狼', '羊'], [[1, 2]], 2), // 3
  () => pairSpec(['狼', '羊'], [[1, 2]], 3), // 1
  () => pairSpec(['狼', '羊', '菜'], [[1, 2], [2, 3]], 2), // 7, wolf-goat-cabbage
  () => pairSpec(['狼', '羊', '菜'], [[1, 2], [2, 3]], 3),
  () => pairSpec(['狼', '羊', '菜', '鸡'], [[1, 2], [2, 3], [3, 4]], 2),
  () => pairSpec(['狼', '羊', '菜', '鸡'], [[1, 2], [2, 3], [3, 4]], 3),
  () => pairSpec(['狼', '羊', '菜', '鸡'], [[1, 2], [2, 3]], 3),
  () => pairSpec(['狼', '羊', '菜', '鸡'], [[1, 2], [2, 3], [1, 3], [3, 4]], 2),
  () => pairSpec(['狼', '羊', '菜', '鸡', '鼠'], [[1, 2], [2, 3], [3, 4], [4, 5]], 2),
  () => pairSpec(['狼', '羊', '菜', '鸡', '鼠'], [[1, 2], [2, 3], [1, 4], [3, 5]], 2),
  () => pairSpec(['狐', '鹅', '豆'], [[1, 2], [2, 3]], 2),
  () => pairSpec(['狐', '鹅', '豆', '粟'], [[1, 2], [2, 3], [2, 4]], 2),
  () => majoritySpec(1, 1, 'free', 2), // 1
  () => majoritySpec(2, 2, 'free', 2), // 5
  () => majoritySpec(2, 2, 'free', 3),
  () => majoritySpec(3, 3, 'free', 2), // 11
  () => majoritySpec(3, 3, 'free', 3),
  () => majoritySpec(4, 4, 'free', 3), // 9
  () => majoritySpec(2, 1, 'free', 2),
  () => majoritySpec(3, 2, 'free', 2),
  () => majoritySpec(1, 1, 'ferry', 2), // 3
  () => majoritySpec(2, 2, 'ferry', 2), // 7
  () => majoritySpec(2, 2, 'ferry', 3),
  () => majoritySpec(3, 3, 'ferry', 2), // unsolvable: the law the spec's last row is about
  () => majoritySpec(3, 3, 'ferry', 3), // 5
  () => majoritySpec(4, 4, 'ferry', 3), // 7
  () => majoritySpec(2, 1, 'ferry', 2),
  () => majoritySpec(3, 2, 'ferry', 3),
];

// Seed answers, measured once per process. Used only to skip casts that start above a band's
// ceiling — the published number still comes from `solve` at every step of the growth.
let seedCache = null;
function seedPool() {
  if (!seedCache) {
    seedCache = SEEDS.map((make) => {
      const spec = make();
      const r = solve(spec);
      return { spec, ok: r.ok, par: r.ok ? r.par : Infinity };
    });
  }
  return seedCache;
}

// --- the mutation ops ----------------------------------------------------------------
//
// Each one returns a *new* spec or null (nothing to do). They never look at the answer: the
// growth loop decides whether a mutation earned its place.
//
// Ids are positional (role i carries id i, and role 0 is the boatman when there is one), so any
// op that adds or removes a role has to renumber and remap the conflict pairs. `renumber` and
// `without` do that in one place; doing it inline per op is how this file would get broken.

function renumber(spec) {
  const boatman = spec.roles.find((r) => r.cls === 'ferryman');
  const roles = [];
  if (boatman) roles.push(Object.assign({}, boatman, { id: 0 }));
  for (const r of spec.roles) {
    if (r === boatman) continue;
    roles.push(Object.assign({}, r, { id: roles.length }));
  }
  spec.roles = roles;
  return spec;
}

function without(spec, id) {
  const remap = (i) => (i === id ? -1 : i > id ? i - 1 : i);
  const next = clone(spec);
  next.roles = next.roles.filter((r) => r.id !== id);
  if (next.risk.type === 'pair') {
    next.risk.pairs = next.risk.pairs
      .map(([a, b]) => [remap(a), remap(b)])
      .filter(([a, b]) => a >= 0 && b >= 0 && a !== b);
    // a crossing puzzle where nothing conflicts is not a puzzle
    if (!next.risk.pairs.length) return null;
  }
  return renumber(next);
}

function touched(spec) {
  const set = new Set();
  for (const [a, b] of spec.risk.pairs || []) { set.add(a); set.add(b); }
  return set;
}

function degreeOf(spec, id) {
  let d = 0;
  for (const [a, b] of spec.risk.pairs) if (a === id || b === id) d++;
  return d;
}

function edgeKey(a, b) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

// add or drop a conflict edge between two non-boatman roles
function opEdge(rng, spec) {
  if (spec.risk.type !== 'pair') return null;
  const pairs = spec.risk.pairs;
  if (rng.chance(0.5) || pairs.length === 1) {
    const n = spec.roles.length;
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(1, n - 1);
      const b = rng.range(1, n - 1);
      if (a === b || degreeOf(spec, a) >= 3 || degreeOf(spec, b) >= 3) continue;
      const key = edgeKey(a, b);
      if (pairs.some(([x, y]) => edgeKey(x, y) === key)) continue;
      const next = clone(spec);
      next.risk.pairs = pairs.concat([[a, b]]);
      return next;
    }
    return null;
  }
  const drop = rng.int(pairs.length);
  const [a, b] = pairs[drop];
  const next = clone(spec);
  next.risk.pairs = pairs.filter((_, i) => i !== drop);
  if (!next.risk.pairs.length) return without(spec, degreeOf(next, a) === 0 ? a : b);
  return next;
}

// add or remove a role that no conflict mentions. Measured: under a capacity-2 law each added
// innocent costs exactly two extra single trips, which is what makes the top bands reachable.
function opRole(rng, spec, tier) {
  if (spec.risk.type !== 'pair') return null;
  const mark = touched(spec);
  const free = spec.roles.map((r) => r.id).filter((i) => i !== 0 && !mark.has(i));
  if (rng.chance(0.6) || !free.length) {
    if (spec.roles.length >= tier.roles[1]) return null;
    const next = clone(spec);
    const used = new Set(next.roles.map((r) => r.name));
    const fresh = INNOCENT_NAMES.filter((n) => !used.has(n));
    if (!fresh.length) return null;
    const name = rng.pick(fresh);
    next.roles.push({ id: next.roles.length, name, short: name.slice(0, 1), kind: 'goods' });
    return next;
  }
  return without(spec, rng.pick(free));
}

// majority casts: add or remove one of each class, so the balance that made the start bank
// survivable in the first place is not destroyed by the mutation
function opClass(rng, spec, tier) {
  if (spec.risk.type !== 'majority') return null;
  const counts = { [WEAK]: 0, [STRONG]: 0 };
  for (const r of spec.roles) if (counts[r.cls] !== undefined) counts[r.cls]++;
  const next = clone(spec);
  if (rng.chance(0.55)) {
    if (next.roles.length + 2 > tier.roles[1]) return null;
    next.roles.push({ id: 0, name: `${WEAK}${counts[WEAK] + 1}`, short: '教', kind: 'human', cls: WEAK });
    next.roles.push({ id: 0, name: `${STRONG}${counts[STRONG] + 1}`, short: '野', kind: 'beast', cls: STRONG });
    return renumber(next);
  }
  if (counts[WEAK] <= 1 || counts[STRONG] <= 1 || next.roles.length - 2 < tier.roles[0]) return null;
  const goneWeak = spec.roles.find((r) => r.cls === WEAK).id;
  const step1 = without(spec, goneWeak);
  if (!step1) return null;
  const strong = step1.roles.find((r) => r.cls === STRONG);
  return strong ? without(step1, strong.id) : null;
}

function opCap(rng, spec, tier) {
  const next = clone(spec);
  const cap = next.boat.capacity + (rng.chance(0.5) ? 1 : -1);
  // 'ferry' at capacity 1 is the boatman crossing alone forever: measured 0 of 342 scatter
  // samples solvable, so the ladder never offers it. 'free' tops out at 4 because a 4+4 cast that
  // fits everyone at once stops being a puzzle rather than becoming a harder one.
  const hi = spec.boat.rule === 'free' ? 4 : 3;
  if (cap < Math.max(2, tier.caps[0]) || cap > hi) return null;
  next.boat.capacity = cap;
  return next;
}

// The mutation this whole repo exists to make visible: same cast, same conflicts, different boat
// law. Under 'majority' the laws are interchangeable (the boatman joins or leaves the crew), and
// the measured answer can go from 11 single trips to "unsolvable".
function opLaw(rng, spec) {
  if (spec.risk.type !== 'majority') return null;
  const next = clone(spec);
  if (next.boat.rule === 'ferry') {
    next.boat.rule = 'free';
    return without(next, next.roles.find((r) => r.cls === 'ferryman').id);
  }
  next.boat.rule = 'ferry';
  next.roles = [Object.assign({}, BOATMAN)].concat(next.roles);
  return renumber(next);
}

const OPS = ['edge', 'role', 'class', 'cap', 'law'];
const APPLY = { edge: opEdge, role: opRole, class: opClass, cap: opCap, law: opLaw };

// One random mutation, shuffled so that whichever ops can apply to this cast get their shot.
function mutate(rng, spec, tier) {
  for (const name of rng.shuffle(OPS.slice())) {
    const next = APPLY[name](rng, spec, tier);
    if (!next) continue;
    if (validate(next)) continue;
    return { spec: next, via: name };
  }
  return null;
}

// Grow one level from one seed. Returns null if it cannot reach the band inside its budget.
//
// Each attempt aims at one measured number inside its band — the odd steps of that band, picked by
// the seed — and growth stops the moment the search reaches or passes it. Aiming every level at
// the ceiling instead would make all six levels of a band identical, and a difficulty that never
// varies inside a band is a band nobody can feel. Whatever the search measured gets published; a
// level that stalls below its target is still inside its band.
function ladderOf(tier) {
  const rungs = [];
  for (let p = tier.min; p <= tier.max; p += 2) rungs.push(p);
  return rungs;
}

function grow(seed, tier, stats) {
  const rng = rngFrom(`${tier.key}|${seed}`);
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  const deadline = Date.now() + (tier.budget || 3000);
  const target = rng.pick(ladderOf(tier));
  const pool = seedPool().filter((s) => s.ok && s.par <= target);
  if (!pool.length) { hit('noSeed'); return null; }
  let spec = clone(rng.pick(pool).spec);

  let rating = solve(spec, { limit: tier.search || 40000 });
  if (!rating.ok) { hit('seedBad'); return null; }
  if (rating.par > target) { hit('overTarget'); return null; }

  let guard = 0;
  let spent = 0;
  let lateral = 0;
  let timedOut = false;
  while (rating.par < target && guard < (tier.probes || 400)) {
    guard++;
    if (Date.now() > deadline) { timedOut = true; break; }
    const m = mutate(rng, spec, tier);
    if (!m) { hit('nofit'); continue; }
    hit('probe');
    const next = solve(m.spec, { limit: tier.search || 40000 });
    if (!next.ok) { hit('unsolvable'); continue; }
    if (next.par > target) { hit('tooHard'); continue; }
    if (next.par < rating.par) { hit('noGain'); continue; }
    if (next.par === rating.par) {
      // A lateral step: same measured number, different cast. Strictly-increasing acceptance is
      // what keeps the claim honest, but it also funnels every seed in a band into the same two or
      // three canonical shapes (measured: 40 seeds, 9 distinct lots). Letting a bounded number of
      // equal-cost steps through is the difference between a ladder and a loop — the published par
      // is still whatever the search measures at the end, and it still has to sit in the band.
      if (lateral >= (tier.lateral || 0) || !rng.chance(0.5)) { hit('noGain'); continue; }
      lateral++;
      hit('lateral');
    }
    spec = m.spec;
    rating = next;
    spent++;
    hit('keep');
  }
  if (timedOut) hit('timeout');

  const n = spec.roles.length;
  if (n < tier.roles[0] || n > tier.roles[1]) { hit('castSize'); return null; }
  if (rating.par < tier.min) { hit('underBand'); return null; }
  const comp = compile(spec);
  return {
    spec,
    rating: {
      par: rating.par,
      target,
      routes: rating.routes,
      states: rating.explored,
      roles: n,
      capacity: comp.capacity,
      law: comp.rule,
      risk: comp.riskType,
      edges: comp.riskType === 'pair' ? comp.pairs.length : null,
      mutations: spent,
      lateral,
      probes: guard,
    },
    route: rating.route,
    signature: signature(spec),
    seed,
    tier: tier.key,
  };
}
// makeLot(seed, tier, stats?) -> { spec, rating, route } | null, deterministic in the seed.
export function makeLot(seed, tier, stats) {
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  for (let i = 0; i < (tier.restarts || 12); i++) {
    const out = grow(`${seed}#${i}`, tier, stats);
    if (out) {
      hit('found');
      return out;
    }
  }
  hit('gaveUp');
  return null;
}

// The obvious generator — random cast, random law, random capacity, random conflict graph, then
// filter. Kept because `test/balance.mjs` measures it and DESIGN.md quotes the number; it is
// deliberately *not* wired into makeLot.
export function scatter(seed, tier, stats) {
  const rng = rngFrom(`scatter|${tier.key}|${seed}`);
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  const tries = (tier.restarts || 12) * 20;
  for (let i = 0; i < tries; i++) {
    const n = rng.range(3, 8);
    const rule = rng.chance(0.5) ? 'ferry' : 'free';
    const capacity = rng.range(2, rule === 'free' ? 4 : 3);
    const crew = rule === 'ferry' ? n - 1 : n;
    let spec;
    if (rule === 'free' || rng.chance(0.5)) {
      const m = Math.max(1, Math.floor(crew / 2));
      spec = majoritySpec(m, crew - m, rule, capacity);
    } else {
      const names = ['狼', '羊', '菜', '鸡', '鼠', '鹰', '蛇'].slice(0, crew);
      const pairs = [];
      const wanted = rng.range(1, Math.max(1, Math.min(4, names.length - 1)));
      for (let k = 0; k < wanted * 6 && pairs.length < wanted; k++) {
        const a = rng.range(1, n - 1);
        const b = rng.range(1, n - 1);
        if (a === b || pairs.some(([x, y]) => x === a && y === b)) continue;
        pairs.push([a, b]);
      }
      if (!pairs.length) { hit('nofit'); continue; }
      spec = pairSpec(names, pairs, capacity);
    }
    if (validate(spec)) { hit('invalid'); continue; }
    const r = solve(spec, { limit: tier.search || 40000 });
    if (!r.ok) { hit('unsolvable'); continue; }
    if (r.par < tier.min) { hit('underBand'); continue; }
    if (r.par > tier.max) { hit('tooHard'); continue; }
    hit('found');
    return {
      spec,
      rating: {
        par: r.par, routes: r.routes, states: r.explored, roles: spec.roles.length,
        capacity: spec.boat.capacity, law: spec.boat.rule, risk: spec.risk.type,
        edges: spec.risk.type === 'pair' ? spec.risk.pairs.length : null,
        mutations: 0, probes: i + 1,
      },
      route: r.route,
      signature: signature(spec),
      seed,
      tier: tier.key,
    };
  }
  hit('gaveUp');
  return null;
}

// The generation ladder. `min`/`max` is the band the grower may publish in; what players see is
// the band measured off the baked levels (TIERS_META in js/data/lots.js), so only one place ever
// claims a difficulty range. The four bands came out of `node test/balance.mjs`: every par in this
// game is odd (the boat starts on the left bank and has to end on the right, so an even number of
// single trips cannot leave it there), and 15 is as high as an eight-role cast measures.
export const TIERS = [
  {
    key: 'shoal', label: '浅滩', blurb: '认船：先看清谁能和谁单独留下', min: 1, max: 3, roles: [2, 4], caps: [2, 3],
    probes: 160, restarts: 10, budget: 1200, lateral: 2,
  },
  {
    key: 'ford', label: '短渡', blurb: '一来一回，船开始要回来接人', min: 5, max: 7, roles: [3, 6], caps: [2, 3],
    probes: 320, restarts: 14, budget: 1500, lateral: 3,
  },
  {
    key: 'rapids', label: '急流', blurb: '要把已经送过去的再带回来', min: 9, max: 11, roles: [5, 7], caps: [2, 4],
    probes: 480, restarts: 16, budget: 2200, lateral: 4,
  },
  {
    key: 'labyrinth', label: '迷津', blurb: '整条河都是一张网', min: 13, max: 15, roles: [7, 8], caps: [2, 3],
    probes: 640, restarts: 18, budget: 2600, lateral: 5,
  },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}
