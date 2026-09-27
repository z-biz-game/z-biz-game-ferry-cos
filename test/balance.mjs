// The measurement behind the two numbers DESIGN.md quotes: how often each generator lands in a
// band, and how long it takes when it does. This is not a test — it prints, and the printed values
// are what the docs and the comments in js/core/make.js cite. Run it again after touching make.js:
//
//   node test/balance.mjs
//   SAMPLES=200 node test/balance.mjs
//
// Everything here is bounded twice: by the ladder's own probe/budget counters and by a wall-clock
// deadline, so a runaway generator cannot hang the build.

import { TIERS, makeLot, scatter } from '../js/core/make.js';
import { solve } from '../js/core/solve.js';

const SAMPLES = Number(process.env.SAMPLES || 60);
const DEADLINE = Date.now() + Number(process.env.DEADLINE_MS || 90000);

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const tally = (stats) => {
  const probed = (stats.probe || 0);
  return {
    probed,
    kept: stats.keep || 0,
    lateral: stats.lateral || 0,
    unsolvable: stats.unsolvable || 0,
    noGain: stats.noGain || 0,
    tooHard: stats.tooHard || 0,
    timeout: stats.timeout || 0,
  };
};

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say(`每档 ${SAMPLES} 个种子 · 墙钟上限 ${Math.round((DEADLINE - Date.now()) / 1000)}s`);
say('');
say('== 变异生成器（js/core/make.js 的 makeLot，实际出货口径）==');
say('档         出题率      变异接受   同数平移  判不可解  超带   每颗种子中位耗时  最慢  唯一题面');
let anyLate = false;
for (const tier of TIERS) {
  const stats = {};
  const times = [];
  const faces = new Set();
  const pars = {};
  for (let s = 0; s < SAMPLES; s++) {
    if (Date.now() > DEADLINE) { anyLate = true; break; }
    const t0 = Date.now();
    const lot = makeLot(`balance-${tier.key}-${s}`, tier, stats);
    times.push(Date.now() - t0);
    if (!lot) continue;
    faces.add(lot.signature);
    pars[lot.rating.par] = (pars[lot.rating.par] || 0) + 1;
  }
  const t = tally(stats);
  const keptCount = Object.values(pars).reduce((a, b) => a + b, 0);
  say(`${tier.key.padEnd(10)} ${(keptCount ? pct(keptCount / Math.max(1, times.length)) : '0%').padStart(8)}`
    + `   ${pct(t.kept / Math.max(1, t.probed)).padStart(7)}   ${String(t.lateral).padStart(7)}`
    + `   ${String(t.unsolvable).padStart(7)}  ${String(t.tooHard).padStart(7)}`
    + `   ${String(median(times)).padStart(9)} ms  ${String(Math.max(0, ...times)).padStart(4)}ms  ${faces.size}/${times.length}`);
  say(`${''.padEnd(10)} 实测 par 分布 ${JSON.stringify(pars)} （目标带 ${tier.min}-${tier.max}）`);
}

say('');
say('== 撒点生成器（scatter，已被替换的那个）==');
say('档         尝试      接受率      不可解率   超带率   低于带率');
for (const tier of TIERS) {
  const stats = {};
  let tries = 0;
  for (let s = 0; s < Math.max(6, Math.round(SAMPLES / 3)); s++) {
    if (Date.now() > DEADLINE) { anyLate = true; break; }
    tries++;
    scatter(`scatter-balance-${tier.key}-${s}`, tier, stats);
  }
  const probed = (stats.found || 0) + (stats.unsolvable || 0) + (stats.tooHard || 0) + (stats.underBand || 0) + (stats.invalid || 0) + (stats.nofit || 0);
  const rate = (k) => pct((stats[k] || 0) / Math.max(1, probed));
  say(`${tier.key.padEnd(10)} ${String(probed).padStart(7)}  ${rate('found').padStart(8)}   ${rate('unsolvable').padStart(8)}  ${rate('tooHard').padStart(8)}  ${rate('underBand').padStart(8)}`);
}

say('');
say('== 状态规模与前端代价（浏览器里点一次提示要搜多少态）==');
const { WGC, missionaries } = await import('./fixture.mjs');
for (const [label, spec] of [
  ['狼羊菜 4 角色', WGC],
  ['M&C 3+3 无艄公', missionaries(3, 'free')],
  ['M&C 6+6 无艄公', missionaries(6, 'free')],
]) {
  const t0 = Date.now();
  const r = solve(spec, { limit: 400000 });
  const ms = Date.now() - t0;
  say(`${label.padEnd(18)} ${r.ok ? `${r.par} 单程 / ${r.routes} 条最优` : '不可解'}`
    + ` · 搜了 ${r.explored} 态 · ${ms} ms · truncated=${r.truncated}`);
}
if (anyLate) say('（部分档位在墙钟上限前跑完，样本数已截断）');
