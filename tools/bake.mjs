// The content pipeline. This is where the levels in 迷津渡 come from — the browser never
// generates a crossing, it only picks one.
//
// Why offline, with numbers. Measured in this repo on 2026-09-27 and reproducible with the two
// commands below (`node test/balance.mjs` at its default SAMPLES=60 per band):
//   * shipped generator, top band (labyrinth): median 210 ms, worst 2629 ms per seed;
//   * this baker, top band: 41 452 mutation probes, 339 kept (0.8%), 13 826 measured unsolvable,
//     27 287 measured no gain; the band in ~9.2 s, a single level in 1110-2414 ms worst case
//     (the timing column drifts with machine load, the structural numbers do not);
//   * the naive scatter generator it replaced: 2 016 probes, 1.0% landed in that band.
// That is a fine cost for a build step and an unacceptable one for a tap on the screen. So the
// generator runs here once, the solver certifies every level it emits, and what ships is the
// measured set.
//
//   node tools/bake.mjs
//   PER_TIER=8 node tools/bake.mjs
//
// A lot only enters js/data/lots.js if re-solving the *serialised* spec reproduces both the
// single-trip count and the number of shortest routes the generator claimed. Nothing unmeasured
// ships, and test/library.test.mjs re-runs the same proof against the shipped file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makeLot } from '../js/core/make.js';
import { solve } from '../js/core/solve.js';
import { compile, validate, toSpec, signature } from '../js/core/river.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_TIER = Number(process.env.PER_TIER || 6);
const COLLECT = Number(process.env.COLLECT || 40);

// Two lots whose roles, laws, capacities and conflict edges match up to role order are the same
// crossing. js/core/river.js `signature()` is that identity, and the library test uses it too.

// Deterministic diversity pick. A band is played as a curve, so the baker takes, slot by slot:
// a lot whose *visible face* (boat law + capacity + measured par + the cast's names) has not been
// used in this band yet, then the law least represented in that band, then the least represented
// conflict family, then the par furthest from the ones already kept, then the richer state space,
// then seed order. The point is not elegance: the generator converges on a handful of canonical
// shapes (measured 2026-09-27, `node test/balance.mjs` 唯一题面 column: 8 distinct 题面 per 60
// seeds in `shoal`, 36 per 60 in `labyrinth`; `tools/bake.mjs` itself reports `unique 9` of 40
// seeds for shoal), and "first six unique" would ship two levels the player cannot tell apart on
// screen — different conflict edges, same cast, same number.
function faceOf(lot) {
  return `${lot.rating.law}c${lot.rating.capacity}p${lot.rating.par}|${lot.spec.roles.map((r) => r.name).sort().join('')}`;
}

function pickDiverse(pool, want) {
  const chosen = [];
  const rest = pool.slice();
  const tally = { ferry: 0, free: 0, pair: 0, majority: 0 };
  const faces = new Set();
  while (chosen.length < want && rest.length) {
    let at = 0;
    for (let i = 1; i < rest.length; i++) {
      if (betterCandidate(rest[i], rest[at], chosen, tally, faces, i, at)) at = i;
    }
    const lot = rest.splice(at, 1)[0];
    tally[lot.rating.law]++;
    tally[lot.rating.risk]++;
    faces.add(faceOf(lot));
    chosen.push(lot);
  }
  return chosen;
}

function rank(r, chosen, tally, faces, lot) {
  const near = chosen.length
    ? Math.min(...chosen.map((c) => Math.abs(c.rating.par - r.par)))
    : 999;
  return [faces.has(faceOf(lot)) ? 1 : 0, tally[r.law], tally[r.risk], -near, -r.states];
}

function betterCandidate(a, b, chosen, tally, faces, ia, ib) {
  const ra = rank(a.rating, chosen, tally, faces, a).concat([ia]);
  const rb = rank(b.rating, chosen, tally, faces, b).concat([ib]);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] < rb[i];
  }
  return false;
}

// A mutation changes the cast, so the seed's hand-written title is stale by the time a level
// ships. The title is therefore derived from the lot that actually shipped: who is on the bank.
function castTitle(spec) {
  const crew = spec.roles.filter((r) => r.cls !== 'ferryman');
  if (spec.risk.type === 'majority') {
    const weak = crew.filter((r) => r.cls === spec.risk.weak).length;
    const strong = crew.filter((r) => r.cls === spec.risk.strong).length;
    return `${weak}教${strong}野`;
  }
  const named = new Set();
  for (const [x, y] of spec.risk.pairs) {
    named.add(spec.roles[x].name);
    named.add(spec.roles[y].name);
  }
  const rest = crew.length - named.size;
  return [...named].join('') + (rest > 0 ? `+${rest}闲` : '');
}

const out = [];
const report = [];
const histogram = {};
let slowestLot = 0;
let maxStates = 0;

