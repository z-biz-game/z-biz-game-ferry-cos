// Layered breadth-first search over the (bank, mask) state graph. This is not a convenience:
// it is the only thing in the repo that is allowed to say "this crossing takes exactly N
// single trips" and "this cast can never be ferried over".
//
// Two things make the verdict trustworthy rather than convenient:
//
//   * "Unsolved" is only returned when the *frontier ran out* (`truncated: false`). A search
//     that hit its budget says `truncated: true` and admits it does not know. No special case
//     on the role count anywhere: 4+4 missionaries is not a rule, it is 8 reachable states with
//     no goal among them, and the same code finds the 11-trip route for 3+3.
//   * The same call also counts the number of *shortest* routes, so a level can print
//     "最优路线 2 条" as a measurement instead of a mood.
//
// The distance table is `Int16Array` rather than `Int8Array`: the state space for 12 roles is
// 8192 entries and a shortest path in a graph that size can exceed 127, which would silently
// wrap to a negative distance. Two bytes per state, no overflow, same shape.

import {
  compile, stateIndex, stateAt, eachCargo, nextMask, isSafe, solvedState, cargoIds,
} from './river.js';

// solve(spec, { mask, bank, limit }) ->
//   { ok, par, route, routes, explored, truncated }
// `route` is the ordered list of { cargo } — the ids the boat carries on each single trip — for
// one shortest route. Omitting `mask`/`bank` solves the level from its start line; passing them
// solves from wherever the player now stands, which is what the hint does.
export function solve(spec, opts = {}) {
  const limit = opts.limit || 200000;
  const comp = spec.comp || compile(spec);
  const mask = opts.mask === undefined ? comp.startMask : opts.mask & comp.total;
  const bank = opts.bank === undefined ? comp.startBank : opts.bank;
  const size = comp.size;
  const start = stateIndex(comp, bank, mask);

  const dist = new Int16Array(size).fill(-1);
  const parent = new Int32Array(size).fill(-1);
  const via = new Int32Array(size); // the cargo mask that first reached this state
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  let truncated = false;

  dist[start] = 0;
  queue[tail++] = start;

  // The whole reachable component gets a distance, not only up to the goal: the route count
  // below needs every state shallower than the goal to have been expanded. The state space is
  // at most 8192 entries, so exhaustiveness is affordable and the code stays one loop.
  while (head < tail) {
    if (tail >= limit) { truncated = true; break; }
    const cur = queue[head++];
    const s = stateAt(comp, cur);
    const d = dist[cur];
    eachCargo(comp, s.mask, s.bank, (cargo) => {
      const nm = nextMask(comp, s.mask, s.bank, cargo);
      if (!isSafe(comp, nm)) return; // whoever leaves must not be left to their own devices
      const next = stateIndex(comp, 1 - s.bank, nm);
      if (dist[next] >= 0) return;
      dist[next] = d + 1;
      parent[next] = cur;
      via[next] = cargo;
      queue[tail++] = next;
    });
  }

  let goal = -1;
  for (let i = 0; i < tail; i++) {
    const s = stateAt(comp, queue[i]);
    if (solvedState(comp, s.mask, s.bank)) { goal = queue[i]; break; }
  }
  const explored = tail;

  if (goal < 0) {
    return { ok: false, par: -1, route: [], routes: 0, explored, truncated };
  }
  const par = dist[goal];

  const route = [];
  for (let i = goal; i !== start; i = parent[i]) route.push({ cargo: cargoIds(comp, via[i]) });
  route.reverse();

  // Count shortest routes by propagating counts along edges that go exactly one layer deeper.
  // `queue` is already in nondecreasing-distance order, which is what makes one pass enough.
  const ways = new Float64Array(size);
  ways[start] = 1;
  for (let i = 0; i < tail; i++) {
    const cur = queue[i];
    const w = ways[cur];
    if (!w || dist[cur] >= par) continue;
    const s = stateAt(comp, cur);
    eachCargo(comp, s.mask, s.bank, (cargo) => {
      const nm = nextMask(comp, s.mask, s.bank, cargo);
      if (!isSafe(comp, nm)) return;
      const next = stateIndex(comp, 1 - s.bank, nm);
      if (dist[next] === dist[cur] + 1) ways[next] += w;
    });
  }
  return { ok: true, par, route, routes: ways[goal], explored, truncated: false };
}

// The first single trip of a shortest route from wherever the player stands, or null when the
// position has gone unsolvable — the generator makes that impossible on a fresh board, but a
// player can walk into it one legal trip at a time only if a level was ever legal, so in
// practice null comes back for stale or hand-edited saves.
export function bestCrossing(spec, opts = {}) {
  const r = solve(spec, opts);
  return r.ok && r.route.length ? { cargo: r.route[0].cargo, par: r.par } : null;
}

// How much of the state space the player can actually wander around in. Together with `par`
// this is the second half of the difficulty measurement: 7 trips through 40 states is an
// exercise, 7 trips through 400 is a puzzle. `states` is what gets baked into every row of
// js/data/lots.js, and `truncated` is what turns an "unsolvable" verdict into a proof — when it
// is false, the frontier ran out, which is the only way this game says no.
export function census(spec, limit = 200000) {
  const r = solve(spec, { limit });
  const comp = spec.comp || compile(spec);
  return { states: r.explored, share: +(r.explored / comp.size).toFixed(4), truncated: r.truncated };
}
