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
const MAX_RECORDS = 4096; // a save that claims 100k records is not a save, it is an attack on memory

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, crossings: 0, hints: 0 },
    settings: { muted: false, seenHelp: false },
  };
}

// --- stage 2: decode one record, or nothing at all ----------------------------------------------
// Stage 1 (`JSON.parse` in `load`) only decides whether the *whole file* is readable. Stage 2
// decides per entry, and a single bad entry must cost exactly itself: a `null` record, a record
// missing `best`, `best: "7"`, `plays: -3` — none of them may take the rest of the save down with
// it, and none of them may throw. The old shape did `Object.assign(blank(), parsed)`, which is
// how one hand-edited `null` froze the shell on boot.

function num(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function bool(v, dflt) {
  return typeof v === 'boolean' ? v : (v === 1 || v === 'true' || v === 0 || v === 'false' ? !!v : dflt);
}

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const best = num(raw.best, 0, 999, null);
  return {
    solved: bool(raw.solved, best !== null),
    best: best === null ? 0 : best,
    plays: num(raw.plays, 0, 99999, 1),
    perfect: bool(raw.perfect, false),
  };
}

function cleanRecords(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const id of Object.keys(src).slice(0, MAX_RECORDS)) {
    const rec = cleanRecord(src[id]);
    if (rec) out[String(id).slice(0, 64)] = rec;
  }
  return out;
}

function cleanDaily(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const day of Object.keys(src).slice(0, 1024)) {
    const v = src[day];
    if (v && typeof v === 'object' && typeof v.id === 'string') {
      out[String(day).slice(0, 32)] = { id: v.id.slice(0, 64), at: num(v.at, 0, Number.MAX_SAFE_INTEGER, 0) };
    }
  }
  return out;
}

function cleanStats(src) {
  const base = blank().stats;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return base;
  return {
    solves: num(src.solves, 0, 1e9, 0),
    perfect: num(src.perfect, 0, 1e9, 0),
    crossings: num(src.crossings, 0, 1e9, 0),
    hints: num(src.hints, 0, 1e9, 0),
  };
}

function cleanSettings(src) {
  const base = blank().settings;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return base;
  return { muted: bool(src.muted, base.muted), seenHelp: bool(src.seenHelp, base.seenHelp) };
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
      const p = JSON.parse(raw); // stage 1: is the file readable JSON at all
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const base = blank();
        cache = { // stage 2: every field is rebuilt from a cleaner, so one bad entry dies alone
          records: cleanRecords(p.records),
          daily: cleanDaily(p.daily),
          unlocked: num(p.unlocked, 1, 1e6, base.unlocked),
          stats: cleanStats(p.stats),
          settings: cleanSettings(p.settings),
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
  get settings() { return load().settings; },

  // Mute and "have I read the rules yet" are save data too: a device that remembers the score but
  // forgets the volume has not really remembered anything.
  setSetting(key, value) {
    const s = load();
    s.settings[key] = !!value;
    persist();
    return s.settings[key];
  },

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
