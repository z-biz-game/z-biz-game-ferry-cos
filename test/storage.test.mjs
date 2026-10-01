// The save file. Under `node --test` there is no `window` and no `localStorage`, which is exactly
// the degradation path the browser hits in a private window and under file:// — the game must keep
// working and simply forget on reload. The three monotonicity rules are asserted here rather than
// trusted: `best` only goes down, `unlocked` only goes up, and `perfect` is never granted to a run
// that asked for a hint, because matching the searched par is a claim about the player.

import { test, eq, ok, run } from '../tools/harness.mjs';
import { store } from '../js/core/storage.js';

test('without a window the store still works, in memory', () => {
  eq(typeof globalThis.window, 'undefined', 'this suite is supposed to run headless');
  store.reset();
  eq(store.records, {});
  eq(store.unlocked, 1);
  eq(store.stats, { solves: 0, perfect: 0, crossings: 0, hints: 0 });
  eq(store.record('shoal-01'), null);
});

test('a solve is recorded with its trip count and the perfect flag follows the searched par', () => {
  const r = store.solve('shoal-01', { moves: 1, par: 1, hints: 0 });
  eq(r.solved, true);
  eq(r.best, 1);
  eq(r.plays, 1);
  eq(r.perfect, true);
  eq(store.record('shoal-01').best, 1);
  eq(store.stats.solves, 1);
  eq(store.stats.crossings, 1);
  eq(store.stats.perfect, 1);
});

test('best only goes down: a worse replay never overwrites a better one', () => {
  store.solve('shoal-01', { moves: 9, par: 1, hints: 0 });
  eq(store.record('shoal-01').best, 1, 'a sloppier run overwrote the record');
  eq(store.record('shoal-01').plays, 2);
  store.solve('ford-01', { moves: 7, par: 5, hints: 0 });
  eq(store.record('ford-01').best, 7);
  store.solve('ford-01', { moves: 5, par: 5, hints: 0 });
  eq(store.record('ford-01').best, 5);
  store.solve('ford-01', { moves: 6, par: 5, hints: 0 });
  eq(store.record('ford-01').best, 5, 'the record drifted back up');
});

test('over par is a solve without the perfect flag, and the flag is sticky once earned', () => {
  const sloppy = store.solve('rapids-01', { moves: 11, par: 9, hints: 0 });
  eq(sloppy.perfect, false);
  eq(sloppy.best, 11);
  const clean = store.solve('rapids-01', { moves: 9, par: 9, hints: 2 });
  eq(clean.perfect, false, 'a hinted run may not take the perfect flag');
  eq(clean.best, 9, 'a better count should still lower the record');
  const earned = store.solve('rapids-01', { moves: 9, par: 9, hints: 0 });
  eq(earned.perfect, true);
  const after = store.solve('rapids-01', { moves: 15, par: 9, hints: 4 });
  eq(after.perfect, true, 'the perfect flag was revoked by a later bad run');
  eq(after.best, 9);
  eq(after.plays, 4);
  // three lots carry the flag now: shoal-01, ford-01 and rapids-01 — one per lot, not per run
  eq(store.stats.perfect, 3, 'the perfect tally counted a lot twice');
});

test('unlocking only moves forwards, and the tally bills hints and crossings', () => {
  eq(store.unlocked, 1);
  eq(store.unlock(5), 5);
  eq(store.unlock(2), 5, 're-solving an early level hid a later one');
  eq(store.unlock(5), 5);
  eq(store.unlock(6), 6);
  const before = { ...store.stats };
  store.solve('labyrinth-01', { moves: 13, par: 13, hints: 3 });
  eq(store.stats.hints, before.hints + 3);
  eq(store.stats.crossings, before.crossings + 13);
  eq(store.stats.solves, before.solves + 1);
  eq(store.stats.perfect, before.perfect, 'a hinted par run filled the perfect tally');
  eq(store.record('labyrinth-01').perfect, false);
  store.solve('labyrinth-02', { moves: 15, par: 15, hints: 0 });
  eq(store.stats.perfect, before.perfect + 1, 'a clean par run did not fill the perfect tally');
});

