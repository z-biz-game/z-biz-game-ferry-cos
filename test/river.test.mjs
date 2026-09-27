// The model layer: the timing of the safety check, the two boat laws, the validator, and the
// (bank, mask) encoding. Each clause of the timing table in 规格 §1 gets a positive and a negative
// example here, because every one of them is a place where a plausible-looking implementation is
// wrong: judging the *old* state instead of the new one, exempting the arrival bank under 'free',
// or letting the boatman supervise a bank he has already left.

import { test, eq, ok, run } from '../tools/harness.mjs';
import {
  compile, toSpec, validate, signature, stateIndex, stateAt, idsOf, countBits, bankOf, bankMask,
  isOn, supervised, conflictOnBank, stateConflicts, stateConflict, isSafe, loadingFault, eachCargo,
  eachSubset, eachCrossing, nextMask, cross, crossings, solvedState, cargoIds, LEFT, RIGHT, FERRY,
  FREE, MAX_ROLES,
} from '../js/core/river.js';
import { solve } from '../js/core/solve.js';
import { WGC, PAIR, missionaries } from './fixture.mjs';

const wgc = compile(WGC);            // 0 艄公, 1 狼, 2 羊, 3 菜; pairs 狼-羊, 羊-菜
const goat = compile(missionaries(2, 'free', 3)); // 0,1 传教士 / 2,3 野人, no boatman
const pairLaw = compile(missionaries(2, 'ferry', 2)); // 0 艄公 / 1,2 传教士 / 3,4 野人

// A mask lists who is still on the LEFT bank — that is what the bit means, and every hand-written
// mask in this file is spelled through this helper rather than as a literal so that a reader (and
// the author, the first time round) cannot invert it by accident.
const M = (...ids) => ids.reduce((m, i) => m | (1 << i), 0);

// --- who is watching ---------------------------------------------------------------------

test('under the ferry law the boatman supervises the bank he stands on and only that one', () => {
  eq(supervised(wgc, M(0, 1, 2, 3), LEFT), true);
  eq(supervised(wgc, M(0, 1, 2, 3), RIGHT), false);
  eq(supervised(wgc, M(1, 3), RIGHT), true, 'a boatman who crossed must supervise the arrival bank');
  eq(supervised(wgc, M(1, 3), LEFT), false, 'he cannot supervise the bank he has left');
});

test("under the free law no bank is ever supervised, even the one a 'ferry' cast would call home", () => {
  // Written out rather than falling out of a missing index: this line *is* the difference between
  // the two laws. A comp built by hand with a boatman but the free law still supervises nobody.
  const faked = compile({
    ...missionaries(1, 'ferry', 2),
    boat: { rule: FREE, capacity: 2 },
    roles: missionaries(1, 'ferry', 2).roles,
  });
  eq(faked.ferryman, 0);
  eq(supervised(faked, 0b111, LEFT), false);
  eq(supervised(faked, 0b111, RIGHT), false);
  eq(supervised(goat, 0b1111, LEFT), false);
});

test('a supervised bank with a live conflict on it is safe; unsupervised it is fatal', () => {
  const both = M(0, 1, 2, 3); // 狼 and 羊 together on the left, boatman there too
  eq(conflictOnBank(wgc, both, LEFT).roles, [1, 2]);
  eq(stateConflict(wgc, both), null, 'the boatman is present, so nothing happens');
  const away = M(1, 2); // the boatman has crossed; 狼 and 羊 are alone with each other
  eq(supervised(wgc, away, LEFT), false);
  eq(conflictOnBank(wgc, away, LEFT).roles, [1, 2]);
  eq(stateConflict(wgc, away).roles, [1, 2]);
  eq(isSafe(wgc, away), false);
});

