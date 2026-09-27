// The generator, measured rather than trusted. Two claims hold this repo up: that a level only
// ships after the search agreed its number, and that the naive "scatter and filter" generator this
// one replaced could not fill the top band at all. Both are asserted here on a small, bounded run;
// `node test/balance.mjs` is the big print that feeds the numbers quoted in DESIGN.md.

import { test, eq, ok, run } from '../tools/harness.mjs';
import { makeLot, scatter, pairSpec, majoritySpec, TIERS, tierByKey } from '../js/core/make.js';
import { solve } from '../js/core/solve.js';
import { compile, validate } from '../js/core/river.js';
import { hashSeed } from '../js/core/rng.js';

const cheap = (key, over) => Object.assign({}, tierByKey(key), over);

test('the classic seeds still measure what their comments claim', () => {
  eq(solve(pairSpec(['狼', '羊'], [[1, 2]], 2)).par, 3);
  eq(solve(pairSpec(['狼', '羊', '菜'], [[1, 2], [2, 3]], 2)).par, 7);
  eq(solve(majoritySpec(1, 1, 'free', 2)).par, 1);
  eq(solve(majoritySpec(2, 2, 'free', 2)).par, 5);
  eq(solve(majoritySpec(3, 3, 'free', 2)).par, 11);
  eq(solve(majoritySpec(1, 1, 'ferry', 2)).par, 3);
  eq(solve(majoritySpec(2, 2, 'ferry', 2)).par, 7);
  eq(solve(majoritySpec(3, 3, 'ferry', 2)).ok, false);
  eq(validate(pairSpec(['狼', '羊', '菜'], [[1, 2], [2, 3]], 2)), null);
  eq(validate(majoritySpec(3, 3, 'ferry', 2)), null);
});

test('a lot is a pure function of its seed: the same seed, the same crossing', () => {
  for (const key of ['shoal', 'ford']) {
    const tier = tierByKey(key);
    const a = makeLot('stable', tier);
    const b = makeLot('stable', tier);
    ok(a && b, `${key} produced nothing at all`);
    eq(JSON.stringify(a.spec), JSON.stringify(b.spec));
    eq(a.rating.par, b.rating.par);
    eq(a.signature, b.signature);
    ok(hashSeed('stable') !== hashSeed('other'));
    const c = makeLot('different', tier);
    ok(c, `${key} produced nothing for a second seed`);
    eq(c.rating.par >= tier.min && c.rating.par <= tier.max, true, `${key} escaped its band: ${c.rating.par}`);
  }
});

test('every lot the generator emits is valid, solvable, and its published numbers are its own', () => {
  let checked = 0;
  for (const tier of TIERS) {
    for (let s = 0; s < 3; s++) {
      const lot = makeLot(`audit-${s}`, tier);
      if (!lot) continue;
      eq(validate(lot.spec), null, `${tier.key} emitted an invalid spec`);
      const r = solve(lot.spec, { limit: 400000 });
      eq(r.ok, true, `${tier.key} shipped an unsolvable lot`);
      eq(r.truncated, false, `${tier.key}: the search hit its budget, so the band is a guess`);
      eq(r.par, lot.rating.par, `${tier.key} par`);
      eq(r.routes, lot.rating.routes, `${tier.key} route count`);
      eq(r.explored, lot.rating.states, `${tier.key} state census`);
      eq(r.par >= tier.min && r.par <= tier.max, true, `${tier.key} band ${tier.min}-${tier.max} got ${r.par}`);
      eq(r.par % 2, 1, 'the boat starts on the left and ends on the right, so a solution takes an odd number of trips');
      const comp = compile(lot.spec);
      eq(comp.rule, lot.rating.law);
      eq(comp.capacity, lot.rating.capacity);
      eq(comp.n, lot.rating.roles);
      eq(lot.rating.roles >= tier.roles[0] && lot.rating.roles <= tier.roles[1], true, 'the cast is outside its band');
      // The serialised form is what ships; check it survives the trip and still means the same.
      const back = compile(JSON.parse(JSON.stringify(lot.spec)));
      eq(back.startMask, comp.startMask);
      eq(solve({ comp: back }).par, r.par);
      checked++;
    }
  }
  ok(checked >= 8, `only ${checked} lots were auditable`);
});

test('growing a lot does not mutate the tier table or the seed pool it started from', () => {
  const frozen = JSON.stringify(TIERS);
  const tier = tierByKey('rapids');
  const face = JSON.stringify(tier);
  const stats = {};
  const lot = makeLot('purity', tier, stats);
  eq(JSON.stringify(TIERS), frozen, 'makeLot edited the ladder');
  eq(JSON.stringify(tier), face, 'makeLot edited the tier it was handed');
  const again = makeLot('purity', tierByKey('rapids'));
  eq(again.rating.par, lot.rating.par, 'a run with a stats object generated something different');
  eq(JSON.stringify(again.spec), JSON.stringify(lot.spec));
  ok(Object.keys(stats).length > 0, 'no counters were touched at all');
});

test('the grower stops: bounded probes, bounded budget, and it says which bound it hit', () => {
  const tight = cheap('labyrinth', { probes: 2, restarts: 1, budget: 1, lateral: 0, search: 40000 });
  const stats = {};
  const t0 = Date.now();
  const out = makeLot('bound', tight, stats);
  const ms = Date.now() - t0;
  ok(ms < 4000, `a two-probe lot took ${ms} ms — a bound is not a bound`);
  ok(!out || out.rating.probes <= tight.probes, 'the probe counter exceeded the tier');
  if (out) eq(out.rating.probes >= 1, true);
  const nullOut = makeLot('bound', cheap('labyrinth', { probes: 1, restarts: 1, budget: 0, roles: [8, 8], lateral: 0 }), {});
  ok(nullOut === null || nullOut.rating.par >= 13, 'an impossible ladder produced a lot below its band');
});

test('the scatter generator is honest about how rarely it lands in the top band', () => {
  const stats = {};
  const tier = cheap('labyrinth', { restarts: 1 });
  const found = [];
  for (let s = 0; s < 12; s++) {
    const lot = scatter(`scatter-audit-${s}`, tier, stats);
    if (lot) found.push(lot);
  }
  const probed = (stats.found || 0) + (stats.unsolvable || 0) + (stats.underBand || 0) + (stats.tooHard || 0) + (stats.invalid || 0) + (stats.nofit || 0);
  ok(probed > 0, 'nothing was attempted');
  ok(found.length <= probed);
  // The measured point of this test: a naive scatter is not a level factory. `node test/balance.mjs`
  // prints the exact rate over thousands of samples; the bound here is loose on purpose so the
  // suite still passes if the seed strings are ever re-hashed.
  const rate = found.length / Math.max(1, probed);
  ok(rate < 0.5, `scatter accepted ${(rate * 100).toFixed(1)}% into the top band — the DESIGN.md number is stale`);
  for (const lot of found) {
    eq(validate(lot.spec), null);
    eq(solve(lot.spec).par, lot.rating.par);
  }
});

test('a mutation ladder that cannot be fed produces null instead of a lie', () => {
  const impossible = cheap('rapids', { min: 41, max: 41, probes: 4, restarts: 1, budget: 20 });
  eq(makeLot('impossible', impossible), null, 'the grower claimed a 41-trip lot it never measured');
  // A band that asks for a cast size no seed can reach must also refuse, rather than ship the
  // nearest thing it found.
  const wrongCast = cheap('labyrinth', { roles: [11, 12], probes: 6, restarts: 2, budget: 200 });
  eq(makeLot('wrongcast', wrongCast), null, 'an eleven-role band was filled with something else');
});

run();