for (const tier of TIERS) {
  const stats = {};
  const seen = new Set();
  const pool = [];
  const t0 = Date.now();
  for (let s = 0; s < COLLECT; s++) {
    const b0 = Date.now();
    const lot = makeLot(`bake-${tier.key}-${s}`, tier, stats);
    slowestLot = Math.max(slowestLot, Date.now() - b0);
    if (!lot) continue;
    // Serialise first, then certify the serialised form: the file that ships is the thing tested.
    const spec = toSpec(compile(lot.spec));
    const err = validate(spec);
    if (err) throw new Error(`${tier.key}: generator emitted an invalid lot: ${err}`);
    spec.title = castTitle(spec);
    const sig = signature(spec);
    if (seen.has(sig)) { stats.dupSig = (stats.dupSig || 0) + 1; continue; }
    const again = solve(spec, { limit: 400000 });
    if (!again.ok || again.par !== lot.rating.par) {
      throw new Error(`${tier.key}: par ${lot.rating.par} not reproducible from the spec (${again.par})`);
    }
    if (again.routes !== lot.rating.routes) {
      throw new Error(`${tier.key}: route count ${lot.rating.routes} not reproducible (${again.routes})`);
    }
    if (again.truncated) throw new Error(`${tier.key}: search truncated — the verdict would not be a proof`);
    seen.add(sig);
    maxStates = Math.max(maxStates, again.explored);
    histogram[tier.key] = histogram[tier.key] || {};
    histogram[tier.key][again.par] = (histogram[tier.key][again.par] || 0) + 1;
    pool.push({
      rating: {
        ...lot.rating,
        par: again.par,
        routes: again.routes,
        states: again.explored,
      },
      spec,
      seed: lot.seed,
    });
  }
  const picked = pickDiverse(pool, PER_TIER);
  if (picked.length < PER_TIER) {
    console.error(`warn: ${tier.key} only reached ${picked.length} distinct levels of ${PER_TIER} — raise COLLECT`);
  }
  // The campaign is a curve: lowest band first and, inside a band, the measured number ascending.
  picked.sort((a, b) => a.rating.par - b.rating.par || a.rating.states - b.rating.states);
  picked.forEach((l, i) => {
    const r = l.rating;
    out.push({
      id: `${tier.key}-${String(i + 1).padStart(2, '0')}`,
      tier: tier.key,
      order: 0, // filled in once every band is known
      par: r.par,
      routes: r.routes,
      states: r.states,
      roles: r.roles,
      capacity: r.capacity,
      law: r.law,
      risk: r.risk,
      edges: r.edges,
      mutations: r.mutations,
      probes: r.probes,
      spec: l.spec,
    });
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const kept = stats.keep || 0;
  const probed = stats.probe || 0;
  report.push({
    tier: tier.key,
    kept: picked.length,
    line: `seeds ${COLLECT} → levels ${stats.found || 0} (${Math.round(((stats.found || 0) / COLLECT) * 100)}%)`
      + ` · unique ${pool.length} (${Math.round((pool.length / Math.max(1, stats.found || 0)) * 100)}%)`
      + ` · 变异接受 ${kept}/${probed} (${((kept / Math.max(1, probed)) * 100).toFixed(1)}%)`
      + ` · 弃因 无提升 ${stats.noGain || 0} 不可解 ${stats.unsolvable || 0} 超带 ${stats.tooHard || 0}`
      + ` 人数不合 ${stats.castSize || 0} 低于带 ${stats.underBand || 0} 同数平移 ${stats.lateral || 0}`
      + ` · ${secs}s`,
    pars: picked.map((l) => l.rating.par).join(','),
    laws: picked.map((l) => (l.rating.law === 'free' ? '自由' : '艄公')).join(','),
  });
}

out.forEach((l, i) => { l.order = i + 1; });

// The band the UI prints is measured off the lots that actually shipped, not copied from the
// generator's wish list — so a re-bake that lands lighter or heavier says so out loud.
const meta = TIERS.map((t) => {
  const mine = out.filter((l) => l.tier === t.key).map((l) => l.par);
  const lo = Math.min(...mine);
  const hi = Math.max(...mine);
  const free = out.filter((l) => l.tier === t.key && l.law === 'free').length;
  return {
    key: t.key,
    label: t.label,
    blurb: t.blurb,
    min: lo,
    max: hi,
    free,
    ferry: mine.length - free,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — the crossings in this game are measurements, not opinions.',
  '// `par` is the BFS-shortest number of single trips for the spec on the same line, `routes` the',
  '// number of such shortest routes and `law` the boat law that number depends on (the same cast',
  "// under 'ferry' and 'free' can differ by being unsolvable at all). Re-run",
  '// `node tools/bake.mjs` instead of hand-editing; `node test/library.test.mjs` fails if a line',
  '// and its printed numbers ever disagree, so a hand-edit cannot pass CI.',
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const LOTS = [',
  ...out.map((l) => `  ${JSON.stringify(l)},`),
  '];',
  '',
].join('\n');

const path = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, lines);

console.log('');
for (const r of report) {
  console.log(`${r.tier.padEnd(10)} 收 ${r.kept} 题  ${r.line}`);
  console.log(`${''.padEnd(10)} 选中 par ${r.pars} · 船口径 ${r.laws}`);
}
console.log('');
console.log('实测 par 直方图（候选池，决定难度带边界）：');
for (const t of TIERS) {
  const cells = Object.entries(histogram[t.key] || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`  ${t.key.padEnd(10)} ${cells.map(([p, n]) => `${p} 单程 x${n}`).join('  ')}`);
}
console.log('');
console.log(`最慢一题 ${slowestLot} ms · 最大搜索 ${maxStates} 态（2^(n+1) 之中）`);
console.log(`写入 ${out.length} 题 -> js/data/lots.js`);
