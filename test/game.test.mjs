// The game-in-progress object. This is where the spec's UI contract is actually decided: loading
// the boat is free, casting off is the only thing that bills a single trip, and a refused trip
// changes nothing at all — not the count, not the banks, not who is standing in the boat.

import { test, eq, ok, run } from '../tools/harness.mjs';
import { createGame, board, unboard, aboard, boardFault, loadBoat, depart, applyCrossing, undo, reset, standing, hint, grade, cargoMask } from '../js/core/game.js';
import { solve } from '../js/core/solve.js';
import { compile, crossings, LEFT, RIGHT } from '../js/core/river.js';
import { WGC, PAIR, missionaries } from './fixture.mjs';
import { ALL } from '../js/core/library.js';

const freeLot = missionaries(2, 'free', 3);
const freeRating = solve(freeLot);

const lotOf = (spec, extra) => Object.assign({ id: 'x', tier: 'test', par: null, routes: null, spec }, extra);
const fresh = (spec) => {
  const r = solve(spec);
  ok(r.ok, 'the fixture this game is built from is unsolvable');
  return createGame(lotOf(spec, { par: r.par, routes: r.routes }));
};

// Every cargo the rules would accept right now — what the search thinks a turn is worth.
const loadingsOf = (g) => crossings(g.comp, g.mask, g.bank).map((r) => r.cargo);

test('boarding is free: three failed attempts and two loadings still bill nothing', () => {
  const g = fresh(WGC);
  eq(board(g, 0).ok, true);
  eq(board(g, 2).ok, true);
  eq(board(g, 3).ok, false, 'the boat of two already holds two');
  eq(boardFault(g, 1), 'over');
  eq(board(g, 1).why, 'over');
  eq(board(g, 1).ok, false);
  eq(board(g, 99).why, 'none', 'a role that does not exist is not a move either');
  eq(g.moves, 0);
  eq(g.boat, [0, 2]);
  eq(cargoMask(g), (1 << 0) | (1 << 2));
});

test('a role on the far bank cannot be drafted, and the fault says why', () => {
  const g = fresh(WGC);
  applyCrossing(g, [0, 2]); // 艄公 + 羊 over
  eq(g.bank, RIGHT);
  eq(boardFault(g, 1), 'far', '狼 is still on the near bank while the boat is at the far one');
  eq(board(g, 1).ok, false);
  eq(boardFault(g, 2), null, '羊 is right here with the boatman and can sail again');
  eq(standing(g), { left: [1, 3], right: [0, 2], boat: [], bank: RIGHT });
  eq(g.moves, 1);
});

test('the boatman crossing alone is a legal trip and bills exactly one single trip', () => {
  const g = fresh(WGC);
  ok(applyCrossing(g, [0, 2]).ok, 'the first trip of the classic failed');
  eq(g.moves, 1);
  // Step 2 of the hand-written fixture: he rows back with an empty boat. The loading is legal by
  // the ferry law (a boatman aboard is enough) and the banks are safe on both sides.
  ok(loadBoat(g, [0]), 'the ferry law refused a boat with only its boatman in it');
  const r = depart(g);
  eq(r.ok, true);
  eq(r.why, undefined);
  eq(g.moves, 2, 'the return trip is a single trip and counts, empty boat or not');
  eq(r.bank, LEFT);
  eq(g.boat, [], 'the boat empties when it casts off');
  // Under the same law the boatman may also take a passenger; that is step 3.
  eq(loadBoat(g, [0, 1]), true);
  eq(depart(g).ok, true);
  eq(g.moves, 3);
});

test("the free law refuses an empty boat and the count does not move", () => {
  const g = fresh(freeLot);
  eq(g.comp.rule, 'free');
  eq(loadBoat(g, []), true);
  const r = depart(g);
  eq(r.ok, false);
  eq(r.why, 'empty');
  eq(g.moves, 0);
  eq(g.bank, LEFT);
  // One passenger is not enough here — not because of the boat law but because the bank he leaves
  // behind then loses the balance; a 教 and a 野 together is the legal opening trip.
  eq(loadBoat(g, [0]), true);
  eq(depart(g).ok, false, 'a solo 传教士 strands two 野人 with one 传教士 behind');
  eq(g.moves, 0);
  eq(loadBoat(g, [0, 2]), true);
  eq(depart(g).ok, true);
  eq(g.moves, 1);
});

