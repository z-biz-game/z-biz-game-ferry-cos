// The anchors. Every expected number in this file was written down by a human before the code it
// tests was run — they are the external fact this repo's difficulty claim rests on, and the table
// they come from (DESIGN.md 1, 规格 §0) was measured independently on 2026-09-27.
//
// Each solvable row is checked twice: once by js/core/solve.js, and once by `layerSearch()` below,
// which is a second, deliberately naive implementation of "which (bank, mask) pairs are reachable
// in exactly d single trips" built out of a Set and a for-loop. The two agreeing means the number
// on screen is not the search engine grading its own homework: `layerSearch` proves both halves —
// that the route exists at d, and that no route exists at d-1 (its layers simply do not contain the
// goal). Likewise each unsolvable row is only accepted when a *frontier ran out*, never when a
// budget did: no clause anywhere in this repo says `if n >= 4 return false`.

import { test, eq, ok, run } from '../tools/harness.mjs';
import {
  compile, eachCargo, nextMask, isSafe, solvedState, cross, loadingFault, validate, LEFT, RIGHT,
} from '../js/core/river.js';
import { solve } from '../js/core/solve.js';
import { createGame, applyCrossing, standing, board, depart } from '../js/core/game.js';
import { WGC, WGC_ROUTE, PAIR, PAIR_ROUTE, missionaries } from './fixture.mjs';

// A second opinion on reachability: plain sets, layer by layer, no distance table.
// Returns { depth } when the goal first appears in layer `depth`, { depth: -1, exhausted: true }
// when a frontier came up empty before that, { depth: -2 } if either guard tripped.
// A state is admitted to a layer even when it *is* the goal, and the goal test happens on the way
// out of the layer loop: returning from inside the `eachCargo` callback would only have left the
// callback, and the first draft of this helper silently reported every puzzle unsolvable.
function layerSearch(spec, maxDepth = 64, maxStates = 200000) {
  const comp = compile(spec);
  const key = (bank, mask) => `${bank}:${mask}`;
  const parse = (k) => {
    const colon = k.indexOf(':');
    return { bank: Number(k.slice(0, colon)), mask: Number(k.slice(colon + 1)) };
  };
  let frontier = new Set([key(comp.startBank, comp.startMask)]);
  const seen = new Set(frontier);
  for (let depth = 0; depth <= maxDepth; depth++) {
    for (const k of frontier) {
      const s = parse(k);
      if (solvedState(comp, s.mask, s.bank)) return { depth, states: seen.size };
    }
    const next = new Set();
    for (const k of frontier) {
      const s = parse(k);
      eachCargo(comp, s.mask, s.bank, (cargo) => {
        const nm = nextMask(comp, s.mask, s.bank, cargo);
        const nb = 1 - s.bank;
        if (!isSafe(comp, nm)) return;
        const nk = key(nb, nm);
        if (seen.has(nk)) return;
        seen.add(nk);
        next.add(nk);
      });
    }
    if (!next.size) return { depth: -1, exhausted: true, states: seen.size, full: comp.size };
    if (seen.size > maxStates) return { depth: -2, states: seen.size };
    frontier = next;
  }
  return { depth: -2, states: seen.size };
}

// One row of the table: the spec, the hand-written expectation, and the two checks.
function anchor(label, spec, want) {
  const measured = solve(spec);
  const layers = layerSearch(spec);
  if (want === 'unsolvable') {
    test(`${label}: unsolvable, and only because the frontier ran out`, () => {
      eq(measured.ok, false, 'solve says solvable');
      eq(measured.truncated, false, 'the search stopped on its budget, which is not a proof');
      eq(measured.par, -1);
      eq(layers.depth, -1, 'the independent layer search found a route');
      ok(layers.exhausted, 'the layer search gave up on its guard instead of exhausting');
      ok(layers.states > 1, 'nothing was explored at all');
      ok(layers.states < layers.full, 'the whole state space was reachable, so the goal was too');
    });
    return measured;
  }
  test(`${label}: ${want} single trips`, () => {
    eq(measured.ok, true, 'solve says unsolvable');
    eq(measured.par, want, 'measured par differs from the hand-written table');
    eq(layers.depth, want, 'the independent layer search disagrees about the shortest route');
  });
  return measured;
}

