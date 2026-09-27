// The crossing model — the whole puzzle in one plain, JSON-serialisable spec.
//
//   {
//     title: '狼羊菜',
//     roles: [{ id: 0, name: '艄公', kind: 'ferryman' }, { id: 1, name: '狼', kind: 'beast' }, ...],
//     boat:  { rule: 'ferry' | 'free', capacity: 2 },
//     risk:  { type: 'pair', pairs: [[1, 2], [2, 3]] }
//        or  { type: 'majority', strong: '野人', weak: '传教士' }   // roles carry cls
//   }
//
// A *state* is `(bank, mask)`: which bank the boat lies at, and which roles are still on the
// left bank (`mask` is a bitmask over role ids, bit set = on the left). That is `2^(n+1)`
// states for `n` roles, and it is the whole game — everything else here is a lookup over it.
//
// The two boat laws are not an implementation detail. The same cast and the same conflicts can
// be solvable under one law and provably unsolvable under the other (test/anchors.test.mjs
// reproduces the measured table), so `boat.rule` is part of the level: it is baked into every
// row of js/data/lots.js and printed on screen.
//
//   'ferry' — the boatman must be aboard, plus 0..capacity-1 passengers. The boatman crossing
//             *alone* is legal; that is how wolf-goat-cabbage step 2 works, and forbidding it
//             is how a first draft sentenced the classic puzzle to "unsolvable".
//   'free'  — there is no boatman. Any 1..capacity roles in any combination: everyone rows.
//             An empty boat never leaves the bank.

export const LEFT = 0;
export const RIGHT = 1;
export const FERRY = 'ferry';
export const FREE = 'free';

// A mask has to stay a plain JS int for the submask enumeration to be cheap, and the distance
// table has to be one typed-array allocation. 12 roles is 8192 states; the generator never
// goes past 8.
export const MAX_ROLES = 12;

export function isOn(mask, id) {
  return (mask & (1 << id)) > 0;
}

// Which bank a role stands on. The mask records the left bank, so the right bank is "unset".
export function bankOf(mask, id) {
  return (mask & (1 << id)) ? LEFT : RIGHT;
}

export function bankMask(comp, mask, bank) {
  const left = mask & comp.total;
  return bank === LEFT ? left : comp.total & ~left;
}