test('an over-loaded boat shakes instead of counting', () => {
  const g = fresh(WGC);
  g.boat = [0, 1, 2]; // the view's own loader refuses the third passenger, so forge the state
  eq(boardFault(g, 3), 'over');
  const r = depart(g);
  eq(r.ok, false);
  eq(r.why, 'over');
  eq(g.moves, 0);
  eq(g.boat.length, 3, 'a refused trip keeps the player\'s loading intact so they can fix it');
});

test('a trip that would strand a conflict is refused and names the two roles that come to harm', () => {
  const g = fresh(WGC);
  ok(loadBoat(g, [0, 1]), 'the boatman + 狼 loading is itself legal');
  const r = depart(g);
  eq(r.ok, false);
  eq(r.why, 'conflict');
  eq(r.where, 'departure');
  eq(r.conflict.roles, [2, 3]);
  eq(r.conflict.bank, LEFT);
  ok(/羊|菜/.test(r.conflict.why), r.conflict.why);
  eq(g.fault, r, 'the fault the view reads must be the refusal the rules issued');
  eq(g.moves, 0);
});

test('the majority refusal reports the counts, not just a nameless no', () => {
  const g = fresh(freeLot); // 2 教 / 2 野, boat of three, no boatman
  ok(loadBoat(g, [0]));
  const r = depart(g);
  eq(r.ok, false);
  eq(r.conflict.type, 'majority');
  eq(r.conflict.strong, 2);
  eq(r.conflict.weak, 1);
  eq(r.conflict.bank, LEFT);
  eq(g.moves, 0);
});

test('unboard takes a passenger back out and still bills nothing', () => {
  const g = fresh(WGC);
  board(g, 0);
  board(g, 3);
  eq(unboard(g, 3), true);
  eq(aboard(g, 3), false);
  eq(g.boat, [0]);
  eq(unboard(g, 3), false, 'unboarding someone not aboard is not a thing');
  eq(g.moves, 0);
});

test('the certified route of every baked lot replays through board+depart, one move per trip', () => {
  let checked = 0;
  for (const lot of ALL) {
    const g = createGame(lot);
    const route = solve({ comp: lot.comp }).route;
    eq(route.length, lot.par, `${lot.id}: the route does not have par steps`);
    for (const step of route) {
      const r = applyCrossing(g, step.cargo);
      ok(r.ok, `${lot.id} rejected its own certified step ${step.cargo.join('+')}: ${r.why}`);
    }
    eq(g.moves, lot.par, lot.id);
    eq(g.done, true, lot.id);
    eq(standing(g).left, [], lot.id);
    checked++;
  }
  eq(checked, ALL.length);
  ok(ALL.length >= 24, 'the shipped pool shrank below the size the docs quote');
});

test('undo walks the trip back, boat and count included, and un-done clears the win', () => {
  const g = fresh(WGC);
  applyCrossing(g, [0, 2]);
  applyCrossing(g, [0]);
  const mid = standing(g);
  eq(g.moves, 2);
  eq(undo(g), true);
  eq(g.moves, 1);
  eq(standing(g).bank, RIGHT);
  eq(undo(g), true);
  eq(g.moves, 0);
  eq(standing(g), { left: [0, 1, 2, 3], right: [], boat: [], bank: LEFT });
  eq(undo(g), false, 'undoing past the start line');
  applyCrossing(g, [0, 2]);
  g.done = true;
  eq(undo(g), true);
  eq(g.done, false);
  eq(mid.bank, LEFT, 'the boatman rowed home, so the boat lies at the near bank');
});

test('reset returns to the start line and clears the boat, the fault and the card', () => {
  const g = fresh(WGC);
  applyCrossing(g, [0, 2]);
  board(g, 1);
  g.fault = { why: 'test' };
  reset(g);
  eq(g.moves, 0);
  eq(g.boat, []);
  eq(g.fault, null);
  eq(g.done, false);
  eq(standing(g).left, [0, 1, 2, 3]);
  eq(g.history.length, 0);
});

