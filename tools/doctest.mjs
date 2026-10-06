// 文档是被断言的面：README / DESIGN / deliverable 里印出去的每一个「现值」都必须等于代码或脚本的现在值。
//
// 为什么要有这个文件：上一轮交付把文档换成实测读数就提交了，而这个仓里没有任何东西守着「文档写的数」
// 与「代码现在算出来的数」相等。散文可以一直抄下去，直到某天代码改了字、文档还在引用上一个世界的数。
// 本轮对表抓到 9 处漂移（全是 `path:NN` 这一类：文档说符号坐在第 430 行，代码现在在 431 行），
// 都按「以代码为准」改回了文档那一边。
//
// 三条规矩（照 kurotto-cos 的机制走，不自创一套）：
//   * 每一条等式都配一条「解析到的条数」的反空转断言——正则没命中不是绿，是红；
//   * 墙钟毫秒不重新计时、也不把新测的毫秒写回文档：耗时只以「文档自己写明这一列会漂」的关系出现（D9），
//     能逐位复现的结构数字（关卡数、par、routes、态数、断言数、阈值）才在这里比数值；
//   * 文档改形状（表格列、句子措辞、引用格式）不算通过的理由：解析不到就是红。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_ROLES, FERRY, FREE, compile } from '../js/core/river.js';
import { solve } from '../js/core/solve.js';
import { TIERS as GEN_TIERS } from '../js/core/make.js';
import { TIERS as META, LAWS, ALL, stats } from '../js/core/library.js';
import { hashSeed } from '../js/core/rng.js';
import { WGC, PAIR, missionaries } from '../test/fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const fail = [];
const emitted = new Set();
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  emitted.add(label.match(/^D\d+/)[0]);
  if (!cond) fail.push(label);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DELIV = read('deliverable.md');
// 台账行会把针与红行原样抄一遍，所以那些行从对表面前撤掉（否则 S3 那一格会把 D6 自己判红）：
// 「命中数要恰好等于期望数」这一类反空转断言，数的都是摘掉台账之后的文档。
const stripLedger = t => t.split('\n').filter(l => !/^\| S\d+ \| /.test(l)).join('\n');
const DOCS = stripLedger(README) + '\n' + stripLedger(DESIGN) + '\n' + stripLedger(DELIV);
const CI = read('.github/workflows/ci.yml');
const VERIFY = read('tools/verify.sh');
const PKG = JSON.parse(read('package.json'));
const PLAYTEST = read('tools/playtest.mjs');
const BAKE = read('tools/bake.mjs');
const GAME = read('js/core/game.js');
const VIEW = read('js/view.js');
const SOLVE = read('js/core/solve.js');
const SERVER = read('server.cjs');
const SAB = read('tools/sabotage.mjs');
const LOTS_SRC = read('js/data/lots.js');

const S = stats();
const KEYS = ['shoal', 'ford', 'rapids', 'labyrinth'];

// ---- D1 难度带那张表：README 与 deliverable 的每一格都在 library.stats() 上重算 ----
const readmeBands = [...README.matchAll(
  /^\| (浅滩|短渡|急流|迷津) (\w+) \| (\d+) \| (\d+)–(\d+) \| (\d+) \| (\d+) \/ (\d+) \/ (\d+) \| (\d+)–(\d+) \| (\d+) \/ (\d+) \| pair (\d+) · majority (\d+) \|$/gm)];
ok(readmeBands.length === META.length, `D1a README 的难度带表解析到 ${META.length} 行（解析不到不等于通过）`,
  `解析 ${readmeBands.length} 行 vs TIERS_META ${META.length} 档`);
const delivBands = [...DELIV.matchAll(
  /^\| (浅滩|短渡|急流|迷津) (\w+) \| (\d+) \| (\d+)–(\d+) \/ (\d+) \| (\d+)–(\d+) \| (\d+) \/ (\d+) \/ (\d+) \| (\d+) \/ (\d+) \| (\d+) \/ (\d+) \|$/gm)];
ok(delivBands.length === META.length, `D1b deliverable §4 的那张表也解析到 ${META.length} 行`, `解析 ${delivBands.length} 行`);
for (const t of META) {
  const b = S.byTier[t.key];
  const r = readmeBands.find(m => m[2] === t.key);
  const d = delivBands.find(m => m[2] === t.key);
  ok(!!r && !!d, `D1 ${t.key} 那一档在两份文档的表里都还在`, `README ${r ? '在' : '不在'} · deliverable ${d ? '在' : '不在'}`);
  if (!r || !d) continue;
  ok(+r[3] === b.n && +d[3] === b.n, `D1 ${t.key} 关卡数 ${b.n} == library.stats() 现值（两份文档同一格）`,
    `README ${r[3]} / deliverable ${d[3]} vs 代码 ${b.n}`);
  ok(+r[4] === b.parMin && +r[5] === b.parMax && +d[4] === b.parMin && +d[5] === b.parMax,
    `D1 ${t.key} par 区间 ${b.parMin}–${b.parMax} == 实测现值`, `文档 ${r[4]}–${r[5]} / ${d[4]}–${d[5]} vs 代码 ${b.parMin}–${b.parMax}`);
  ok(+r[6] === b.parMed && +d[6] === b.parMed, `D1 ${t.key} par 中位 ${b.parMed} == 实测现值`,
    `README ${r[6]} / deliverable ${d[6]} vs 代码 ${b.parMed}`);
  ok(+r[7] === b.statesMin && +r[8] === b.statesMed && +r[9] === b.statesMax,
    `D1 ${t.key} 可通行局面 min/med/max == 实测现值`, `README ${r[7]}/${r[8]}/${r[9]} vs 代码 ${b.statesMin}/${b.statesMed}/${b.statesMax}`);
  ok(+d[9] === b.statesMin && +d[10] === b.statesMed && +d[11] === b.statesMax,
    `D1 ${t.key} deliverable 那一行的局面三格也等于实测现值`, `deliverable ${d[9]}/${d[10]}/${d[11]}`);
  ok(+r[10] === b.rolesMin && +r[11] === b.rolesMax && +d[7] === b.rolesMin && +d[8] === b.rolesMax,
    `D1 ${t.key} 角色数 ${b.rolesMin}–${b.rolesMax} == 实测现值`, `README ${r[10]}–${r[11]} / deliverable ${d[7]}–${d[8]}`);
  ok(+r[12] === b.ferry && +r[13] === b.free && +d[12] === b.ferry && +d[13] === b.free,
    `D1 ${t.key} 艄公船/自由船 ${b.ferry}/${b.free} == 实测现值（迷津那格 0 是量出来的，不许配平）`,
    `README ${r[12]}/${r[13]} · deliverable ${d[12]}/${d[13]} vs 代码 ${b.ferry}/${b.free}`);
  ok(+r[14] === b.pair && +r[15] === b.majority && +d[14] === b.pair && +d[15] === b.majority,
    `D1 ${t.key} 冲突家族 pair ${b.pair} · majority ${b.majority} == 实测现值`, `README ${r[14]}/${r[15]} vs deliverable ${d[14]}/${d[15]}`);
  ok(t.min === b.parMin && t.max === b.parMax, `D1 ${t.key} TIERS_META 的 min/max 与 stats() 是同一份（test/library 钉的同一条）`,
    `META ${t.min}-${t.max} vs stats ${b.parMin}-${b.parMax}`);
}
const campaignClaim = README.match(/(\d+) 关已烘焙（四档各 (\d+) 关）/);
ok(!!campaignClaim && +campaignClaim[1] === ALL.length && +campaignClaim[2] === S.byTier.shoal.n && ALL.length === 24,
  'D1c README 那句「24 关已烘焙（四档各 6 关）」等于产物行数',
  campaignClaim ? `文档 ${campaignClaim[1]} 关 / 各 ${campaignClaim[2]} vs 代码 ${ALL.length} 关 / 各 ${S.byTier.shoal.n}` : '解析不到那句');
