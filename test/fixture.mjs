// Hand-written puzzles. These are the few specs in the repo whose answer a human wrote down,
// because an anchor test needs an expected number that did not come out of the code it tests.
//
// WGC is the classic 狼-羊-菜 with a boatman: conflicts are 狼 eats 羊 and 羊 eats 菜, and a bank
// is only watched while the boatman stands on it. The answer, 7 single trips, is written out
// step by step in test/anchors.test.mjs rather than read back from the solver.
//
// missionaries(n, rule) is the other family: `n` 传教士 and `n` 野人 on the left bank, and a bank
// is lost whenever the 野人 outnumber the 传教士 with at least one 传教士 present. `rule` picks the
// boat law — 'free' (everyone rows, 1..capacity aboard) or 'ferry' (the boatman must be aboard).
// Those two laws over the same cast are the point of this file: 3+3 is solvable in 11 trips under
// 'free' and provably unsolvable under 'ferry'.

export const WGC = {
  title: '狼羊菜',
  roles: [
    { id: 0, name: '艄公', short: '艄', kind: 'ferryman', cls: 'ferryman' },
    { id: 1, name: '狼', short: '狼', kind: 'beast' },
    { id: 2, name: '羊', short: '羊', kind: 'beast' },
    { id: 3, name: '菜', short: '菜', kind: 'goods' },
  ],
  boat: { rule: 'ferry', capacity: 2 },
  risk: { type: 'pair', pairs: [[1, 2], [2, 3]] },
};

// A role id list per single trip, written by hand in the order the boatman thinks it:
// take the goat, come back alone, take the wolf, bring the goat back, take the cabbage,
// come back alone, take the goat.
export const WGC_ROUTE = [
  { cargo: [0, 2], note: '带羊过河' },
  { cargo: [0], note: '空船回来' },
  { cargo: [0, 1], note: '带狼过河' },
  { cargo: [0, 2], note: '把羊带回出发岸' },
  { cargo: [0, 3], note: '带菜过河' },
  { cargo: [0], note: '空船回来' },
  { cargo: [0, 2], note: '最后带羊过河' },
];

export const CREW = { 传教士: { short: '教', kind: 'human' }, 野人: { short: '野', kind: 'beast' } };

// `n` of each class. Under 'ferry' the boatman is role 0 and the classes start at id 1.
export function missionaries(n, rule, capacity = 2) {
  const roles = [];
  if (rule === 'ferry') {
    roles.push({ id: 0, name: '艄公', short: '艄', kind: 'ferryman', cls: 'ferryman' });
  }
  for (const cls of ['传教士', '野人']) {
    for (let k = 0; k < n; k++) {
      roles.push({ id: roles.length, name: `${cls}${k + 1}`, short: CREW[cls].short, kind: CREW[cls].kind, cls });
    }
  }
  return {
    title: `M&C ${n}+${n} · ${rule === 'ferry' ? '艄公船' : '自由船'}`,
    roles,
    boat: { rule, capacity },
    risk: { type: 'majority', strong: '野人', weak: '传教士' },
  };
}

// A two-role pair puzzle with a boatman: the smallest thing this game can be. 3 trips — out with
// the first, back alone, out with the second — and the hand-written route is in the test.
export const PAIR = {
  title: '狼与羊',
  roles: [
    { id: 0, name: '艄公', short: '艄', kind: 'ferryman', cls: 'ferryman' },
    { id: 1, name: '狼', short: '狼', kind: 'beast' },
    { id: 2, name: '羊', short: '羊', kind: 'beast' },
  ],
  boat: { rule: 'ferry', capacity: 2 },
  risk: { type: 'pair', pairs: [[1, 2]] },
};

export const PAIR_ROUTE = [{ cargo: [0, 1] }, { cargo: [0] }, { cargo: [0, 2] }];
