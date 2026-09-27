// The shipped pool, re-measured. js/data/lots.js is written by tools/bake.mjs and every row of it
// prints a number on screen; this file is what stops a hand-edit (or a stale bake) from passing CI.
// Each row is re-solved from the *serialised* spec, not from anything the generator kept in memory.

import { test, eq, ok, run } from '../tools/harness.mjs';
import { LOTS, TIERS_META } from '../js/data/lots.js';
import {
  ALL, TIERS, LAWS, lawOf, byId, lotsIn, campaign, levelAt, randomLot, dailyLot, stats, tierByKey,
} from '../js/core/library.js';
import { solve } from '../js/core/solve.js';
import { compile, validate } from '../js/core/river.js';
import { hashSeed } from '../js/core/rng.js';

test('the pool is the size the docs quote and every row is a valid crossing', () => {
  eq(LOTS.length, ALL.length);
  ok(ALL.length >= 24, `only ${ALL.length} lots baked`);
  for (const lot of ALL) eq(validate(lot.spec), null, `${lot.id} does not validate`);
});

test('re-solving every serialised lot reproduces its printed par, route count and state census', () => {
  for (const lot of ALL) {
    const r = solve(lot.spec, { limit: 400000 });
    eq(r.ok, true, `${lot.id} came back unsolvable from its own data row`);
    eq(r.truncated, false, `${lot.id}: the search stopped on its budget, so the verdict is not a proof`);
    eq(r.par, lot.par, `${lot.id} par`);
    eq(r.routes, lot.routes, `${lot.id} shortest-route count`);
    eq(r.explored, lot.states, `${lot.id} reachable states`);
  }
});

test("a lot's printed boat law is the law inside its spec, in both directions", () => {
  for (const lot of ALL) {
    ok(lot.law === 'ferry' || lot.law === 'free', `${lot.id} law ${lot.law}`);
    eq(lot.law, lot.spec.boat.rule, `${lot.id}: the field and the spec disagree about the boat law`);
    eq(lot.capacity, lot.spec.boat.capacity, `${lot.id} capacity`);
    eq(lot.risk, lot.spec.risk.type, `${lot.id} risk family`);
    eq(lot.roles, lot.spec.roles.length, `${lot.id} role count`);
    eq(lawOf(lot.law).key, lot.law);
    if (lot.law === 'ferry') {
      eq(lot.spec.roles[0].cls, 'ferryman', `${lot.id} claims the ferry law without a boatman`);
    } else {
      eq(lot.spec.roles.some((r) => r.cls === 'ferryman'), false, `${lot.id} has a boatman under the free law`);
    }
  }
  ok(ALL.some((l) => l.law === 'free'), 'the pool lost the free-law levels');
  ok(ALL.some((l) => l.law === 'ferry'), 'the pool lost the ferry-law levels');
  ok(ALL.some((l) => l.risk === 'majority'), 'the pool lost the majority levels');
});

test('the four bands do not overlap and the campaign walks them in measured order', () => {
  const seen = [];
  let previous = null;
  ALL.forEach((lot, i) => {
    eq(lot.order, i + 1, `${lot.id} is out of the campaign sequence`);
    if (previous && previous.tier === lot.tier) ok(previous.par <= lot.par, `${lot.id} is lighter than its predecessor`);
    const band = TIERS_META.find((t) => t.key === lot.tier);
    ok(band, `${lot.id} claims a band that does not exist: ${lot.tier}`);
    ok(lot.par >= band.min && lot.par <= band.max, `${lot.id} par ${lot.par} outside ${band.min}-${band.max}`);
    seen.push(lot.tier);
    previous = lot;
  });
  const bands = TIERS_META.map((t) => t.key);
  eq(seen.filter((t) => t === bands[0]).length, TIERS_META[0].free + TIERS_META[0].ferry);
  for (let b = 1; b < bands.length; b++) {
    const lo = TIERS_META[b - 1];
    const hi = TIERS_META[b];
    ok(lo.max < hi.min, `bands ${lo.key} (${lo.min}-${lo.max}) and ${hi.key} (${hi.min}-${hi.max}) overlap`);
  }
  eq(new Set(ALL.map((l) => l.id)).size, ALL.length, 'two lots share an id');
});