test('majority is strict, and a bank of nothing but 野人 is dull rather than fatal', () => {
  // ids: 0,1 传教士 / 2,3 野人. The mask lists the left bank; the right bank is its complement.
  eq(conflictOnBank(goat, M(0, 1, 2, 3), RIGHT), null, 'nothing has crossed over yet');
  eq(conflictOnBank(goat, M(0, 1), RIGHT), null, 'two 野人 alone on the far bank: nobody to outnumber');
  eq(conflictOnBank(goat, M(1), RIGHT).strong, 2, 'one 传教士 with two 野人 over there');
  eq(conflictOnBank(goat, M(1), RIGHT).weak, 1);
  eq(conflictOnBank(goat, M(3), RIGHT), null, 'one 野人 to two 传教士 is not yet a loss');
  eq(conflictOnBank(goat, M(1, 3), RIGHT), null, 'one apiece is a stand-off');
  eq(conflictOnBank(goat, M(1, 2, 3), LEFT).bank, LEFT, 'the same balance tipped on the near bank');
});

test('every bank that is not supervised gets reported by stateConflicts', () => {
  const r = stateConflicts(wgc, M(1, 2)); // 狼+羊 unsupervised left, 艄公+菜 supervised right
  eq(r.length, 1);
  eq(r[0].bank, LEFT);
  eq(stateConflicts(wgc, M(0, 1, 2, 3)), []);
});

// --- the timing of the check, four moments ------------------------------------------------

test('moment 1, departure bank: a crossing that strands 狼 with 羊 is refused', () => {
  const r = cross(wgc, 0b1111, LEFT, (1 << 0) | (1 << 1));
  eq(r.ok, false);
  eq(r.why, 'conflict');
  eq(r.where, 'departure');
  eq(r.conflict.bank, LEFT);
  eq(r.conflict.roles, [2, 3], 'the refusal must name 羊 and 菜, not the pair aboard');
});

test('moment 1, positive control: the same trip with 羊 instead of 菜 goes', () => {
  const r = cross(wgc, M(0, 1, 2, 3), LEFT, (1 << 0) | (1 << 2));
  eq(r.ok, true);
  eq(r.bank, RIGHT);
  eq(r.mask, M(1, 3), '狼 and 菜 are alone together, which is nothing to worry about');
});

test('moment 2, arrival bank under the ferry law: the boatman supervises it, so a pair may land', () => {
  // 狼 is already on the right bank alone (mask 0b1101: 艄公, 羊 and 菜 on the left). Bringing 羊
  // over with the boatman puts 狼 and 羊 together there — legal, because he stands on that bank.
  const r = cross(wgc, 0b1101, LEFT, (1 << 0) | (1 << 2));
  eq(r.ok, true);
  eq(r.mask, 0b1000);
  eq(supervised(wgc, r.mask, RIGHT), true);
  eq(conflictOnBank(wgc, r.mask, RIGHT).roles, [1, 2]);
  eq(isSafe(wgc, r.mask), true);
});

test('moment 3, arrival bank under the free law: nobody supervises it, so the same landing dies', () => {
  // Both 野人 are on the right (mask 0b0011); sending one 传教士 over makes it 2 野 : 1 教 there.
  const r = cross(goat, 0b0011, LEFT, 1 << 0);
  eq(r.ok, false);
  eq(r.why, 'conflict');
  eq(r.where, 'arrival');
  eq(r.conflict.bank, RIGHT);
  eq(r.conflict.type, 'majority');
  eq(r.conflict.strong, 2);
  eq(r.conflict.weak, 1);
  // Two 传教士 at once is the same arrival bank with the balance held: legal.
  eq(cross(goat, 0b0011, LEFT, (1 << 0) | (1 << 1)).ok, true);
});