// --- 规格 §0, row by row ---------------------------------------------------------------

const wgc = anchor('狼羊菜 (艄公必须在船, 至多再载 1)', WGC, 7);
anchor('狼羊 (ferry, cap 2) — the smallest thing this game can be', PAIR, 3);
anchor('M&C 1+1 (无艄公, 船上 1..2)', missionaries(1, 'free'), 1);
anchor('M&C 2+2 (无艄公, 船上 1..2)', missionaries(2, 'free'), 5);
anchor('M&C 3+3 (无艄公, 船上 1..2)', missionaries(3, 'free'), 11);
anchor('M&C 4+4 (无艄公, 船上 1..2)', missionaries(4, 'free'), 'unsolvable');
anchor('M&C 5+5 (无艄公, 船上 1..2)', missionaries(5, 'free'), 'unsolvable');
anchor('M&C 1+1 (艄公必须在船, 至多再载 1)', missionaries(1, 'ferry'), 3);
anchor('M&C 2+2 (艄公必须在船, 至多再载 1)', missionaries(2, 'ferry'), 7);
anchor('M&C 3+3 (艄公必须在船, 至多再载 1)', missionaries(3, 'ferry'), 'unsolvable');
anchor('M&C 4+4 (艄公必须在船, 至多再载 1)', missionaries(4, 'ferry'), 'unsolvable');

// The lesson the whole repo is built around, stated as one assertion: identical cast, identical
// conflicts, and the boat law alone moves the answer from 11 single trips to "never".
test('the boat law is gameplay, not implementation: 3+3 free = 11 while 3+3 ferry is unsolvable', () => {
  eq(solve(missionaries(3, 'free')).par, 11);
  eq(solve(missionaries(3, 'ferry')).ok, false);
  eq(validate(missionaries(3, 'free')), null);
  eq(validate(missionaries(3, 'ferry')), null);
});

// ...and the same lesson flipped: a roomier boat makes 4+4 free solvable, so no code path may
// decide "4 pairs is impossible" by counting heads.
test('the same heads are solvable under a roomier boat: 4+4 free cap 3 = 9, 4+4 ferry cap 3 = 7', () => {
  eq(solve(missionaries(4, 'free', 3)).par, 9);
  eq(solve(missionaries(4, 'ferry', 3)).par, 7);
});

// The "no special case" claim, taken to a size the table does not list: 6+6 without a boatman is
// still answered by exhausting a frontier, here after 423 reachable states of the 8192 in scope.
test('6+6 free cap 2 is unsolvable by exhaustion too (no n>=4 rule anywhere)', () => {
  const r = solve(missionaries(6, 'free'));
  const l = layerSearch(missionaries(6, 'free'));
  eq(r.ok, false);
  eq(r.truncated, false);
  eq(l.depth, -1);
  ok(l.states < l.full, `${l.states} of ${l.full}`);
});

// What a budget actually buys: the same unsolvable verdict must come back flagged as *not* a proof.
test('a search that hits its budget says truncated instead of pretending to have proved nothing', () => {
  const r = solve(missionaries(4, 'free'), { limit: 8 });
  eq(r.ok, false);
  eq(r.truncated, true, 'a starved search must not hand out an unsolvable verdict');
  const full = solve(missionaries(4, 'free'));
  eq(full.truncated, false);
  ok(full.explored > 8, 'the uncapped search barely explored more than the capped one');
});

// --- the hand-written route ------------------------------------------------------------