test('every band shows both boat laws where the data claims it does', () => {
  const s = stats();
  eq(s.lots, ALL.length);
  for (const t of TIERS_META) {
    const b = s.byTier[t.key];
    ok(b, `no measured row for ${t.key}`);
    eq(b.n, lotsIn(t.key).length, `${t.key} row count`);
    eq(b.n, t.free + t.ferry, `${t.key} law tally`);
    eq(b.parMin, t.min, `${t.key} measured floor`);
    eq(b.parMax, t.max, `${t.key} measured ceiling`);
    ok(b.parMed >= b.parMin && b.parMed <= b.parMax, `${t.key} median outside its own range`);
    ok(b.statesMax >= b.statesMin);
  }
});

test('lookup by id, index and tier', () => {
  eq(byId('shoal-01').id, 'shoal-01');
  eq(byId('not-a-lot'), null);
  eq(campaign().length, ALL.length);
  eq(levelAt(0).id, ALL[0].id);
  eq(levelAt(-1).id, ALL[ALL.length - 1].id, 'a negative index wraps to the last lot rather than crashing');
  eq(levelAt(ALL.length).id, ALL[0].id, 'index N is index 0 in a zero-based lookup');
  eq(levelAt(ALL.length - 1).id, ALL[ALL.length - 1].id);
  eq(tierByKey('ford').key, 'ford');
  eq(tierByKey('nonsense').key, TIERS[0].key);
  eq(lotsIn('ford').every((l) => l.tier === 'ford'), true);
  eq(Object.keys(LAWS).sort(), ['ferry', 'free']);
  ok(/艄公必须在船上/.test(LAWS.ferry.rule));
  ok(/空船不许/.test(LAWS.free.note));
});

test('the daily crossing is a function of the date, so any device sees the same river', () => {
  const days = ['2026-09-27', '2026-09-28', '2026-12-31', '2027-01-01', '2026-03-14'];
  for (const day of days) {
    const first = dailyLot(day);
    ok(first, `${day} resolved to nothing`);
    eq(dailyLot(day).id, first.id, `${day} is not stable`);
    eq(hashSeed(`daily|${day}`) % ALL.length, ALL.indexOf(first), `${day} did not come from the seed`);
  }
  const spread = new Set(days.map((d) => dailyLot(d).id));
  ok(spread.size >= 3, `the daily picker only ever offered ${spread.size} distinct crossings`);
});

test('a shared random link stays in its band and repeats itself', () => {
  for (const t of TIERS) {
    const lot = randomLot('fixedseed', t.key);
    eq(lot.tier, t.key);
    eq(randomLot('fixedseed', t.key).id, lot.id);
    eq(randomLot('another-seed', t.key).tier, t.key, `${t.key} escaped its band`);
    ok(lot.par >= t.min && lot.par <= t.max, `${t.key} lot par ${lot.par} outside ${t.min}-${t.max}`);
  }
  const all = randomLot('x', null);
  ok(all && all.id, 'a band-less random pick found nothing');
});

test('the pool carries no compiled state that a second compile would change', () => {
  for (const lot of ALL) {
    const again = compile(lot.spec);
    eq(again.startMask, lot.comp.startMask, `${lot.id} start line`);
    eq(again.startBank, lot.comp.startBank, `${lot.id} boat start`);
    eq(again.rule, lot.comp.rule, `${lot.id} law`);
    eq(again.capacity, lot.comp.capacity, `${lot.id} capacity`);
    eq(again.pairs, lot.comp.pairs, `${lot.id} conflicts`);
  }
});

run();