test('moment 4, the loading is judged before the banks: an overloaded boat says over, not conflict', () => {
  // The start state of this cast is full of pairs and still safe, because the boatman is standing
  // in it — a solver that judged the state as it stands *before* the trip would refuse everything.
  eq(isSafe(wgc, 0b1111), true);
  eq(cross(wgc, 0b1111, LEFT, (1 << 0) | (1 << 2)).ok, true, 'the classic first trip was refused');
  // Boatman + 狼 + 羊 is both an over-load and, on the left bank, a stranded 羊-菜 pair. The
  // order matters for what the UI prints, and over-load is checked first.
  eq(cross(wgc, 0b1111, LEFT, (1 << 0) | (1 << 1) | (1 << 2)).why, 'over');
  eq(cross(wgc, 0b1111, LEFT, (1 << 1) | (1 << 2)).why, 'ferry');
  eq(cross(wgc, 0b1111, LEFT, (1 << 0) | (1 << 1) | (1 << 3)).why, 'over');
});

test('the departure bank of a free-law trip is judged too, and judged as unsupervised', () => {
  // Everyone starts on the left: 2 教 and 2 野. Sending one 传教士 over leaves 1 教 with 2 野 on
  // the bank the boat just quit — fatal under the free law, because there is nobody to watch it.
  const r = cross(goat, 0b1111, LEFT, 1 << 0);
  eq(r.ok, false);
  eq(r.why, 'conflict');
  eq(r.where, 'departure');
  eq(r.conflict.bank, LEFT);
  eq(r.conflict.strong, 2);
  eq(r.conflict.weak, 1);
  // Under the ferry law the departure bank is judged by exactly the same rule and the boatman
  // cannot rescue it — he is on the boat. M&C 2+2 with a boatman: taking 野人1 over leaves a
  // balanced 2教:1野 behind, which passes, where 1教:2野 would not.
  eq(cross(pairLaw, pairLaw.startMask, LEFT, (1 << 0) | (1 << 3)).ok, true);
  eq(cross(pairLaw, 0b11111, LEFT, (1 << 0) | (1 << 1)).ok, false);
});

// --- loadings ------------------------------------------------------------------------------

test("the ferry law accepts the boatman alone and refuses a boat he is not on", () => {
  eq(loadingFault(wgc, 0b1111, LEFT, 1 << 0), null);
  eq(loadingFault(wgc, 0b1111, LEFT, 0), 'ferry');
  eq(loadingFault(wgc, 0b1111, LEFT, 1 << 1), 'ferry');
  eq(loadingFault(wgc, 0b1111, LEFT, (1 << 0) | (1 << 1) | (1 << 2)), 'over');
  eq(loadingFault(wgc, 0b1011, LEFT, (1 << 0) | (1 << 2)), 'far', '羊 is on the far bank, not aboard-able here');
});

test("the free law refuses an empty boat and accepts a full one", () => {
  eq(loadingFault(goat, 0b1111, LEFT, 0), 'empty');
  eq(loadingFault(goat, 0b1111, LEFT, 1 << 0), null);
  eq(loadingFault(goat, 0b1111, LEFT, (1 << 0) | (1 << 1) | (1 << 2)), null, 'capacity 3');
  eq(loadingFault(goat, 0b1111, LEFT, 0b1111), 'over');
});

test("every cargo the ferry law offers carries the boatman and fits the boat", () => {
  const seen = [];
  eachCargo(wgc, 0b1111, LEFT, (c) => seen.push(cargoIds(wgc, c)));
  eq(seen, [[0], [0, 1], [0, 2], [0, 3]], 'a capacity-2 boatman boat has exactly four loadings');
  eq(seen.every((ids) => ids[0] === 0), true);
  eq(seen.every((ids) => ids.length <= wgc.capacity), true);
  // With fewer people on the bank than the boat holds, the boatman still cannot take an absent role.
  eq(seen.length, 4);
  const ashore = [];
  eachCargo(wgc, 0b1010, RIGHT, (c) => ashore.push(cargoIds(wgc, c)));
  eq(ashore, [[0], [0, 2]], 'the boatman has 羊 with him at the far bank and 狼+菜 behind');
});