test('playing to par wins with three stars; wasted round trips cost stars, not the win', () => {
  const certified = [[0, 1], [0], [0, 2]]; // three trips: 狼 over, boatman back, 羊 over
  const wasted = [[0, 2], [0, 2]]; // 羊 out and home again: legal, and worth nothing
  const play = (g, list) => {
    for (const cargo of list) {
      const r = applyCrossing(g, cargo);
      ok(r.ok, `${cargo.join('+')} was refused: ${r.why}`);
    }
    return g;
  };
  const a = play(fresh(PAIR), certified);
  eq(a.done, true);
  eq(a.moves, 3);
  eq(a.par, 3);
  eq(grade(a).stars, 3);
  eq(grade(a).key, 'perfect');
  const b = play(fresh(PAIR), wasted.concat(certified));
  eq(b.done, true);
  eq(b.moves, 5);
  eq(grade(b).key, 'clean');
  eq(grade(b).stars, 2);
  const c = play(fresh(PAIR), wasted.concat(wasted, certified));
  eq(c.done, true);
  eq(c.moves, 7);
  eq(grade(c).key, 'wandering');
  eq(grade(c).stars, 1);
});

test('the hint is the searched next trip from wherever the player stands, and says how is left', () => {
  const g = fresh(WGC);
  eq(hint(g).cargo, [0, 2]);
  eq(hint(g).left, 7);
  eq(hint(g).needsBoatman, true);
  applyCrossing(g, [0, 2]);
  const h = hint(g);
  eq(h.cargo, [0]);
  eq(h.left, 6, 'after one trip of a seven-trip answer, six must remain');
  applyCrossing(g, [0]);
  eq(hint(g).left, 5);
});

test('a hint from a position with no way out says so instead of inventing a trip', () => {
  // M&C 3+3 with a boatman aboard a two-seat boat is the last row of the anchor table: unsolvable.
  // The hint runs the same search, so it must come back empty rather than point at a trip.
  const dead = missionaries(3, 'ferry');
  const g = createGame(lotOf(dead, { par: -1, routes: 0 }));
  eq(solve(dead).ok, false);
  eq(hint(g), null);
  eq(g.moves, 0);
  // And the search from one trip into the classic agrees with the count on screen.
  const w = fresh(WGC);
  eq(loadingsOf(w).length, 1, 'the first trip of 狼羊菜 is forced, not merely optimal');
  eq(loadingsOf(w)[0], [0, 2]);
  applyCrossing(w, [0, 2]);
  eq(hint(w).left, 6);
});

test('depart refuses to run from a state that is already lost, rather than hiding it', () => {
  const g = fresh(WGC);
  g.mask = compile(WGC).startMask & ~(1 << 0); // stand in the lost position by hand: 狼+羊 unsupervised
  g.bank = RIGHT;
  const r = depart(g);
  eq(r.ok, false);
  eq(r.why, 'already');
  eq(g.moves, 0);
});

test('a finished lot takes no more loadings and no more trips', () => {
  const g = fresh(PAIR);
  for (const cargo of [[0, 1], [0], [0, 2]]) applyCrossing(g, cargo);
  eq(g.done, true);
  eq(board(g, 1).why, 'done');
  eq(depart(g).why, 'done');
  eq(unboard(g, 1), false);
  eq(g.moves, 3);
});

test('the game object borrows the compiled cast instead of mutating it', () => {
  const lot = ALL[0];
  const before = JSON.stringify({ ...lot.comp, cls: Array.from(lot.comp.cls), pair: Array.from(lot.comp.pair) });
  const g = createGame(lot);
  eq(g.comp === lot.comp, true, 'createGame recompiled a cast that was handed to it');
  for (const step of solve({ comp: lot.comp }).route) applyCrossing(g, step.cargo);
  eq(JSON.stringify({ ...lot.comp, cls: Array.from(lot.comp.cls), pair: Array.from(lot.comp.pair) }), before);
  eq(g.done, true);
});

run();