const oddClaim = [...DOCS.matchAll(/难度带[^\n]*?(1-3 \/ 5-7 \/ 9-11 \/ 13-15)/g)].map(m => m[1]);
ok(oddClaim.length >= 2 && oddClaim.every(x => x === KEYS.map(k => `${S.byTier[k].parMin}-${S.byTier[k].parMax}`).join(' / ')),
  'D1d 文档写的带串 1-3/5-7/9-11/13-15 逐档等于实测 min-max',
  `${oddClaim.length} 处：${oddClaim[0] || '没有'} vs 代码 ${KEYS.map(k => `${S.byTier[k].parMin}-${S.byTier[k].parMax}`).join(' / ')}`);
const pars = ALL.map(l => l.par);
ok(pars.length === 24 && pars.every(p => p % 2 === 1),
  'D1e 产物里每一条 par 都是奇数（文档那句「每一个 par 都是奇数」的前提）', `${pars.length} 条，奇数 ${pars.filter(p => p % 2 === 1).length} 条`);
const delivParSeq = (DELIV.match(/`ALL\.map\(l=>l\.par\)` `?\s*\|?\s*`([\d,]+)`/) || [])[1];
ok(!!delivParSeq && delivParSeq === pars.join(','), 'D1f deliverable §2 抄的那串 par 逐位等于 ALL.map(l=>l.par)',
  delivParSeq ? `文档 ${delivParSeq.slice(0, 32)}… vs 代码 ${pars.join(',').slice(0, 32)}…` : '解析不到那串');
const delivRangeRow = DELIV.match(/浅滩 (\d+)–(\d+)、短渡 (\d+)–(\d+)、急流 (\d+)–(\d+)、迷津 (\d+)–(\d+)/);
ok(!!delivRangeRow && KEYS.every((k, i) => +delivRangeRow[i * 2 + 1] === S.byTier[k].parMin && +delivRangeRow[i * 2 + 2] === S.byTier[k].parMax),
  'D1g deliverable §3.2 那行「每档 par 范围（已发布，UI 印的）」等于实测现值',
  delivRangeRow ? `文档 ${delivRangeRow.slice(1, 9).join('-')}` : '解析不到那一行');
ok(KEYS.every((k, i) => i === 0 || S.byTier[KEYS[i - 1]].parMax < S.byTier[k].parMin),
  'D1h 四档互不重叠（README 与 DESIGN 都这么主张）', KEYS.map(k => `${S.byTier[k].parMin}-${S.byTier[k].parMax}`).join(' < '));

// ---- D2 锚点表：14 行题面在 js/core/solve.js 上重跑一遍 ----
const ANCHORS = [
  { spec: WGC, law: FERRY, cap: 2 },
  { spec: PAIR, law: FERRY, cap: 2 },
  ...[1, 2, 3, 4, 5].map(n => ({ spec: missionaries(n, FREE), law: FREE, cap: 2 })),
  ...[1, 2, 3, 4].map(n => ({ spec: missionaries(n, FERRY), law: FERRY, cap: 2 })),
  { spec: missionaries(4, FREE, 3), law: FREE, cap: 3 },
  { spec: missionaries(4, FERRY, 3), law: FERRY, cap: 3 },
  { spec: missionaries(6, FREE), law: FREE, cap: 2 },
];
const computed = ANCHORS.map(a => {
  const comp = compile(a.spec);
  const r = solve(a.spec);
  return { ok: r.ok, par: r.par, routes: r.routes, explored: r.explored, truncated: r.truncated, size: comp.size, n: comp.n };
});
const readmeAnchorRows = [...README.matchAll(
  /^\| (.+?) \| (艄公船|自由船)，(?:容量 (\d+)|船上 1\.\.2) \| \*\*(.+?)\*\* \| (\d+) \| (\d+) \/ (\d+)(（前沿耗尽）)? \|$/gm)];
ok(readmeAnchorRows.length === ANCHORS.length, `D2a README 的锚点表解析到 ${ANCHORS.length} 行（解析不到不等于通过）`,
  `解析 ${readmeAnchorRows.length} 行 vs 表 ${ANCHORS.length} 行`);
const delivAnchorRows = [...DELIV.matchAll(
  /^\| (.+?) \| `'?(ferry|free)'?`(?: cap (\d+))? \| (.+?) \| (?:\*\*(.+?)\*\*|—) \| (\d+) \| (\d+) \/ (\d+)(（前沿耗尽）)? \|$/gm)];
ok(delivAnchorRows.length === ANCHORS.length, `D2b deliverable §3.1 的锚点表也解析到 ${ANCHORS.length} 行`, `解析 ${delivAnchorRows.length} 行`);
readmeAnchorRows.forEach((m, i) => {
  const c = computed[i];
  const wantWord = ANCHORS[i].law === FERRY ? '艄公船' : '自由船';
  const capShown = m[3] === undefined ? 2 : +m[3];
  ok(m[2] === wantWord && capShown === ANCHORS[i].cap, `D2 第 ${i + 1} 行「${m[1].slice(0, 14)}」的船口径等于表钉的那一副`,
    `文档 ${m[2]} 容量 ${capShown} vs 代码 ${wantWord} 容量 ${ANCHORS[i].cap}`);
  const parDoc = m[4] === '不可解' ? null : +m[4];
  ok(c.ok === (parDoc !== null) && (parDoc === null || parDoc === c.par), `D2 第 ${i + 1} 行 par ${m[4]} == solve() 重算值`,
    `重算 ${c.ok ? c.par : '不可解'}（truncated=${c.truncated}）`);
  ok(+m[5] === c.routes, `D2 第 ${i + 1} 行最短路线条数 ${m[5]} == 重算值`, `重算 ${c.routes}`);
  ok(+m[6] === c.explored, `D2 第 ${i + 1} 行的可通行局面 == 重算的 explored`, `重算 ${c.explored}`);
  ok(+m[7] === c.size && c.size === 2 ** (c.n + 1), `D2 第 ${i + 1} 行状态空间 ${m[7]} == 2^(n+1)，n=${c.n}`, `重算 2^${c.n + 1}=${c.size}`);
  ok(!!m[8] === !c.ok, `D2 第 ${i + 1} 行的「（前沿耗尽）」只出现在真不可解的那几行`, `ok=${c.ok} truncated=${c.truncated}`);
});
delivAnchorRows.forEach((m, i) => {
  const c = computed[i];
  ok(m[2] === ANCHORS[i].law && (m[3] === undefined ? 2 : +m[3]) === ANCHORS[i].cap,
    `D2c deliverable 第 ${i + 1} 行的口径与容量等于表钉的那一副`, `文档 ${m[2]} cap ${m[3] || 2}`);
  const parDoc = /不可解/.test(m[4]) ? null : +m[4];
  ok(parDoc === null ? !c.ok : parDoc === c.par, `D2c deliverable 第 ${i + 1} 行「人类先写」的期望等于重算值`,
    `文档 ${m[4]} vs 重算 ${c.ok ? c.par : '不可解'}`);
  ok(+m[6] === c.routes && +m[7] === c.explored && +m[8] === c.size,
    `D2d deliverable 第 ${i + 1} 行的 routes/态数/状态空间等于重算值`, `文档 ${m[6]}/${m[7]}/${m[8]} vs 重算 ${c.routes}/${c.explored}/${c.size}`);
});
const maxRoutes = Math.max(...computed.map(c => (c.ok ? c.routes : 0)));
const routesDoc = DESIGN.match(/(\d+) 条，仍远在 `2\^53` 之内/);
ok(!!routesDoc && +routesDoc[1] === maxRoutes && maxRoutes < 2 ** 53,
  'D2e DESIGN §10 那句最大的最短路线条数等于重算的最大值，且仍在 2^53 之内（只比方向）',
  routesDoc ? `文档 ${routesDoc[1]} vs 重算 ${maxRoutes} < 2^53` : '解析不到那句');
const unsolvable = computed.filter(c => !c.ok).length;
const unsolvableDoc = [...README.matchAll(/\| \*\*不可解\*\* \|/g)].length;
ok(unsolvable === 5 && unsolvableDoc === 5, 'D2f 表里不可解的行数：文档抄的与重算的都是 5', `重算 ${unsolvable} · 文档 ${unsolvableDoc}`);
const cap3Pair = computed.find((c, i) => ANCHORS[i].law === FREE && ANCHORS[i].cap === 3 && ANCHORS[i].spec.title.startsWith('M&C 4+4'));
ok(!!cap3Pair && cap3Pair.ok, 'D2g 「同样 8 个人，船从容量 2 放宽到 3 就可解」这句主张由重算背书',
  cap3Pair ? `cap3 可解 par ${cap3Pair.par}` : '重算失败');

// ---- D3 node 层的断言条数：真跑一遍脚本，只数行数，不抄文档 ----
const suiteFiles = readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.test.mjs')).sort();
const counted = {};
for (const f of suiteFiles) {
  const r = spawnSync(process.execPath, [join(ROOT, 'test', f)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const m = (r.stdout || '').match(/rows: (\d+) fail: (\d+)/);
  ok(!!m, `D3a ${f} 打印了「rows: N fail: M」（闸换了形状就是这里红）`,
    m ? `${f} rows ${m[1]} fail ${m[2]}` : (r.stdout || r.stderr || '(没有输出)').slice(0, 80));
  counted[f.replace('.test.mjs', '')] = m ? { rows: +m[1], fail: +m[2] } : { rows: 0, fail: 1 };
  ok(!!m && +m[2] === 0 && r.status === 0, `D3 ${f} 现在就是全绿的（文档说 fail 0）`, `rc=${r.status} fail=${m ? m[2] : '?'}`);
}
const suiteTotal = Object.values(counted).reduce((a, b) => a + b.rows, 0);
const sixClaim = README.match(/六个 node 套件（(\d+) 条断言）/);
ok(!!sixClaim && +sixClaim[1] === suiteTotal && suiteFiles.length === 6,
  `D3b README 那句「六个 node 套件（N 条断言）」等于实跑的 ${suiteTotal} 条 / ${suiteFiles.length} 个文件`,
  sixClaim ? `文档 ${sixClaim[1]} 条 vs 实跑 ${suiteTotal} 条` : '解析不到那句');
const perSuite = [...README.matchAll(/`(anchors|river|game|library|make|storage)`\((\d+)\)/g)];
ok(perSuite.length === 6, `D3c README 逐套件的条数解析到 6 个（解析不到不等于通过）`, `解析 ${perSuite.length} 个`);
for (const m of perSuite) {
  ok(counted[m[1]] && counted[m[1]].rows === +m[2], `D3 ${m[1]} 套件 ${m[2]} 条 == 实跑 ${counted[m[1]] ? counted[m[1]].rows : '?'} 条`,
    `文档 ${m[2]} vs 实跑 ${counted[m[1]] ? counted[m[1]].rows : '?'}`);
}
const delivSum = DELIV.match(/\*\*断言行数 = (\d+) \+ (\d+) \+ (\d+) \+ (\d+) \+ (\d+) \+ (\d+) = (\d+)，fail = (\d+)，文件数 = (\d+)，rc = (\d+)。\*\*/);
ok(!!delivSum, 'D3d deliverable §7.2 那句加总解析到了（形状改了就是这里红）', delivSum ? delivSum[0].slice(0, 56) : '解析不到');
if (delivSum) {
  const order = ['anchors', 'game', 'library', 'make', 'river', 'storage'];
  ok(order.every((k, i) => counted[k].rows === +delivSum[i + 1]),
    `D3e deliverable 那六个加数逐个等于实跑的 ${order.map(k => counted[k].rows).join('+')}`, `文档 ${delivSum.slice(1, 7).join('+')}`);
  ok(+delivSum[7] === suiteTotal && +delivSum[8] === 0 && +delivSum[9] === suiteFiles.length && +delivSum[10] === 0,
    `D3f deliverable 的合计 ${suiteTotal} 条 / fail 0 / 文件数 ${suiteFiles.length} 与实跑相同`, `文档 ${delivSum[7]}/${delivSum[8]}/${delivSum[9]}`);
  const aggLine = (DELIV.match(/asserts=(\d+) fail=(\d+)/) || [])[1];
  ok(+aggLine === suiteTotal, `D3g deliverable 那条聚合命令的 asserts= 等于实跑总数`, `文档 ${aggLine} vs 实跑 ${suiteTotal}`);
}

// ---- D4 闸的形状：腿数、门线、端口、CI 的 job —— 全部取脚本与配置的现值 ----
const minRowsDoc = (README.match(/门线 ≥(\d+) 条/) || [])[1];
const minRows = (VERIFY.match(/^MIN_BROWSER_ROWS=\$\{MIN_BROWSER_ROWS:-(\d+)\}$/m) || [])[1];
ok(!!minRows && !!minRowsDoc && +minRowsDoc === +minRows, `D4a README 的门线等于 verify.sh 的 MIN_BROWSER_ROWS=${minRows}`,
  `文档 ${minRowsDoc} vs 脚本 ${minRows}`);
const legDoc = (README.match(/`(@boot @play @routes @save @pointer)`/) || [])[1];
const legs = ((VERIFY.match(/for s in \$\{SCENARIOS:-([^}]*)\}/) || [, ''])[1] || '').trim().split(/\s+/);
ok(legs.length === 5 && !!legDoc && legDoc.split(' ').map(x => x.slice(1)).join(' ') === legs.join(' '),
  `D4b 浏览器腿的名字与顺序逐条等于 verify.sh 的 SCENARIOS 默认值（${legs.join(' ')}）`, legDoc ? `文档 ${legDoc}` : `解析不到那句；脚本 ${legs.join(' ')}`);
ok(/五段/.test(README) && /五段合计 (\d+) 条/.test(DELIV), 'D4c 「五段」这个说法在两份文档里都还在（删一条腿就得同时改文档）',
  `README 有「五段」=${/五段/.test(README)} · deliverable=${(DELIV.match(/五段合计 (\d+) 条/) || [])[0] || '没有'}`);
const portServer = (SERVER.match(/Number\(process\.argv\[2\]\) \|\| Number\(process\.env\.PORT\) \|\| (\d+)/) || [])[1];
const portDoc = (README.match(/node server\.cjs\s+# http:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
const mapPort = (README.match(/零依赖静态服务器（默认 (\d+)）/) || [])[1];
const webPort = (VERIFY.match(/^WEB_PORT=\$\{WEB_PORT:-(\d+)\}$/m) || [])[1];
const cdpPort = (VERIFY.match(/^CDP_PORT=\$\{CDP_PORT:-(\d+)\}$/m) || [])[1];
const docWeb = (README.match(/`WEB_PORT=(\d+)`/) || [])[1];
const docCdp = (README.match(/`CDP_PORT=(\d+)`/) || [])[1];
const ptPort = (PLAYTEST.match(/process\.env\.CDP_PORT \|\| (\d+)/) || [])[1];
const ptBase = (PLAYTEST.match(/BASE_URL \|\| 'http:\/\/127\.0\.0\.1:(\d+)\/'/) || [])[1];
ok(!!portServer && !!portDoc && !!mapPort && !!webPort && !!cdpPort && !!docWeb && !!docCdp && !!ptPort && !!ptBase,
  'D4d 九个端口来源都解析到了（少一个就是接线改了形状）',
  `server ${portServer} · README ${portDoc}/${mapPort}/${docWeb}/${docCdp} · verify ${webPort}/${cdpPort} · playtest ${ptBase}/${ptPort}`);
ok([+portDoc, +mapPort].every(v => v === +portServer), `D4e README 两处默认端口等于 server.cjs 的现值 ${portServer}`, `文档 ${portDoc}/${mapPort}`);
ok(+docWeb === +webPort && +docCdp === +cdpPort, `D4f README 写的 verify 端口等于脚本现值（web ${webPort} · CDP ${cdpPort}）`, `文档 ${docWeb}/${docCdp}`);
ok(+ptPort === 9340 && +ptBase === 5180 && /9340\/5180 默认值/.test(DELIV),
  'D4g playtest 自己的默认值是文档点名的 9340/5180（verify.sh 靠 export 覆盖它们）', `playtest ${ptBase}/${ptPort}`);
const jobs = [...CI.slice(CI.indexOf('\njobs:')).matchAll(/^ {2}([a-z]+):$/gm)].map(m => m[1]);
const skipUnit = (README.match(/CI 里是两个 job，`ci\.yml` 的 browser job 用 `SKIP_UNIT=(\d)`/) || [])[1];
ok(jobs.length === 2 && jobs.includes('unit') && jobs.includes('browser') && skipUnit === '1',
  `D4h ci.yml 的 job 就是文档说的两个（${jobs.join('/')}），browser 带 SKIP_UNIT=1`, `job ${jobs.join('/')} · 文档 SKIP_UNIT=${skipUnit}`);
ok(/\$\{SKIP_UNIT:-\}/.test(VERIFY) && /SKIP_UNIT: 1/.test(CI), 'D4i SKIP_UNIT 这条线在脚本与 CI 里都接上了（不是文档里的装饰）',
  `verify=${/\$\{SKIP_UNIT:-\}/.test(VERIFY)} · ci=${/SKIP_UNIT: 1/.test(CI)}`);
const ciCallsLegs = /- name: Syntax\n\s+run: npm run check\b/.test(CI) && /- name: Suites\n\s+run: npm run unit\b/.test(CI);
ok(ciCallsLegs && /\bnode --check "\$f"/.test(PKG.scripts.check || '') && /test\/\*\.test\.mjs/.test(PKG.scripts.unit || ''),
  'D4j ci.yml 的 Syntax/Suites 两步就是调 `npm run check` / `npm run unit`，而这两条 leg 自己逐个 node 文件（本地绿＝那一步绿）',
  `ci 调 leg=${ciCallsLegs} · check=${/\bnode --check "\$f"/.test(PKG.scripts.check || '')} · unit=${/test\/\*\.test\.mjs/.test(PKG.scripts.unit || '')}`);
const inVerify = /node tools\/doctest\.mjs/.test(VERIFY);
const inCi = /node tools\/doctest\.mjs/.test(CI);
const inPkg = (PKG.scripts.doctest || '').trim() === 'node tools/doctest.mjs';
const inReadme = /node tools\/doctest\.mjs/.test(README);
ok(inVerify && inCi && inPkg && inReadme,
  'D4k 这道闸接进了 verify.sh、ci.yml 的 check job、package.json 与 README 的复跑块（CI 与本地调同一个脚本）',
  `verify=${inVerify} ci=${inCi} pkg=${inPkg} README=${inReadme}`);
// 台账自己也要"接得进来"：tools/sabotage.mjs 存在但没人调用，和没有这个文件是同一件事——
// 2026-10-03 之前它在这仓就是第七道"看起来有、实际没跑"的闸，所以这一条拿四处同源钉它。
const sabVerify = /node tools\/sabotage\.mjs/.test(VERIFY);
const sabCi = /node tools\/sabotage\.mjs/.test(CI);
const sabPkg = (PKG.scripts.sabotage || '').trim() === 'node tools/sabotage.mjs';
const sabReadme = /node tools\/sabotage\.mjs/.test(README);
ok(sabVerify && sabCi && sabPkg && sabReadme,
  'D4n 破坏台账接进了 verify.sh、ci.yml 的 check job、package.json 与 README（四处缺一处它就只是一段代码）',
  `verify=${sabVerify} ci=${sabCi} pkg=${sabPkg} README=${sabReadme}`);
const minLogic = (VERIFY.match(/^MIN_LOGIC_ROWS=\$\{MIN_LOGIC_ROWS:-(\d+)\}$/m) || [])[1];
ok(!!minLogic && +minLogic === suiteTotal, `D4l verify.sh 的 logic 档门线等于实跑的 node 断言总数（${suiteTotal}），只增不减`,
  `脚本 ${minLogic} vs 实跑 ${suiteTotal}`);
ok(/exit 6/.test(VERIFY) && /`exit 6`/.test(README), 'D4m :9348 被占用时 exit 6 这条保护在脚本与文档里都还在',
  `verify=${/exit 6/.test(VERIFY)} README=${/`exit 6`/.test(README)}`);

// ---- D5 代码常数：文档写的数 == 代码里的数 ----
const maxRolesDoc = [...DOCS.matchAll(/`MAX_ROLES = (\d+)`/g)].map(m => +m[1]);
ok(maxRolesDoc.length >= 1 && maxRolesDoc.every(v => v === MAX_ROLES),
  `D5a 文档写的 MAX_ROLES 处处等于 river.js 现值 ${MAX_ROLES}`, `解析 ${maxRolesDoc.length} 处：${maxRolesDoc.join('/')} vs 代码 ${MAX_ROLES}`);
const twelveStates = [...DOCS.matchAll(/12 角色 = (\d+) 个态|n = 12 时是 (\d+) 个态/g)].map(m => +(m[1] || m[2]));
ok(twelveStates.length >= 2 && twelveStates.every(v => v === 2 ** (MAX_ROLES + 1)),
  `D5b 文档那句「12 角色 = ${2 ** (MAX_ROLES + 1)} 个态」== 2^(MAX_ROLES+1)`, `解析 ${twelveStates.length} 处：${twelveStates.join('/')}`);
const eightStates = (DESIGN.match(/8 角色 = (\d+) 个态/) || [])[1];
const shippedMaxRoles = Math.max(...ALL.map(l => l.roles));
ok(!!eightStates && +eightStates === 2 ** (shippedMaxRoles + 1), `D5c 「8 角色 = 512 个态」里的 8 等于产物里真的最大角色数 ${shippedMaxRoles}`,
  `文档 ${eightStates} vs 代码 ${2 ** (shippedMaxRoles + 1)}`);
const genMaxRoles = Math.max(...GEN_TIERS.map(t => t.roles[1]));
const genRoleDocs = [...DOCS.matchAll(/生成器只出到 (\d+)|生成的关卡只到 (\d+)/g)].map(m => +(m[1] || m[2]));
ok(genRoleDocs.length >= 2 && genRoleDocs.every(v => v === genMaxRoles),
  `D5d 文档那句「只出到 ${genMaxRoles}」== make.js TIERS 的 roles 上界现值`, `解析 ${genRoleDocs.length} 处：${genRoleDocs.join('/')} vs 代码 ${genMaxRoles}`);
const hintLimit = (GAME.match(/limit: (\d+)/) || [])[1];
const limitDocs = [...DOCS.matchAll(/`limit = (\d+)`/g)].map(m => +m[1]);
ok(!!hintLimit && limitDocs.length >= 2 && limitDocs.every(v => v === +hintLimit),
  `D5e 文档写的 hint 预算处处等于 game.js 现值 ${hintLimit}`, `解析 ${limitDocs.length} 处：${limitDocs.join('/')} vs 代码 ${hintLimit}`);
const shippedMaxStates = Math.max(...ALL.map(l => l.states));
const worstDocs = [...DOCS.matchAll(/最坏探索 (\d+) 态|实测最多探索 (\d+) 态|最大搜索 (\d+) 态/g)].map(m => +(m[1] || m[2] || m[3]));
ok(worstDocs.length >= 3 && worstDocs.every(v => v === shippedMaxStates),
  `D5f 文档反复引用的「最坏探索 ${shippedMaxStates} 态」== 产物里的最大 states（结构数字，不是毫秒）`, `解析 ${worstDocs.length} 处：${worstDocs.join('/')}`);
const grades = [...GAME.matchAll(/if \(over <= (\d+)\) return \{ key: '(\w+)', label: '([^']+)', stars: (\d) \}/g)];
const gradeDoc = README.match(/走完 par 单程 = ★★★ (\S+?)；超出 (\d+)–(\d+) 单程 = ★★ (\S+?)；/);
ok(grades.length === 2 && grades[0][1] === '0' && grades[1][1] === '2' && grades[0][4] === '3' && grades[1][4] === '2',
  'D5g grade() 现在的阈值就是 over<=0 → 3★、<=2 → 2★（文档那句「超出 1–2」的出处）', grades.map(g => `over<=${g[1]}→${g[4]}★`).join(' · '));
ok(!!gradeDoc && gradeDoc[1] === grades[0][3] && gradeDoc[4] === grades[1][3] && +gradeDoc[3] === +grades[1][1],
  `D5 评星文案与上界等于 game.js 的 grade() 现值（${grades[0][3]} / ${grades[1][3]} / 曲折抵达）`,
  gradeDoc ? `文档 ${gradeDoc[1]} / 超出 ${gradeDoc[2]}–${gradeDoc[3]} / ${gradeDoc[4]}` : '解析不到 README 那句');
const farFrac = (VIEW.match(/const far = Math\.abs\(haul\.dx\) > Math\.abs\(travel\) \* ([\d.]+)/) || [])[1];
const farDocs = [...DOCS.matchAll(/两码头间距的 (\d+)%|0\.45 × 两码头间距/g)].map(m => (m[1] ? +m[1] : 45));
ok(!!farFrac && farDocs.length >= 2 && farDocs.every(v => v === Math.round(+farFrac * 100)),
  `D5h 「拖到对岸」的判定线处处等于 view.js 现值 ${farFrac}`, `解析 ${farDocs.length} 处：${farDocs.join('/')} vs 代码 ${farFrac}`);
const boatCap = (VIEW.match(/Math\.round\(waterW \* ([\d.]+)\)/) || [])[1];
const capDoc = (DESIGN.match(/船体另外封顶在水宽的 (\d+)%/) || [])[1];
ok(!!boatCap && !!capDoc && +capDoc === Math.round(+boatCap * 100),
  `D5i DESIGN 那句「封顶在水宽的 ${capDoc}%」等于 view.js 的 boatW 上限 ${boatCap}`, `文档 ${capDoc}% vs 代码 ${boatCap}`);
const tables = [...SOLVE.matchAll(/new (Int16Array|Int32Array)\(/g)].map(m => m[1]);
const bytesDoc = (DESIGN.match(/约 8192 × (\d+) 字节/) || [])[1];
ok(tables.length === 4 && !!bytesDoc && +bytesDoc === 2 + 4 * 3,
  'D5j solve.js 现在就是四张定长表（1×Int16 + 3×Int32 = 14 字节），与 §10 那句一致', `解析 ${tables.length} 张：${tables.join('/')} · 文档 ${bytesDoc} 字节`);
ok(/const ways = new Float64Array\(size\)/.test(SOLVE) && /用 `Float64Array` 累加/.test(DESIGN),
  'D5k 条数累加确实是 Float64Array（DESIGN 把它写成「会溢出那一类」的钉）', `solve=${/Float64Array/.test(SOLVE)} DESIGN=${/Float64Array/.test(DESIGN)}`);
const realHash = String(hashSeed('a'));
const hashHits = [...DOCS.matchAll(new RegExp(realHash, 'g'))].length;
const FNV1A = (() => { let h = 2166136261; for (const ch of 'a') h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; })();
ok(hashHits >= 1, `D5l 文档印的 hashSeed("a") 读数等于 rng.js 现在算出来的 ${realHash}`, `文档命中 ${hashHits} 处`);
ok(FNV1A === 3826002220 && DOCS.includes('3826002220'),
  'D5m 教科书 FNV-1a 仍是 3826002220（「两个数不相等」那句靠这两个数背书）', `重算 ${FNV1A}`);
const perTier = (BAKE.match(/const PER_TIER = Number\(process\.env\.PER_TIER \|\| (\d+)\);/) || [])[1];
const collect = (BAKE.match(/const COLLECT = Number\(process\.env\.COLLECT \|\| (\d+)\);/) || [])[1];
const seedsDoc = (DELIV.match(/(\d+) 颗种子（(\d+) 档 × (\d+)）/) || [])[1];
ok(!!perTier && !!collect && +perTier === S.byTier.shoal.n && !!seedsDoc && +seedsDoc === +collect * GEN_TIERS.length && +collect * GEN_TIERS.length === 160,
  `D5n bake 的 PER_TIER=${perTier} / COLLECT=${collect} 等于「四档各 6 关」与「160 颗种子 = 4 档 × 40」`, `脚本 ${perTier}/${collect} vs 文档 ${seedsDoc}`);
ok(GEN_TIERS.length === META.length && GEN_TIERS.every((g, i) => g.key === META[i].key && g.label === META[i].label),
  `D5o make.js 的 ${GEN_TIERS.length} 档与 TIERS_META 的档名/键一一对应（换档要同时换文档）`,
  GEN_TIERS.map(g => g.key).join(' ') + ' vs ' + META.map(t => t.key).join(' '));
const lawKeys = Object.keys(LAWS);
const lawDocCount = (README.match(/`boat\.rule = '(ferry|free)'`/g) || []).length;
ok(lawKeys.length === 2 && lawDocCount === 2 && LAWS.ferry.name === '艄公船' && LAWS.free.name === '自由船',
  `D5p 「两条船的口径」就是 LAWS 的两条现值（${lawKeys.join('/')} = 艄公船/自由船）`,
  `LAWS ${lawKeys.join('/')} · README 引用 ${lawDocCount} 次`);
ok(/艄公.*必须.*在船上/.test(LAWS.ferry.rule) && /0\.\.capacity-1/.test(LAWS.ferry.rule) && /1\.\.capacity/.test(LAWS.free.rule),
  'D5q LAWS 的文案里那两段容量口径与 README 用的是同一句（0..capacity-1 / 1..capacity）',
  `ferry「${LAWS.ferry.rule}」 free「${LAWS.free.rule}」`);

// ---- D6 引用锚点：文档写「file:NN 的那个东西」，NN 那一行现在得真坐着它 ----
const CITES = [
  ['river.js 的 MAX_ROLES', /js\/core\/river\.js:(\d+)` 的 `MAX_ROLES/, 'js/core/river.js', /^export const MAX_ROLES = \d+;$/],
  ['game.js 的 hint()', /js\/core\/game\.js:(\d+)` 的 `hint\(\)/, 'js/core/game.js', /^export function hint\(game\) \{$/],
  ['game.js 的 grade()', /js\/core\/game\.js:(\d+)` 的 `grade\(\)`/, 'js/core/game.js', /^export function grade\(game\) \{$/],
  ['make.js 的 TIERS', /js\/core\/make\.js:(\d+)` 的 `TIERS`/, 'js/core/make.js', /^export const TIERS = \[$/],
  ['make.js 的 scatter()', /js\/core\/make\.js:(\d+)` 的 `scatter\(\)`/, 'js/core/make.js', /^export function scatter\(seed, tier, stats\) \{$/],
  ['loadingFault 在 river.js', /`loadingFault`，`js\/core\/river\.js:(\d+)/, 'js/core/river.js', /^export function loadingFault\(/],
  ['cross() 在 river.js', /`cross\(\)`，`js\/core\/river\.js:(\d+)/, 'js/core/river.js', /^export function cross\(/],
  ['lots.js 的 TIERS_META', /lots\.js[`: ]+(?:第 )?(\d+)/, 'js/data/lots.js', /^export const TIERS_META = /],
  ['bake 量出 TIERS_META 那一处', /tools\/bake\.mjs:(\d+)`[^|]{0,40}?(实际入库的行|从 `out` 里量出来)/, 'tools/bake.mjs', /^const meta = TIERS\.map/],
  ['bake 的 par 复验', /tools\/bake\.mjs:(\d+)`（par 不符）/, 'tools/bake.mjs', /par \$\{lot\.rating\.par\} not reproducible/],
  ['bake 的 routes 复验', /`:(\d+)`（routes 不符）/, 'tools/bake.mjs', /route count \$\{lot\.rating\.routes\} not reproducible/],
  ['bake 的 truncated 复验', /`:(\d+)`（搜索被截断/, 'tools/bake.mjs', /search truncated/],
  ['bake 的战役顺序', /tools\/bake\.mjs:(\d+)`）/, 'tools/bake.mjs', /^  picked\.sort\(/],
  ['verify.sh 的门线', /tools\/verify\.sh:(\d+)` 的门线/, 'tools/verify.sh', /^MIN_BROWSER_ROWS=/],
  ['verify.sh 的 console 门', /tools\/verify\.sh:(\d+)` 的 console 门/, 'tools/verify.sh', /grep -q 'EXCEPTION'/],
  ['playtest 的 @pointer 分派', /tools\/playtest\.mjs:(\d+)`）跑在 Node 侧/, 'tools/playtest.mjs', /^ {6}if \(name === 'pointer'\) \{$/],
  ['playtest 的 waitShell()', /`waitShell\(\)`（`tools\/playtest\.mjs:(\d+)`）/, 'tools/playtest.mjs', /const waitShell = async/],
  ['playtest 的 SCENARIOS', /tools\/playtest\.mjs:(\d+)`（`SCENARIOS`）/, 'tools/playtest.mjs', /^const SCENARIOS = \{$/],
  ['anchors 的 layerSearch()', /test\/anchors\.test\.mjs:(\d+)` 的 `layerSearch\(\)`/, 'test/anchors.test.mjs', /^function layerSearch\(/],
  ['make.test 的奇数钉', /test\/make\.test\.mjs:(\d+)` 断言/, 'test/make.test.mjs', /eq\(r\.par % 2, 1/],
  ['main.js 的 window.ferry', /`window\.ferry\.state\.id` 在 `js\/main\.js:(\d+)`/, 'js/main.js', /^window\.ferry = \{$/],
  ['main.js 的 state.id', /`js\/main\.js:4\d\d`\+`:(\d+)`/, 'js/main.js', /id: lot && lot\.id,/],
  ['main.js 不接 visibilitychange', /`js\/main\.js:(\d+)` 显式不接这个事件/, 'js/main.js', /^\/\/ Deliberately not paused on visibilitychange/],
  ['index.html 的 id="lot"', /`index\.html:(\d+)`/, 'index.html', /id="lot"/],
  ['fixture 的 WGC_ROUTE', /`test\/fixture\.mjs:(\d+)` `WGC_ROUTE`/, 'test/fixture.mjs', /^export const WGC_ROUTE = \[$/],
  ['verify.sh 的占用即退', /换端口继续（`:(\d+)-/, 'tools/verify.sh', /^if curl -fsS -m 1 "http:\/\/127\.0\.0\.1:\$CDP_PORT/],
  ['verify.sh 的 cleanup', /（`:(\d+)-57`/, 'tools/verify.sh', /^cleanup\(\) \{$/],
  ['verify.sh 的看门狗 kill', /`:(\d+)`），\n\s*并且用 `pgrep/, 'tools/verify.sh', /^kill \$WD 2>\/dev\/null$/],
  ['verify.sh 的软件光栅禁令', /flag（`:(\d+)-8` 的注释）/, 'tools/verify.sh', /^# Do NOT add --use-gl=angle/],
  ['playtest 的三条腿', /`:(\d+)`（`@pointer` = 三条腿）/, 'tools/playtest.mjs', /^const INPUT_LEGS = \{/],
];
const lineOf = (file, re) => read(file).split('\n').findIndex(l => re.test(l)) + 1;
for (const [what, docRe, file, srcRe] of CITES) {
  const real = lineOf(file, srcRe);
  const nums = [...DOCS.matchAll(new RegExp(docRe.source, 'g'))].map(m => +m[1]);
  ok(real > 0, `D6 代码侧出处「${what}」解析到了（找不到就是空转）`, `${file}:${real}`);
  ok(nums.length >= 1 && nums.every(n => n === real),
    `D6 文档引用的「${what}」等于 ${file} 现在的第 ${real} 行`,
    nums.length ? `文档写的是 ${[...new Set(nums)].join('/')}，代码现在坐在第 ${real} 行` : '文档里解析不到这条引用');
}
const storageLines = (DELIV.match(/`js\/core\/storage\.js:([\d,]+)`/) || [])[1];
const storageHits = storageLines ? storageLines.split(',') : [];
ok(storageHits.length === 4 && storageHits.every(n => /window\.localStorage/.test(read('js/core/storage.js').split('\n')[+n - 1] || '')),
  `D6s deliverable 说的「DOM 命中全在 storage.js:${storageLines}」这 ${storageHits.length} 行现在真的都读 window.localStorage`,
  storageHits.map(n => `${n}:${/window\.localStorage/.test(read('js/core/storage.js').split('\n')[+n - 1] || '') ? '有' : '没有'}`).join(' '));
const cites = [...DOCS.matchAll(/((?:[\w.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|sh|json|html|yml)):(\d+)(?:-(\d+))?/g)];
const bad = [];
for (const c of cites) {
  let src;
  try { src = read(c[1]); } catch { bad.push(`${c[1]}:${c[2]}（文件不存在）`); continue; }
  const n = src.split('\n').length;
  if (+c[2] > n || (+c[3] && +c[3] > n)) bad.push(`${c[1]}:${c[2]}${c[3] ? '-' + c[3] : ''}（该文件只有 ${n} 行）`);
}
ok(cites.length >= 50, `D6z 文档里的行号引用解析到 ${cites.length} 条（少于 50 条说明引用格式被改了）`, `${cites.length} 条`);
ok(bad.length === 0, 'D6y 每一条 path:NN 引用都落在真实文件的行数内', bad.length ? `越界：${bad.join('，')}` : `${cites.length} 条全部在范围内`);

// ---- D7 文档点名的文件都还在树里，文件地图也是 ----
const mentioned = [...new Set([...DOCS.matchAll(/(?:tools|js|test)\/[\w./-]+\.(?:js|mjs|cjs|sh|html)/g)].map(m => m[0]))];
const missing = mentioned.filter(x => !existsSync(join(ROOT, x)));
ok(mentioned.length >= 18 && missing.length === 0, `D7 文档点名的 ${mentioned.length} 个 tools/ js/ test/ 文件都还在树里`,
  missing.length ? `不存在：${missing.join('，')}` : `${mentioned.length} 个全部存在`);
const fileMap = (README.match(/## 文件地图\n+```[a-z]*\n([\s\S]*?)\n```/) || [])[1];
const mapEntries = (fileMap || '').split('\n').map(l => l.trim().split(/\s+/)[0]).filter(x => /\.\w+$/.test(x));
ok(mapEntries.length >= 18 && mapEntries.every(x => existsSync(join(ROOT, x))),
  `D7b README 的文件地图解析到 ${mapEntries.length} 条且逐个存在（新增一道闸就得同时上地图）`,
  mapEntries.filter(x => !existsSync(join(ROOT, x))).join('，') || `地图 ${mapEntries.length} 条`);
ok(/tools\/doctest\.mjs/.test(fileMap || '') && /tools\/sabotage\.mjs/.test(fileMap || ''),
  'D7c 文件地图里有 doctest 与 sabotage 这两把新件（闸加了，地图也得加）', `doctest=${/doctest/.test(fileMap || '')} sabotage=${/sabotage/.test(fileMap || '')}`);
const deliverMap = (DELIV.match(/## 1\. 文件清单[\s\S]*?(?=\n## 2\.)/) || [''])[0];
const deliverPaths = [...new Set((deliverMap.match(/(?:tools|js|test)\/[\w./-]+\.(?:js|mjs|cjs|sh|html)/g) || []))];
ok(deliverPaths.length >= 12 && deliverPaths.every(x => existsSync(join(ROOT, x))),
  `D7d deliverable 的文件清单点到 ${deliverPaths.length} 个文件都在树里`, deliverPaths.filter(x => !existsSync(join(ROOT, x))).join('，') || `在树里`);

// ---- D8 两份文档不许各说各话 ----
for (const [what, re] of [['浅滩行的局面三格', /6 \/ 10 \/ 14/g], ['迷津行的局面三格', /160 \/ 160 \/ 212/g]]) {
  // 台账那几行会把读数原样抄一遍（那是刀的「改成」列），所以数副本的时候先把它们摘掉
  const c = (stripLedger(README).match(re) || []).length + (stripLedger(DELIV).match(re) || []).length;
  ok(c === 2, `D8 ${what}在 README 与 deliverable 各一次（第三处就是有人另抄了一份读数）`, `${c} 处`);
}

// ---- D9 墙钟那一类：只比方向、不比数值，也不许把新测的毫秒当现值 ----
const msClaims = [...DOCS.matchAll(/最慢一题 (\d+) ms|单题最慢 (\d+) ms/g)].map(m => +(m[1] || m[2]));
const driftNote = [...DOCS.matchAll(/(耗时[^\n]{0,20}漂|计时数字不逐位可复现|耗时随机器负载走)/g)].map(m => m[1]);
ok(msClaims.length >= 2 && msClaims.every(v => v === 1126) && driftNote.length >= 2,
  'D9a 文档引用的「最慢一题 1126 ms」是同一个读数，且两处以上写明这一列会漂',
  `解析 ${msClaims.length} 处读数：${[...new Set(msClaims)].join('/')} · 漂的声明 ${driftNote.length} 处`);
ok(!/\b(1110|2414) ms\b/.test(README), 'D9b README 没把另两次的毫秒抄成现值（墙钟只留在 DESIGN 的来历里）',
  `README 命中=${/\b(1110|2414) ms\b/.test(README)}`);

// ---- D10 unpinned 清单：确实没有代码出处的那一类，钉不住，但也不许被删掉来变绿 ----
const UNPINNED = [
  ['烘焙实测块（seeds/levels/unique/变异接受/每档秒数）', README, /shoal\s+seeds 40 → levels 40/],
  ['scatter 顶档定点实测（probed 3521 · 1.14% · 62.3%）', DESIGN, /probed 3521 个随机题面/],
  ['balance 的中位与最慢毫秒（123 ms / 1812 ms）', README, /一颗种子中位 123 ms、最慢 1812 ms/],
  ['浏览器五段的实测条数（116 与分段读数）', README, /五段合计 116 条、fail 0/],
  ['@pointer 三条腿的实测分布（mouse 35 / touch 18 / keys 11）', README, /mouse 35 \/ touch 18 \/ keys 11/],
  ['§7.1 的历史事故读数（船体 562→214、码头距 2 px→350 px）', DESIGN, /两码头中心距 `dock\[1\]-dock\[0\]`/],
  ['烘焙产物 md5 与「三次相同」的来历', DESIGN, /caaf916210af2a3e828c07c52317a303/],
  ['观感文案（练习与谜题的那句比喻）', DESIGN, /"7 步穿过 40 个态"是练习/],
  ['代码注释里的旧读数登记（0.4% vs 1.14% 那一段）', DESIGN, /0\.4% vs 1\.14%/],
];
for (const [what, src] of UNPINNED.map(x => [x[0], x[1]])) {
  const re = UNPINNED.find(x => x[0] === what)[2];
  ok(re.test(src), `D10 unpinned 那一条还写在文档里（钉不住≠可以删）：${what}`, '出处在案');
}
ok(UNPINNED.length >= 8, `D10a unpinned 清单登记到 ${UNPINNED.length} 处（这一类没有代码出处，不硬钉）`, `${UNPINNED.length} 处`);
const msArith = DELIV.match(/无提升 (\d+) · 判不可解 (\d+) · 超带 (\d+) · 人数不合 (\d+) · 低于带 (\d+) · 同数平移 (\d+)/);
ok(!!msArith, 'D10b deliverable 那行弃因合计解析到了（它属于烘焙实测那一类，只登记不钉死）', msArith ? msArith[0].slice(0, 40) : '解析不到');

// ---- D11 破坏试验台账：文档表的每一格 == sabotage.mjs 里的那一把 ----
// 台账行里的针与「改成」会把竖线写成 `\|`（不然这张表自己就散了），所以先占位再拆列。
const PH = String.fromCharCode(1);
const strip = s => s.trim().replace(/^`{1,2}/, '').replace(/`{1,2}$/, '').trim();
const ledger = README.split('\n').filter(l => /^\| S\d+ \| /.test(l)).map(l => {
  const c = l.replace(/\\\|/g, PH).split('|').slice(1, -1);
  return { id: strip(c[0]), where: strip(c[1]), file: strip(c[2]).replace(new RegExp(PH, 'g'), '|'),
    needle: strip(c[3]).replace(new RegExp(PH, 'g'), '|'), repl: strip(c[4]).replace(new RegExp(PH, 'g'), '|'),
    expect: strip(c[5]).replace(new RegExp(PH, 'g'), '|'), rc: strip(c[6]) };
});
const knifeIds = [...SAB.matchAll(/id: '(S\d+)'/g)].map(m => m[1]);
ok(ledger.length === knifeIds.length && knifeIds.length >= 3,
  `D11a README 台账解析到 ${knifeIds.length} 把刀，与 sabotage.mjs 里的条数相同（解析不到不等于通过）`,
  `文档 ${ledger.length} 行 vs 脚本 ${knifeIds.length} 把：${knifeIds.join(' ')}`);
const knifeCountDoc = (README.match(/破坏试验台账（(\d+) 把刀）/) || [])[1];
ok(!!knifeCountDoc && +knifeCountDoc === knifeIds.length, 'D11b 台账标题那句「N 把刀」等于脚本里的刀数',
  `文档 ${knifeCountDoc} vs 脚本 ${knifeIds.length}`);
for (const r of ledger) {
  ok(knifeIds.includes(r.id), `D11 ${r.id} 这一把在脚本里还在`, `${r.where}`);
  ok(existsSync(join(ROOT, r.file)), `D11 ${r.id} 打的文件 ${r.file} 还在树里`, '文件在树里');
  for (const [col, v] of [['针', r.needle], ['改成', r.repl], ['期望红行', r.expect]]) {
    ok(SAB.includes(v), `D11 ${r.id} 台账的「${col}」列与 sabotage.mjs 里那一把逐字相同`, `${col}：${v.slice(0, 30)}`);
  }
  ok(/^\d+$/.test(r.rc), `D11 ${r.id} 的 rc 是脚本读回来的数字（? 表示这一版台账还没整跑过）`, `rc=${r.rc}`);
}

// ---- D12 自数：这道闸自己发出的标签组数 ----
const dMentions = [...new Set((DOCS.match(/(?<![A-Za-z0-9_])D\d+/g) || []))].map(x => +x.slice(1));
ok(dMentions.every(v => emitted.has(`D${v}`)), 'D12 文档点名的每个 D 编号这一次都真的跑了（删掉一组就会红）',
  `文档点到 ${dMentions.sort((a, b) => a - b).join(',') || '（无）'}`);
ok(emitted.size === 12, `D12a 这道闸自己是十二组：本次发出 ${emitted.size} 个 D 标签`, `${emitted.size} 组`);
// README 的「跑起来」里写了这道闸自己发多少项：加一项、减一项都必须同步改文档，
// 否则文档就在数一个不存在的数——这一条把自己也算进去了。
const selfClaim = (README.match(/doctest\.mjs[^\n]*?（(\d+) 项/) || [])[1];
ok(!!selfClaim && +selfClaim === rows + 1, 'D12b README 写的「N 项」等于本闸这一次实际发出的项数（含这一条自己）',
  `文档 ${selfClaim || '（解析不到）'} vs 本次合计 ${rows + 1} 项`);

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`rows: ${rows} fail: ${fail.length}`);
if (fail.length) {
  for (const f of fail) console.log(`  未过：${f}`);
  process.exit(1);
}
