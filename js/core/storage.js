// Save file. One localStorage key, plain JSON, and a versioned shape so an old save can be
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id (the ids in js/data/lots.js), plus a daily log and a campaign
// unlock pointer. Everything degrades to a memory object when localStorage is denied, which it
// is under file://, in private windows and in some hardened browsers — the game must still run,
// it just forgets on reload.
//
// Three monotonicity rules hold the save together, and all three are asserted in
// test/storage.test.mjs:
//   * `best` only goes down — a worse replay never overwrites a better one;
//   * `unlocked` only goes up — re-solving an early level cannot hide a later one;
//   * `perfect` only goes *in*: it is sticky, and it is never granted to a run that used a hint,
//     because "matched the searched par" is a claim about the player, not about the hint.

const KEY = 'ferry.save.v1';

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, crossings: 0, hints: 0 },
  };
}

let cache = null;

function hasDOM() {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    if (hasDOM()) raw = window.localStorage.getItem(KEY);
  } catch (err) {
    raw = null;
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  try {
    if (hasDOM()) window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (err) {
    /* memory-only session */
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // Unlocking is monotone by construction, not by convention.
  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // `par` is the searched shortest route, so "perfect" is a fact about this lot rather than a
  // feeling: the player used no more single trips than the BFS certified.
  solve(id, { moves, par, hints }) {
    const s = load();
    const prev = s.records[id];
    const matched = moves <= par;
    const cur = {
      solved: true,
      best: !prev || !prev.best || moves < prev.best ? moves : prev.best,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      perfect: (matched && !(hints > 0)) || !!(prev && prev.perfect),
    };
    s.records[id] = cur;
    s.stats.solves += 1;
    s.stats.crossings += moves;
    s.stats.hints += hints || 0;
    if (cur.perfect && !(prev && prev.perfect)) s.stats.perfect += 1;
    persist();
    return cur;
  },

  reset() {
    cache = blank();
    try {
      if (hasDOM()) window.localStorage.removeItem(KEY);
    } catch (err) {
      /* nothing was ever persisted */
    }
    return cache;
  },
};