test("every cargo the free law offers is non-empty and never bigger than the boat", () => {
  const seen = [];
  eachCargo(goat, 0b1111, LEFT, (c) => seen.push(c));
  eq(seen.some((c) => c === 0), false, 'an empty boat must never be offered under the free law');
  eq(seen.every((c) => countBits(c) >= 1 && countBits(c) <= goat.capacity), true);
  eq(seen.length, 14, 'four roles aboard a boat of three: 4 + 6 + 4 loadings');
  const onlyTwo = [];
  eachCargo(goat, 0b0011, LEFT, (c) => onlyTwo.push(c));
  eq(onlyTwo.length, 3, 'two roles, boat of three: 2 singles and 1 pair');
});

test('eachCrossing and crossings agree, and crossings only carries legal trips', () => {
  const all = [];
  eachCrossing(wgc, 0b1011, LEFT, (cargo, nm) => all.push([cargo, nm]));
  const legal = crossings(wgc, 0b1011, LEFT);
  ok(all.length >= legal.length);
  eq(legal.every((r) => r.ok), true);
  eq(legal.length, 3, 'with 狼 and 菜 ashore and 羊 delivered, the boatman may take 狼, 菜 or nobody');
});

test('nextMask moves a cargo across and never leaks bits outside the cast', () => {
  eq(nextMask(wgc, M(0, 1, 2, 3), LEFT, (1 << 0) | (1 << 2)), M(1, 3));
  eq(nextMask(wgc, M(1, 3), RIGHT, (1 << 0) | (1 << 2)), M(0, 1, 2, 3));
  eq(nextMask(wgc, M(1, 3), RIGHT, 0b111111), M(0, 1, 2, 3), 'a cargo with bits above the cast cannot widen the mask');
  eq(nextMask(wgc, M(0, 1, 2, 3), LEFT, 0), M(0, 1, 2, 3));
});

// --- encoding ------------------------------------------------------------------------------

test('(bank, mask) <-> index round-trips over the whole space of a cast', () => {
  const comp = compile(WGC);
  eq(comp.size, 2 << comp.n);
  let checked = 0;
  for (let i = 0; i < comp.size; i++) {
    const s = stateAt(comp, i);
    eq(stateIndex(comp, s.bank, s.mask), i);
    checked++;
  }
  eq(checked, 32);
});

test('bankOf, idsOf and countBits read the mask the same way', () => {
  eq(bankOf(0b1010, 1), LEFT);
  eq(bankOf(0b1010, 0), RIGHT);
  eq(idsOf(0b1011), [0, 1, 3]);
  eq(countBits(0b1111), 4);
  eq(countBits(0), 0);
  eq(bankMask(wgc, 0b1011, RIGHT), 0b0100);
  eq(idsOf(bankMask(wgc, 0b1011, LEFT)), [0, 1, 3]);
});

test('compile -> toSpec -> compile reproduces the cast, the law and the start line', () => {
  for (const spec of [WGC, PAIR, missionaries(3, 'free'), missionaries(2, 'ferry'), missionaries(2, 'free', 3)]) {
    const a = compile(spec);
    const back = toSpec(a);
    const b = compile(back);
    eq(b.startMask, a.startMask, spec.title);
    eq(b.startBank, a.startBank);
    eq(b.rule, a.rule);
    eq(b.capacity, a.capacity);
    eq(b.ferryman, a.ferryman);
    eq(b.pairs, a.pairs);
    eq(b.name, a.name);
    eq(Array.from(b.cls), Array.from(a.cls));
    eq(Array.from(b.pair), Array.from(a.pair));
    eq(validate(back), null, 'the serialiser emitted an invalid spec');
    eq(solve(back).par, solve(spec).par, 'a round-tripped cast stopped being the same puzzle');
  }
});

test('a cast that starts with someone already across keeps them across through the round trip', () => {
  const spec = JSON.parse(JSON.stringify(WGC));
  spec.roles[3].at = RIGHT;
  const comp = compile(spec);
  eq(comp.startMask, 0b0111);
  eq(bankOf(comp.startMask, 3), RIGHT);
  eq(toSpec(comp).roles[3].at, RIGHT);
  eq(solve(spec).par, 3, '菜 is already over, so only 狼 and 羊 need ferrying');
});

