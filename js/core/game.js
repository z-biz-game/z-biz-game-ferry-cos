// A game in progress: pure state plus the rules that touch it. No DOM anywhere in here, which
// is what lets test/game.test.mjs and tools/playtest.mjs drive the same object the screen does.
//
// Two things are deliberately separate:
//
//   * the *state* — (bank, mask) — only changes when the boat actually crosses, and every state
//     the player ever stands in is conflict-free, because depart() refuses to create one;
//   * the *loading* — who is standing in the boat waiting to go. Dragging roles in and out costs
//     nothing and is checked against capacity and reachability only. The crossing itself is one
//     single trip and exactly one move.

import {
  compile, bankOf, cross, stateConflict, solvedState, FERRY,
} from './river.js';
import { bestCrossing } from './solve.js';

export function createGame(lot) {
  const comp = lot.comp || compile(lot.spec);
  return {
    id: lot.id,
    tier: lot.tier,
    par: lot.par,
    routes: lot.routes,
    comp,
    startMask: comp.startMask,
    startBank: comp.startBank,
    mask: comp.startMask,
    bank: comp.startBank,
    boat: [], // role ids standing in the boat, not yet cast off
    moves: 0,
    history: [],
    done: false,
    fault: null,
  };
}

export function cargoMask(game) {
  let m = 0;
  for (const id of game.boat) m |= 1 << id;
  return m;
}

export function aboard(game, id) {
  return game.boat.indexOf(id) >= 0;
}

// Why a role cannot step into the boat right now, or null when it can. The view asks this to
// decide what to draw under a finger; the rule answer comes from here, never from the view.
export function boardFault(game, id) {
  const { comp } = game;
  if (game.done) return 'done';
  if (id < 0 || id >= comp.n) return 'none';
  if (aboard(game, id)) return 'aboard';
  if (game.boat.length >= comp.capacity) return 'over';
  if (bankOf(game.mask, id) !== game.bank) return 'far';
  return null;
}

// Load one role. Never counts a move.
export function board(game, id) {
  const fault = boardFault(game, id);
  if (fault) {
    game.fault = { why: fault, id };
    return { ok: false, why: fault, id };
  }
  game.boat.push(id);
  game.fault = null;
  return { ok: true, id, boat: game.boat.slice() };
}

export function unboard(game, id) {
  const at = game.boat.indexOf(id);
  if (at < 0 || game.done) return false;
  game.boat.splice(at, 1);
  game.fault = null;
  return true;
}

// Put a whole cargo list in the boat, for replaying a searched route.
export function loadBoat(game, ids) {
  game.boat = [];
  for (const id of ids) {
    if (boardFault(game, id)) return false;
    game.boat.push(id);
  }
  return true;
}

// Cast off. This is the only place a move is ever counted.
export function depart(game) {
  if (game.done) return { ok: false, why: 'done' };
  const { comp } = game;
  const stale = stateConflict(comp, game.mask);
  if (stale) {
    game.fault = { why: 'already', conflict: stale };
    return { ok: false, why: 'already', conflict: stale };
  }
  const cargo = cargoMask(game);
  const r = cross(comp, game.mask, game.bank, cargo);
  if (!r.ok) {
    game.fault = r;
    return r; // { ok:false, why:'ferry'|'empty'|'over'|'far'|'conflict', conflict?, where? }
  }
  game.history.push({ mask: game.mask, bank: game.bank, cargo: r.cargo, moves: game.moves });
  game.mask = r.mask;
  game.bank = r.bank;
  game.moves++;
  game.boat = [];
  game.fault = null;
  if (solvedState(comp, game.mask, game.bank)) game.done = true;
  return { ok: true, cargo: r.cargo, bank: r.bank, moves: game.moves, done: game.done };
}

// One searched single trip, staged and cast off through the same door a finger uses.
export function applyCrossing(game, cargo) {
  if (!loadBoat(game, cargo)) return { ok: false, why: 'stage' };
  return depart(game);
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  game.mask = last.mask;
  game.bank = last.bank;
  game.moves = last.moves;
  game.boat = [];
  game.done = false;
  game.fault = null;
  return true;
}

export function reset(game) {
  game.mask = game.startMask;
  game.bank = game.startBank;
  game.boat = [];
  game.moves = 0;
  game.history = [];
  game.done = false;
  game.fault = null;
}

// Who is standing where, for the shell and the view.
export function standing(game) {
  const { comp } = game;
  const banks = [[], []];
  for (let i = 0; i < comp.n; i++) banks[bankOf(game.mask, i)].push(i);
  return { left: banks[0], right: banks[1], boat: game.boat.slice(), bank: game.bank };
}

// The searched answer from wherever the player stands: which ids to load, and how many single
// trips are left if they do. `left` is what the panel prints.
export function hint(game) {
  if (game.done) return null;
  const h = bestCrossing({ comp: game.comp }, { mask: game.mask, bank: game.bank, limit: 40000 });
  if (!h) return null;
  return { cargo: h.cargo, left: h.par, needsBoatman: game.comp.rule === FERRY };
}

// Trips used against the certified par. The three grades the win card prints are defined here
// rather than in markup so the tests can assert on them.
export function grade(game) {
  const over = game.moves - game.par;
  if (over <= 0) return { key: 'perfect', label: '分毫不差', stars: 3 };
  if (over <= 2) return { key: 'clean', label: '稳操渡桨', stars: 2 };
  return { key: 'wandering', label: '曲折抵达', stars: 1 };
}