test('the daily log keeps one entry per day and says which lot it was', () => {
  eq(store.dailyDone('2026-09-27'), null);
  store.markDaily('2026-09-27', 'ford-03');
  const mark = store.dailyDone('2026-09-27');
  eq(mark.id, 'ford-03');
  ok(mark.at > 0, 'the daily entry has no timestamp');
  store.markDaily('2026-09-28', 'rapids-01');
  eq(store.dailyDone('2026-09-27').id, 'ford-03', 'a second day overwrote the first');
  eq(Object.keys(store.daily).length, 2);
  store.markDaily('2026-09-27', 'shoal-06');
  eq(store.dailyDone('2026-09-27').id, 'shoal-06');
  eq(Object.keys(store.daily).length, 2, 'the log grew a third day');
});

test('a corrupt or foreign save is dropped rather than crashing the shell', () => {
  store.reset();
  store.solve('shoal-02', { moves: 1, par: 1, hints: 0 });
  eq(store.record('shoal-02').best, 1);
  store.reset();
  eq(store.records, {}, 'reset left records behind');
  eq(store.unlocked, 1, 'reset left the unlock pointer behind');
  eq(store.daily, {});
  eq(store.stats, { solves: 0, perfect: 0, crossings: 0, hints: 0 });
  eq(store.record('shoal-02'), null, 'reset left a solve behind');
});

test('reset really is a wipe, and the store survives being used again afterwards', () => {
  store.solve('a', { moves: 3, par: 3, hints: 0 });
  store.unlock(9);
  store.markDaily('2026-01-01', 'a');
  eq(Object.keys(store.records).length, 1);
  store.reset();
  eq(store.records, {});
  eq(store.unlocked, 1);
  eq(store.dailyDone('2026-01-01'), null);
  const again = store.solve('a', { moves: 5, par: 3, hints: 1 });
  eq(again.plays, 1, 'the play counter carried across a wipe');
  eq(again.best, 5);
  eq(again.perfect, false);
  eq(store.stats.solves, 1);
});

// --- the same module with a `window` under it ----------------------------------------------
//
// Re-imported with a cache-busting query so each case gets a fresh module instance and therefore a
// cold `load()`. This is the only way to see what the save layer does with what a browser actually
// hands back: a payload written by an older build, and a payload that is not JSON at all.

const KEY = 'ferry.save.v1';
const jar = (init = {}) => {
  const mem = Object.assign({}, init);
  return {
    mem,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
};

const withWindow = async (init, tag) => {
  const box = jar(init);
  globalThis.window = { localStorage: box };
  const mod = await import(`../js/core/storage.js?case=${tag}`);
  return { store: mod.store, box };
};

const good = await withWindow({
  [KEY]: JSON.stringify({
    records: { 'shoal-03': { solved: true, best: 3, plays: 2, perfect: true } },
    unlocked: 12,
    daily: { '2026-09-26': { id: 'ford-01', at: 1 } },
    stats: { solves: 5 },
  }),
}, 'good');

const broken = await withWindow({ [KEY]: '{ not json, truncated by a full disk' }, 'broken');

const hostile = await withWindow({ [KEY]: '[1,2,3]' }, 'hostile');

// A hand-edited (or half-written, or version-skewed) save where only some entries are sound. This
// is what stage 2 exists for: every broken shape below has to cost exactly itself, while the
// healthy record two keys away keeps its `best`.
const rotten = await withWindow({
  [KEY]: JSON.stringify({
    records: {
      'shoal-01': { solved: true, best: 4, plays: 2, perfect: true },
      'null-record': null,
      'array-record': [1, 2],
      'string-best': { solved: true, best: '7', plays: '3', perfect: 1 },
      'negative-plays': { solved: true, best: 9, plays: -3, perfect: false },
      'huge-best': { solved: true, best: 1e12, plays: 1e9, perfect: false },
      empty: {},
    },
    unlocked: '0',
    daily: {
      '2026-09-28': { id: 'ford-02', at: 'not a timestamp' },
      bad: null,
      '2026-09-29': { at: 1 },
    },
    stats: { solves: -4, perfect: 'lots', crossings: null, hints: 2.7 },
    settings: { muted: 'true', seenHelp: 0 },
  }),
}, 'rotten');

// A save that claims more records than the layer is willing to hold in memory.
const many = await withWindow({
  [KEY]: JSON.stringify({
    records: Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`lot-${i}`, { solved: true, best: 1, plays: 1, perfect: false }]),
    ),
  }),
}, 'many');

// The store reads `window` when it touches storage, not when the module was imported, so every
// case below has to put its own jar under `window` before it acts.
const use = (fixture) => { globalThis.window = { localStorage: fixture.box }; return fixture.store; };