test('eachSubset yields subsets in the order that fixes which route a shared link shows', () => {
  const out = [];
  eachSubset([1, 2, 4], 2, (s) => out.push(s.slice()));
  eq(out, [[], [1], [1, 2], [1, 4], [2], [2, 4], [4]]);
  eq(out.every((s) => s.length <= 2), true);
  const capped = [];
  eachSubset([1, 2, 3], 0, (s) => capped.push(s.slice()));
  eq(capped, [[]], 'a zero-passenger boat has exactly one loading: nobody');
});

test('solvedState wants everyone off the left bank *and* the boat with them', () => {
  eq(solvedState(wgc, 0, RIGHT), true);
  eq(solvedState(wgc, 0, LEFT), false, 'the boat is still on the near bank, nobody got there');
  eq(solvedState(wgc, 0b1000, RIGHT), false);
});

// --- the validator, clause by clause, each one hit by a negative ------------------------------

function broken(label, patch) {
  const spec = JSON.parse(JSON.stringify(WGC));
  patch(spec);
  return [label, spec];
}

test('validate refuses the things the generator could plausibly emit', () => {
  const cases = [
    broken('no roles at all', (s) => { s.roles = []; }),
    broken('one role is not a puzzle', (s) => { s.roles = s.roles.slice(0, 1); }),
    broken('a gap in the ids', (s) => { s.roles[2].id = 7; }),
    broken('an unknown boat law', (s) => { s.boat.rule = 'teleport'; }),
    broken('a boat that holds nobody', (s) => { s.boat.capacity = 0; }),
    broken('a fractional capacity', (s) => { s.boat.capacity = 2.5; }),
    broken('a self-conflict', (s) => { s.risk.pairs.push([1, 1]); }),
    broken('a duplicated edge', (s) => { s.risk.pairs.push([2, 1]); }),
    broken('an edge outside the cast', (s) => { s.risk.pairs.push([1, 9]); }),
    broken('the boatman conflicts with someone', (s) => { s.risk.pairs.push([0, 1]); }),
    broken('a role with four enemies', (s) => {
      s.roles.push({ id: 4, name: '鸡', short: '鸡', kind: 'beast' });
      s.roles.push({ id: 5, name: '鼠', short: '鼠', kind: 'beast' });
      s.risk.pairs.push([1, 4], [1, 5], [1, 3]);
    }),
    broken('the ferry law without a boatman', (s) => { s.roles = s.roles.filter((r) => r.cls !== 'ferryman').map((r, i) => ({ ...r, id: i })); }),
    broken('the free law with a boatman', (s) => { s.boat.rule = 'free'; }),
    broken('a pair risk with no edges', (s) => { s.risk.pairs = []; }),
    broken('an unknown risk type', (s) => { s.risk = { type: 'vibes' }; }),
    broken('a majority with one class only', (s) => {
      s.boat = { rule: 'free', capacity: 2 };
      s.risk = { type: 'majority', strong: '野人', weak: '传教士' };
      s.roles = s.roles.map((r, i) => ({ id: i, name: `野人${i}`, short: '野', kind: 'beast', cls: '野人' }));
    }),
    broken('a role of no class at all', (s) => {
      s.risk = { type: 'majority', strong: '野人', weak: '传教士' };
      s.roles[2].cls = undefined;
    }),
    broken('two class names that are the same word', (s) => {
      s.risk = { type: 'majority', strong: '人', weak: '人' };
    }),
    broken('a boat parked off the banks', (s) => { s.bank = 4; }),
    broken('more roles than the mask holds', (s) => {
      s.roles = [];
      for (let i = 0; i <= MAX_ROLES; i++) s.roles.push({ id: i, name: `r${i}`, short: 'r', kind: 'beast' });
      s.risk = { type: 'pair', pairs: [[1, 2]] };
      s.roles[0] = { id: 0, name: '艄公', short: '艄', kind: 'ferryman', cls: 'ferryman' };
    }),
  ];
  eq(cases.length >= 18, true);
  for (const [label, spec] of cases) ok(validate(spec), `"${label}" validated clean`);
  eq(validate(WGC), null, 'the hand-written classic must itself pass the gate');
  eq(validate(missionaries(3, 'free')), null);
  eq(validate(missionaries(2, 'ferry')), null);
});

