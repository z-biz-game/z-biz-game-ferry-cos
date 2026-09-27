// The shipped lot pool. The game picks levels from here and never generates them — that is a
// measured decision, not a style: the top band needs a few hundred thousand BFS states of
// probing before the search agrees a level is worth playing, so it happens at build time in
// tools/bake.mjs. See DESIGN.md 3.3 for the acceptance numbers.
//
// Everything below is a pure lookup over js/data/lots.js, which is why the daily puzzle and a
// shared link reproduce the same crossing on any device: the pool is fixed and the seed only
// chooses an index.
//
// Two fields of every row are load-bearing for this game's claim:
//   * `par` was measured by js/core/solve.js at bake time and re-measured from the serialized
//     spec by test/library.test.mjs — a hand-edit to the data file breaks that test;
//   * `law` ('ferry' | 'free') is the boat's law, which changes the answer of an *identical*
//     cast from 11 single trips to unsolvable. It is printed on screen, never inferred.

import { LOTS, TIERS_META } from '../data/lots.js';
import { compile } from './river.js';
import { hashSeed } from './rng.js';

// Display-side tier list (label / blurb / measured band). The generation-side ladder with its
// search budgets lives in make.js and is not needed once the lots are baked.
export const TIERS = TIERS_META;

// The two boat laws in the words the panel and the README print. Kept next to the data because
// the spec demands the law be visible rather than implied.
export const LAWS = {
  ferry: {
    key: 'ferry',
    name: '艄公船',
    rule: '艄公必须在船上，另可载 0..capacity-1 名乘客',
    note: '艄公独自过河合法（狼羊菜的第 2 步就是它）',
  },
  free: {
    key: 'free',
    name: '自由船',
    rule: '没有艄公，船上 1..capacity 人任意组合',
    note: '空船不许开；任何一岸都按无人监管判冲突',
  },
};

export function lawOf(law) {
  return LAWS[law] || LAWS.ferry;
}

const prepared = LOTS.map((row) => ({
  id: row.id,
  tier: row.tier,
  order: row.order,
  title: row.spec.title,
  par: row.par,
  routes: row.routes,
  states: row.states,
  roles: row.roles,
  capacity: row.capacity,
  law: row.law,
  risk: row.risk,
  edges: row.edges,
  spec: row.spec,
  comp: compile(row.spec),
}));

export const ALL = prepared;

function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function lotsIn(key) {
  return prepared.filter((l) => l.tier === key);
}

export function byId(id) {
  return prepared.find((l) => l.id === id) || null;
}

// The campaign: every baked lot, lowest band first and within a band the measured single-trip
// count ascending — which is exactly the order tools/bake.mjs wrote them in, and the order
// test/library.test.mjs re-proves is nondecreasing.
export function campaign() {
  return prepared;
}

export function levelAt(index) {
  return prepared[((index % prepared.length) + prepared.length) % prepared.length];
}

// Endless play in one band. A seed picks, so a shared `#/random/<tier>/<token>` link is the same
// crossing for everyone.
export function randomLot(seed, tierKey) {
  const list = tierKey ? lotsIn(tierKey) : prepared;
  return pick(list, seed, 'random');
}

// One crossing per calendar day, the same for everyone.
export function dailyLot(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

// What the shipped pool actually contains, measured rather than claimed: the bake prints this and
// the harness prints it again, so a re-bake that quietly loses difficulty shows up as a changed
// band. `parMed` is here because a band where every lot lands on the same number is one level
// wearing six costumes; min/max alone cannot see that. `ferry`/`free` count the two boat laws
// separately for the same reason — §3 of the spec wants the law mix visible per band.
export function stats() {
  const byTier = {};
  for (const l of prepared) {
    const s = byTier[l.tier] || (byTier[l.tier] = {
      n: 0, parMin: Infinity, parMax: 0, rolesMin: Infinity, rolesMax: 0,
      statesMin: Infinity, statesMax: 0, pars: [], states: [], ferry: 0, free: 0, pair: 0, majority: 0,
    });
    s.n++;
    if (l.par < s.parMin) s.parMin = l.par;
    if (l.par > s.parMax) s.parMax = l.par;
    if (l.roles < s.rolesMin) s.rolesMin = l.roles;
    if (l.roles > s.rolesMax) s.rolesMax = l.roles;
    if (l.states < s.statesMin) s.statesMin = l.states;
    if (l.states > s.statesMax) s.statesMax = l.states;
    s.pars.push(l.par);
    s.states.push(l.states);
    s[l.law]++;
    s[l.risk]++;
  }
  for (const s of Object.values(byTier)) {
    s.pars.sort((a, b) => a - b);
    s.states.sort((a, b) => a - b);
    s.parMed = median(s.pars);
    s.statesMed = median(s.states);
    delete s.pars;
    delete s.states;
  }
  return { lots: prepared.length, byTier };
}