test('a save from an earlier session is honoured, field by field', () => {
  const s = use(good);
  eq(s.record('shoal-03').best, 3);
  eq(s.record('shoal-03').perfect, true);
  eq(s.unlocked, 12);
  eq(s.dailyDone('2026-09-26').id, 'ford-01');
  eq(s.stats.solves, 5, 'a stats object with new fields lost the old ones');
  eq(s.stats.hints, 0, 'a missing stat must come back as 0, not undefined');
  eq(s.unlock(4), 12, 'an old save reset the unlock pointer');
});

test('solving through the DOM-backed store writes JSON to the key', () => {
  use(good).solve('ford-01', { moves: 6, par: 5, hints: 1 });
  const raw = JSON.parse(good.box.mem[KEY]);
  eq(raw.records['ford-01'].best, 6);
  eq(raw.records['ford-01'].perfect, false);
  eq(raw.stats.hints, 1, 'the hint counter carried the wrong total');
  eq(raw.stats.solves, 6);
  eq(raw.records['shoal-03'].best, 3, 'a write clobbered an unrelated record');
});

test('a payload that is not JSON starts the player fresh instead of throwing at boot', () => {
  const s = use(broken);
  eq(s.records, {}, 'the corrupt save survived somehow');
  eq(s.unlocked, 1);
  s.solve('shoal-01', { moves: 1, par: 1, hints: 0 });
  eq(JSON.parse(broken.box.mem[KEY]).records['shoal-01'].best, 1, 'the recovery was not persisted');
});

test('a payload of the right shape but the wrong kind is repaired, not trusted', () => {
  const s = use(hostile);
  eq(Array.isArray(s.records), false, 'an array was accepted as the records map');
  eq(Object.keys(s.records).length, 0);
  eq(s.unlocked, 1);
});

test('clearing the save takes the key out of localStorage as well as memory', () => {
  const s = use(broken);
  s.reset();
  eq(s.records, {});
  eq(broken.box.mem[KEY] === undefined, true, 'the wiped save was still on disk');
});

test('one rotten record costs exactly itself, not the whole save', () => {
  const s = use(rotten);
  eq(s.record('shoal-01').best, 4, 'a neighbour killed a healthy record');
  eq(s.record('shoal-01').perfect, true);
  eq(s.record('null-record'), null, 'a null record came back as an object');
  eq(s.records['array-record'], undefined, 'an array was accepted as a record');
  eq(s.record('string-best').best, 7, '"7" did not become a number');
  eq(s.record('string-best').plays, 3);
  eq(s.record('string-best').perfect, true, 'the truthy 1 was thrown away instead of coerced');
  eq(s.record('negative-plays').plays, 0, 'a negative play count survived');
  eq(s.record('huge-best').best, 999, 'an absurd best was trusted');
  eq(s.record('huge-best').plays, 99999);
  eq(s.record('empty').solved, false, 'an empty record became a solved one');
  eq(s.record('empty').best, 0);
  eq(s.unlocked, 1, 'unlocked: "0" moved the campaign backwards');
  eq(s.dailyDone('2026-09-28').id, 'ford-02');
  eq(s.dailyDone('2026-09-28').at, 0, 'a non-numeric timestamp was trusted');
  eq(s.dailyDone('bad'), null, 'a null daily entry survived');
  eq(s.dailyDone('2026-09-29'), null, 'a daily entry with no lot id survived');
  eq(s.stats, {
    solves: 0, perfect: 0, crossings: 0, hints: 3,
  }, 'the stats block kept a hostile shape');
  eq(s.settings.muted, true, '"true" is a mute flag a hand-edited save really uses');
  eq(s.settings.seenHelp, false);
});

test('a repaired save still accepts a solve, and the repair is what gets written back', () => {
  const s = use(rotten);
  const r = s.solve('shoal-01', { moves: 5, par: 4, hints: 0 });
  eq(r.best, 4, 'a worse replay overwrote the stored best');
  eq(r.plays, 3);
  eq(r.perfect, true, 'the sticky perfect flag was lost on a repaired record');
  const raw = JSON.parse(rotten.box.mem[KEY]);
  eq(raw.records['null-record'], undefined, 'the repair was not persisted');
  eq(raw.records['array-record'], undefined);
  eq(raw.records['huge-best'].best, 999);
  eq(raw.records['shoal-01'].best, 4);
});

test('a save claiming five thousand records is capped, not allocated', () => {
  const s = use(many);
  eq(Object.keys(s.records).length, 4096, 'the record map grew without a limit');
});

globalThis.window = undefined;

run();