test('the degree cap is about roles, not edges: six edges over four roles can still be legal', () => {
  const spec = JSON.parse(JSON.stringify(WGC));
  spec.roles.push({ id: 4, name: '鸡', short: '鸡', kind: 'beast' });
  spec.risk.pairs = [[1, 2], [2, 3], [3, 4], [1, 4]];
  eq(validate(spec), null, 'every role here has exactly two enemies');
  spec.risk.pairs.push([2, 4]);
  spec.risk.pairs.push([1, 3]);
  eq(validate(spec), null, 'three apiece is the limit and this is it');
  spec.roles.push({ id: 5, name: '鼠', short: '鼠', kind: 'beast' });
  spec.risk.pairs.push([1, 5]);
  ok(validate(spec), 'role 1 now has four enemies and the validator must say so');
  ok(/degree/.test(validate(spec)), validate(spec));
});

test('signature ignores edge order but not the boat law', () => {
  const a = JSON.parse(JSON.stringify(WGC));
  const b = JSON.parse(JSON.stringify(WGC));
  b.risk.pairs = [[2, 3], [1, 2]];
  eq(signature(a), signature(b));
  const c = JSON.parse(JSON.stringify(WGC));
  c.boat.capacity = 3;
  ok(signature(a) !== signature(c));
  const d = JSON.parse(JSON.stringify(WGC));
  d.roles = d.roles.map((r) => ({ ...r }));
  d.roles[1].at = RIGHT;
  ok(signature(a) !== signature(d), 'a cast that starts half-across is a different puzzle');
});

// --- purity ---------------------------------------------------------------------------------

test('solving does not touch the spec, the compiled cast or the caller masks', () => {
  const spec = JSON.parse(JSON.stringify(WGC));
  const frozen = JSON.stringify(spec);
  const comp = compile(spec);
  const compFace = JSON.stringify({ ...comp, pair: Array.from(comp.pair), cls: Array.from(comp.cls) });
  const startMask = comp.startMask;
  const r = solve(spec);
  eq(JSON.stringify(spec), frozen, 'solve mutated the spec it was handed');
  eq(JSON.stringify({ ...comp, pair: Array.from(comp.pair), cls: Array.from(comp.cls) }), compFace);
  eq(comp.startMask, startMask);
  ok(r.ok);
  const opts = { mask: 0b1111, bank: LEFT, limit: 1000 };
  const optsFrozen = JSON.stringify(opts);
  solve(spec, opts);
  eq(JSON.stringify(opts), optsFrozen, 'solve wrote back into its options');
  eq(stateConflict(comp, M(1, 2)).roles, [1, 2], 'the read-only helpers changed the mask');
  eq(comp.startMask, M(0, 1, 2, 3));
  eq(cross(comp, 0b1111, LEFT, 0b0001).ok, false);
  eq(comp.startMask, startMask);
});

test('the game object is the only thing that mutates, and only through board/depart/undo/reset', () => {
  const spec = JSON.parse(JSON.stringify(WGC));
  const frozen = JSON.stringify(spec);
  const comp = compile(spec);
  const cargo = 0b0011;
  eq(cargoIds(comp, cargo), [0, 1]);
  const r = cross(comp, comp.startMask, comp.startBank, cargo);
  eq(r.cargo, [0, 1]);
  eq(JSON.stringify(spec), frozen);
  eq(validate(spec), null);
});

run();