export function idsOf(mask) {
  const out = [];
  for (let i = 0; i < MAX_ROLES; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

export function countBits(mask) {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

// (bank, mask) <-> one integer, so the solver holds distances in a flat table.
export function stateIndex(comp, bank, mask) {
  return bank * (1 << comp.n) + (mask & comp.total);
}

export function stateAt(comp, index) {
  return { bank: index >> comp.n, mask: index & comp.total };
}

// Everything the search reads, pre-typed: no property lookups on plain objects inside the BFS.
export function compile(spec) {
  const roles = spec.roles;
  const n = roles.length;
  const risk = spec.risk;
  const pairRisk = risk.type === 'pair';
  const comp = {
    title: spec.title || '',
    n,
    total: (1 << n) - 1,
    size: 2 << n, // 2^(n+1)
    rule: spec.boat.rule,
    capacity: spec.boat.capacity,
    ferryman: -1,
    riskType: risk.type,
    strong: pairRisk ? '' : risk.strong,
    weak: pairRisk ? '' : risk.weak,
    cls: new Int8Array(n), // 0 = neither class, 1 = weak, 2 = strong
    kind: new Array(n),
    name: new Array(n),
    short: new Array(n),
    pair: new Uint16Array(n), // adjacency bitmask, symmetric
    pairs: [],
    startBank: spec.bank === undefined ? LEFT : spec.bank,
    startMask: 0,
  };
  for (let i = 0; i < n; i++) {
    const r = roles[i];
    comp.name[i] = r.name;
    comp.short[i] = r.short || String(r.name).slice(0, 1);
    comp.kind[i] = r.kind || (r.cls === 'ferryman' ? 'ferryman' : 'human');
    if (r.cls === 'ferryman') comp.ferryman = i;
    else if (!pairRisk && r.cls === risk.strong) comp.cls[i] = 2;
    else if (!pairRisk && r.cls === risk.weak) comp.cls[i] = 1;
    if (r.at !== RIGHT) comp.startMask |= 1 << i; // `at` is omitted for the left bank
  }
  if (pairRisk) {
    for (const [a, b] of risk.pairs) {
      comp.pair[a] |= 1 << b;
      comp.pair[b] |= 1 << a;
      comp.pairs.push([a, b]);
    }
  }
  return comp;
}

// --- who is supervising -------------------------------------------------------------

// Is this bank watched? Under 'ferry' the boatman is the only supervisor and he supervises the
// bank he stands on. Under 'free' the answer is a hard `false`, written out rather than
// inherited from a missing ferryman index: that single line *is* the difference between the
// two laws, and it has to survive someone editing this file later.
export function supervised(comp, mask, bank) {
  if (comp.rule !== FERRY) return false;
  const f = comp.ferryman;
  return f >= 0 && bankOf(mask, f) === bank;
}

// --- what goes wrong on one bank ----------------------------------------------------

// The first conflict on one bank, or null. `roles` is what the view highlights.
export function conflictOnBank(comp, mask, bank) {
  const here = bankMask(comp, mask, bank);
  if (comp.riskType === 'pair') {
    for (const [a, b] of comp.pairs) {
      if (isOn(here, a) && isOn(here, b)) {
        return {
          type: 'pair', bank, roles: [a, b], a, b,
          why: `${comp.name[a]}和${comp.name[b]}单独留下了`,
        };
      }
    }
    return null;
  }
  // majority: the strong class strictly outnumbers the weak one, with at least one of the weak
  // present to be outnumbered. A bank of nothing but strong roles is dull, not fatal.
  let strong = 0;
  let weak = 0;
  const seen = [];
  for (let i = 0; i < comp.n; i++) {
    if (!isOn(here, i)) continue;
    if (comp.cls[i] === 2) { strong++; seen.push(i); } else if (comp.cls[i] === 1) { weak++; seen.push(i); }
  }
  if (weak >= 1 && strong > weak) {
    return {
      type: 'majority', bank, roles: seen, strong, weak,
      why: `${strong} 个${comp.strong}对 ${weak} 个${comp.weak}`,
    };
  }
  return null;
}

// Every conflict in a state. A state the player actually stands in has none by construction —
// `cross()` refuses anything that creates one — so this is only non-empty for candidates.
export function stateConflicts(comp, mask) {
  const out = [];
  for (let b = LEFT; b <= RIGHT; b++) {
    if (supervised(comp, mask, b)) continue;
    const c = conflictOnBank(comp, mask, b);
    if (c) out.push(c);
  }
  return out;
}

export function stateConflict(comp, mask) {
  for (let b = LEFT; b <= RIGHT; b++) {
    if (supervised(comp, mask, b)) continue;
    const c = conflictOnBank(comp, mask, b);
    if (c) return c;
  }
  return null;
}

export function isSafe(comp, mask) {
  return stateConflict(comp, mask) === null;
}

// --- what the boat will carry -------------------------------------------------------

// A loading is one of `null` (fine) or a fault name:
//   'far'   someone aboard is not on the bank the boat lies at
//   'over'  more aboard than the boat holds
//   'ferry' the boatman is not aboard (only reachable under the 'ferry' law)
//   'empty' nobody aboard and nobody to shove off (only reachable under 'free')
export function loadingFault(comp, mask, bank, cargo) {
  const here = bankMask(comp, mask, bank);
  if (cargo & ~here) return 'far';
  const n = countBits(cargo);
  if (n > comp.capacity) return 'over';
  if (comp.rule === FERRY) {
    const f = comp.ferryman;
    if (f < 0 || !isOn(cargo, f)) return 'ferry';
    return null; // boatman alone is a legal crossing, and the classic route needs it
  }
  if (n === 0) return 'empty';
  return null;
}

// Emit every subset of `bits` with at most `cap` elements, empty set included, in ascending id
// order. Order matters: it decides which shortest route the BFS reports, and a shared link has
// to show everyone the same one.
export function eachSubset(bits, cap, cb) {
  const out = [];
  const go = (from, used) => {
    cb(out.slice());
    if (used === cap) return;
    for (let i = from; i < bits.length; i++) {
      out.push(bits[i]);
      go(i + 1, used + 1);
      out.pop();
    }
  };
  go(0, 0);
}

// Every cargo the boat can leave with from this state. Each is a legal *loading*; whether the
// crossing itself is legal is `cross()`'s business.
export function eachCargo(comp, mask, bank, cb) {
  const here = bankMask(comp, mask, bank);
  const bits = idsOf(here);
  if (comp.rule === FERRY) {
    const f = comp.ferryman;
    if (f < 0 || !isOn(here, f)) return;
    eachSubset(bits.filter((i) => i !== f), comp.capacity - 1, (sub) => {
      cb(sub.reduce((m, i) => m | (1 << i), 1 << f));
    });
    return;
  }
  eachSubset(bits, comp.capacity, (sub) => {
    if (!sub.length) return; // 'free': an empty boat does not go anywhere
    cb(sub.reduce((m, i) => m | (1 << i), 0));
  });
}

export function eachCrossing(comp, mask, bank, cb) {
  eachCargo(comp, mask, bank, (cargo) => cb(cargo, nextMask(comp, mask, bank, cargo)));
}

export function nextMask(comp, mask, bank, cargo) {
  return bank === LEFT ? mask & ~cargo : (mask | cargo) & comp.total;
}

// One crossing, checked. Returns { ok, mask, bank, cargo } or { ok: false, why, conflict }.
// A rejection names *which roles* come to harm and on which bank, which is the teaching point
// of this game: the UI prints exactly that and nothing else decides it.
export function cross(comp, mask, bank, cargo) {
  const fault = loadingFault(comp, mask, bank, cargo);
  if (fault) return { ok: false, why: fault, cargo: idsOf(cargo) };
  const next = { bank: 1 - bank, mask: nextMask(comp, mask, bank, cargo) };
  const bad = stateConflict(comp, next.mask);
  if (bad) {
    return {
      ok: false,
      why: 'conflict',
      conflict: bad,
      where: bad.bank === next.bank ? 'arrival' : 'departure',
      cargo: idsOf(cargo),
    };
  }
  return { ok: true, mask: next.mask, bank: next.bank, cargo: idsOf(cargo) };
}

export function crossings(comp, mask, bank) {
  const out = [];
  eachCargo(comp, mask, bank, (cargo) => {
    const r = cross(comp, mask, bank, cargo);
    if (r.ok) out.push(r);
  });
  return out;
}

// Everyone is off the left bank and the boat made the last trip with them. Under 'ferry' the
// second half is automatic (the boatman is one of the roles); under 'free' it is not, so it is
// stated.
export function solvedState(comp, mask, bank) {
  return mask === 0 && bank === RIGHT;
}

export function cargoIds(comp, cargo) {
  return idsOf(cargo & comp.total);
}

// Back out to a plain spec. `mask` defaults to the start line, which is what the baker writes.
export function toSpec(comp, mask) {
  const m = mask === undefined ? comp.startMask : mask;
  const roles = [];
  for (let i = 0; i < comp.n; i++) {
    const r = { id: i, name: comp.name[i], short: comp.short[i], kind: comp.kind[i] };
    if (comp.ferryman === i) r.cls = 'ferryman';
    else if (comp.riskType === 'majority' && comp.cls[i] === 2) r.cls = comp.strong;
    else if (comp.riskType === 'majority' && comp.cls[i] === 1) r.cls = comp.weak;
    if (bankOf(m, i) === RIGHT) r.at = RIGHT;
    roles.push(r);
  }
  return {
    title: comp.title,
    roles,
    boat: { rule: comp.rule, capacity: comp.capacity },
    risk: comp.riskType === 'pair'
      ? { type: 'pair', pairs: comp.pairs.map((p) => [p[0], p[1]]) }
      : { type: 'majority', strong: comp.strong, weak: comp.weak },
    bank: comp.startBank,
  };
}

// --- structural sanity --------------------------------------------------------------

// Used by the generator, the baker and the test suite. Every clause here has its own negative
// case in test/river.test.mjs, because a validator that never says no is not a validator.
export function validate(spec) {
  if (!spec || !Array.isArray(spec.roles)) return 'no roles';
  const n = spec.roles.length;
  if (n < 2) return 'a crossing puzzle needs at least two roles';
  if (n > MAX_ROLES) return `more than ${MAX_ROLES} roles`;
  const boat = spec.boat;
  if (!boat || (boat.rule !== FERRY && boat.rule !== FREE)) return "boat.rule must be 'ferry' or 'free'";
  if (!Number.isInteger(boat.capacity) || boat.capacity < 1) return 'boat.capacity must be a positive integer';
  const risk = spec.risk;
  if (!risk || (risk.type !== 'pair' && risk.type !== 'majority')) return "risk.type must be 'pair' or 'majority'";
  if (spec.bank !== undefined && spec.bank !== LEFT && spec.bank !== RIGHT) return 'the boat starts off the banks';
  const degree = new Array(n).fill(0);
  let ferrymen = 0;
  let strong = 0;
  let weak = 0;
  for (let i = 0; i < n; i++) {
    const r = spec.roles[i];
    if (!r || !r.name) return `role ${i} has no name`;
    if (r.id !== i) return `role ${i} must carry id ${i}`;
    if (r.at !== undefined && r.at !== LEFT && r.at !== RIGHT) return `role ${i} starts off the banks`;
    if (r.cls === 'ferryman') {
      ferrymen++;
      if (i !== 0) return "the boatman's id is 0";
      continue;
    }
    if (risk.type === 'majority') {
      if (r.cls === risk.strong) strong++;
      else if (r.cls === risk.weak) weak++;
      else return `role ${i} belongs to neither class of the majority rule`;
    }
  }
  if (boat.rule === FERRY && ferrymen !== 1) return "under 'ferry' the boat needs exactly one boatman";
  if (boat.rule === FREE && ferrymen !== 0) return "under 'free' nobody boats the ferry: drop the boatman";
  if (risk.type === 'pair') {
    if (!Array.isArray(risk.pairs) || !risk.pairs.length) return 'no conflict pairs';
    const seen = new Set();
    for (const p of risk.pairs) {
      if (!Array.isArray(p) || p.length !== 2) return 'a conflict pair needs exactly two roles';
      const [a, b] = p;
      if (!Number.isInteger(a) || !Number.isInteger(b)) return 'conflict pair of non-ids';
      if (a === b) return `self-conflict on role ${a}`;
      if (a < 0 || b < 0 || a >= n || b >= n) return 'conflict pair outside the cast';
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) return `conflict pair ${key} listed twice`;
      seen.add(key);
      if (spec.roles[a].cls === 'ferryman' || spec.roles[b].cls === 'ferryman') return 'the boatman conflicts with nobody';
      degree[a]++;
      degree[b]++;
    }
    const hot = degree.findIndex((d) => d > 3);
    if (hot >= 0) return `role ${hot} has degree ${degree[hot]}, above the limit of 3`;
  } else {
    if (!risk.strong || !risk.weak || risk.strong === risk.weak) return 'majority needs two distinct class names';
    if (!strong || !weak) return 'majority needs at least one role of each class';
  }
  return null;
}

// A printable identity for a spec: the generator's dedupe key and the test's comparison face.
export function signature(spec) {
  const cast = spec.roles
    .map((r) => `${r.name}/${r.cls || '-'}${r.at === RIGHT ? '@R' : ''}`)
    .sort()
    .join(',');
  const edges = spec.risk.type === 'pair'
    ? spec.risk.pairs.map((p) => `${Math.min(p[0], p[1])}-${Math.max(p[0], p[1])}`).sort().join(' ')
    : `${spec.risk.strong}>${spec.risk.weak}`;
  return `${spec.boat.rule}c${spec.boat.capacity} b${spec.bank || 0} | ${cast} | ${edges}`;
}