// WGC_ROUTE is prose turned into a cargo list by a person, in the order a person would explain it:
// take the goat, come back alone, take the wolf, bring the goat back, take the cabbage, come back
// alone, take the goat. Nothing here reads the solver's answer.
test('the seven hand-written steps of 狼羊菜 are all legal and land everyone on the right bank', () => {
  eq(WGC_ROUTE.length, 7, 'the hand-written fixture itself must be seven trips');
  const comp = compile(WGC);
  let mask = comp.startMask;
  let bank = comp.startBank;
  eq(mask, 0b1111, 'everyone starts on the left bank');
  const notes = [];
  WGC_ROUTE.forEach((step, i) => {
    const cargo = step.cargo.reduce((m, id) => m | (1 << id), 0);
    const r = cross(comp, mask, bank, cargo);
    ok(r.ok, `step ${i + 1} (${step.note}) was rejected: ${r.why}${r.conflict ? ' ' + r.conflict.why : ''}`);
    bank = r.bank;
    mask = r.mask;
    notes.push(`${i + 1}:${step.cargo.join('+')}->${bank === RIGHT ? '右' : '左'}`);
  });
  eq(solvedState(comp, mask, bank), true, notes.join(' '));
  eq(mask, 0);
  eq(bank, RIGHT);
});

test('step 2 and step 6 of 狼羊菜 are the boatman crossing alone (a first draft banned this)', () => {
  eq(WGC_ROUTE[1].cargo, [0]);
  eq(WGC_ROUTE[5].cargo, [0]);
  const comp = compile(WGC);
  // The loading itself is legal on its own terms: a boatman aboard and nobody else is a trip, not
  // a fault, under 'ferry' — regardless of who is left standing on which bank.
  eq(loadingFault(comp, 0b1111, LEFT, 1 << 0), null, '艄公独自开船 was refused as a loading');
  // And in the position where the hand route actually uses it (0b1010: 狼 and 菜 still on the left,
  // 羊 delivered, the boatman at the right bank), the whole crossing goes through.
  eq(cross(comp, 0b1010, RIGHT, 1 << 0).ok, true, 'the return trip of the classic route was refused');
  // Under the other law there is no boatman to be alone, so the same one-head boat is an empty boat.
  const free = compile(missionaries(2, 'free'));
  eq(loadingFault(free, free.startMask, LEFT, 0), 'empty');
});

test('the route the solver returns for 狼羊菜 is exactly the hand-written one', () => {
  eq(wgc.route.map((s) => s.cargo), WGC_ROUTE.map((s) => s.cargo));
  eq(wgc.routes, 2, 'the classic has two optimal answers — goat-then-wolf and goat-then-cabbage');
});

test('the smallest lot replays through the game object, one move per trip', () => {
  const game = createGame({ id: 'pair', par: 3, routes: 2, spec: PAIR });
  eq(PAIR_ROUTE.length, 3);
  for (const step of PAIR_ROUTE) ok(applyCrossing(game, step.cargo).ok, `rejected ${step.cargo}`);
  eq(game.moves, 3);
  eq(game.done, true);
  eq(standing(game).left, []);
});

test('a rejected trip leaves the count and the banks exactly where they were', () => {
  const game = createGame({ id: 'wgc', par: 7, routes: 2, spec: WGC });
  const before = standing(game);
  // 狼 and 羊 aboard with the boatman ashore: the loading is refused outright, so no bank changes
  // and — the point of this test — nothing is billed.
  eq(board(game, 1).ok, true);
  eq(board(game, 2).ok, true);
  const r = depart(game);
  eq(r.ok, false);
  eq(r.why, 'ferry');
  eq(game.moves, 0, 'a refused crossing still counted a move');
  eq(standing(game).left, before.left);
  eq(game.bank, LEFT);
});

test('the teaching refusal: a legal loading that would strand a conflict names the two roles', () => {
  const comp = compile(WGC);
  // Trip 3 in the hand route takes 狼 across. The alternative that a player tries first — ferry
  // 狼 over and leave 羊 with 菜 unsupervised on the *left* — is the same law refusing:
  // cargo {艄公,狼} from the left leaves mask 0b1010 (羊+菜), which conflicts.
  const r = cross(comp, 0b1111, LEFT, (1 << 0) | (1 << 1));
  eq(r.ok, false);
  eq(r.why, 'conflict');
  eq(r.conflict.type, 'pair');
  eq(r.conflict.roles, [2, 3]);
  eq(r.conflict.bank, LEFT);
  eq(r.where, 'departure');
});

run();
