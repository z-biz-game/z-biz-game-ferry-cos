// 破坏试验台账：把每一类谎各写回一份**临时副本**里一遍，看文档闸会不会**点名**变红。
//
// 用法：node tools/sabotage.mjs          跑 README「破坏试验台账」里的全部刀
//       node tools/sabotage.mjs S1 S4    只跑点名的几把（调试用）
//
// 为什么要有这个文件：一份全绿的 doctest 只说明"这一轮文档与代码对得上"，它没说**闸会不会红**。
// 台账每一行那个 rc 必须由脚本从子进程读回来，不能抄。
//
// 四条硬规矩（与 kurotto-cos 同机制，但这一版更严）：
//   1. 刀**只改临时副本**：仓里的真文件一个字都不动，跑完删副本；开工前后各比一次 git status，
//      树上多出东西就是这把刀打错了地方，立刻停。
//   2. 针必须在目标文件里唯一命中（README 的台账行自己会把针抄一遍，那些命中不算）：
//      命中 0 次或 >1 次都是 ERROR，"打不中却一声不响跑完"是台账最坏的失败。
//   3. rc != 0 **且**输出点名了它那一条 FAIL 行才算红；语法炸了也是 rc != 0，但那不是闸红。
//   4. 退出码写进日志工件（GATE_RC=），任何一把刀没把闸弄红就整体判红并点名是哪把。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(ROOT, '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const die = msg => { console.log(`  ERROR ${msg}`); process.exit(2); };
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 600000 });
  if (r.error) die(`${cmd} 起不来：${r.error.message}`);
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const gitStatus = () => sh('git', ['status', '--porcelain']).out.trim();

// ---- 刀谱：每一把做一个最小扰动，然后要求 doctest 点名那一条 FAIL ----
const KNIVES = [
  { id: 'S1', where: '文档抄的实测读数漂一格', file: 'README.md', needle: '| 迷津 labyrinth | 6 | 13–15 | 15 | 160 / 160 / 212 |',
    repl: '| 迷津 labyrinth | 6 | 13–15 | 15 | 161 / 160 / 212 |', expect: 'D1 labyrinth 可通行局面 min/med/max == 实测现值', cmd: 'node tools/doctest.mjs' },
  { id: 'S2', where: '代码改了常数、文档还引用旧值', file: 'js/core/river.js', needle: 'export const MAX_ROLES = 12;',
    repl: 'export const MAX_ROLES = 11;', expect: 'D5a 文档写的 MAX_ROLES 处处等于 river.js 现值', cmd: 'node tools/doctest.mjs' },
  { id: 'S3', where: '文档的行号引用指回旧位置', file: 'README.md', needle: '`js/core/make.js:431` 的 `TIERS`',
    repl: '`js/core/make.js:430` 的 `TIERS`', expect: 'D6 文档引用的「make.js 的 TIERS」', cmd: 'node tools/doctest.mjs' },
  { id: 'S4', where: '表格被改形状：正则一条都不命中', file: 'README.md', needle: '| 浅滩 shoal | 6 | 1–3 | 3 |',
    repl: '| 浅滩 shoal | 6 | 1-3 | 3 |', expect: 'D1a README 的难度带表解析到 4 行', cmd: 'node tools/doctest.mjs' },
  { id: 'S5', where: '锚点表里某个态数被改一个位', file: 'README.md', needle: '**11** | 8100 | 64 / 128 |',
    repl: '**11** | 8100 | 65 / 128 |', expect: 'D2 第 5 行的可通行局面 == 重算的 explored', cmd: 'node tools/doctest.mjs' },
  { id: 'S6', where: '门线被调低（浏览器腿可以少一半）', file: 'tools/verify.sh', needle: 'MIN_BROWSER_ROWS=${MIN_BROWSER_ROWS:-38}',
    repl: 'MIN_BROWSER_ROWS=${MIN_BROWSER_ROWS:-19}', expect: 'D4a README 的门线等于 verify.sh 的 MIN_BROWSER_ROWS', cmd: 'node tools/doctest.mjs' },
  { id: 'S7', where: '现场搜索的预算被改小、文档还写着 40000', file: 'js/core/game.js', needle: 'limit: 40000 }',
    repl: 'limit: 4000 }', expect: 'D5e 文档写的 hint 预算处处等于 game.js 现值', cmd: 'node tools/doctest.mjs' },
];
const only = process.argv.slice(2);
const picked = only.length ? KNIVES.filter(k => only.includes(k.id)) : KNIVES;
if (only.length && picked.length !== only.length) die(`点名的刀有几把不在刀谱上：${only.filter(x => !picked.some(k => k.id === x)).join(' ')}`);
if (!picked.length) die('一把刀都没选中');

// ---- 预检：针唯一命中（台账行里的那些命中不算）、期望点名的那条断言得真的写在闸里 ----
const PH = String.fromCharCode(1);
const target = (src, needle) => {
  const lines = src.split('\n');
  const ledger = lines.map((l, i) => /^\| S\d+ \| /.test(l) ? i : -1).filter(i => i >= 0);
  const isLedger = pos => { let up = 0; for (let i = 0; i < lines.length; i++) { up += lines[i].length + 1; if (up > pos) return ledger.includes(i); } return false; };
  const at = [];
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) if (!isLedger(i)) at.push(i);
  return at;
};
const DOCTEST = read('tools/doctest.mjs');
for (const k of picked) {
  let src;
  try { src = read(k.file); } catch { die(`${k.id} 的文件不存在：${k.file}`); }
  const hits = target(src, k.needle).length;
  if (hits !== 1) die(`${k.id} 的针在 ${k.file} 的台账行之外命中 ${hits} 次（必须恰好 1 次；打不中或打多了都不许跑）`);
  if (k.repl === k.needle) die(`${k.id} 的「改成」与针相同，这一刀不会改变任何东西`);
  // 标签里带 ${…} 的槽（档名、行号、现值），所以只能比「最长连续命中」：
  // 期望的那一条里必须有一段 >=10 个字原样写在闸里，否则就是断言被改名或删掉了。
  const longestIn = (hay, want) => {
    let best = 0;
    for (let i = 0; i + 8 <= want.length; i++) {
      let j = i + 8;
      while (j <= want.length && hay.includes(want.slice(i, j))) j++;
      best = Math.max(best, j - 1 - i);
    }
    return best;
  };
  const run = longestIn(DOCTEST, k.expect);
  if (run < 10) die(`${k.id} 期望点名的「${k.expect}」在 doctest.mjs 里最长只连续命中 ${run} 个字（断言被改名或删掉了）`);
  console.log(`  预检 ${k.id} · ${k.file} 针唯一命中 · 期望点名「${k.expect}」`);
}

const tree0 = gitStatus();
const stamp = `${Date.now()}`;
const copies = [];
const makeCopy = id => {
  const dst = join(WORKSPACE, `_tmp-ferry-sab-${id}-${stamp}`);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const r = sh('rsync', ['-a', '--exclude', '.git', '--exclude', '_tmp*', `${ROOT}/`, `${dst}/`], { timeout: 120000 });
  if (r.rc !== 0) die(`副本建不起来：${r.out.slice(0, 200)}`);
  copies.push(dst);
  return dst;
};

const results = [];
for (const k of picked) {
  const dst = makeCopy(k.id);
  const file = join(dst, k.file);
  const src = readFileSync(file, 'utf8');
  const at = target(src, k.needle);
  if (at.length !== 1) die(`${k.id} 落刀前在副本里命中 ${at.length} 次（副本与仓不同步？）`);
  writeFileSync(file, src.slice(0, at[0]) + k.repl + src.slice(at[0] + k.needle.length) );
  const t0 = Date.now();
  const r = sh(process.execPath, ['tools/doctest.mjs'], { cwd: dst, timeout: 300000 });
  const secs = +(((Date.now() - t0) / 1000).toFixed(1));
  const named = r.out.split('\n').filter(l => l.includes(k.expect) && /FAIL/.test(l));
  const log = join(ROOT, `_tmp-ferry-sab-${k.id}.log`);
  writeFileSync(log, `（临时副本 ${dst}）\nnode tools/doctest.mjs\nGATE_RC=${r.rc} 用时 ${secs}s\n${'='.repeat(60)}\n${r.out}`);
  const okKnife = r.rc !== 0 && named.length > 0;
  results.push({ id: k.id, rc: r.rc, named: named.length, secs, log, ok: okKnife });
  console.log(`  ${okKnife ? '红得住' : '没红/没点名'} ${k.id} · rc=${r.rc} 点名 ${named.length} 行 · ${secs}s · ${log.replace(`${ROOT}/`, '')}`);
  for (const l of named.slice(0, 2)) console.log(`      ${l.trim().slice(0, 150)}`);
  rmSync(dst, { recursive: true, force: true });
}

// ---- 仓里的真文件一个字都没动过 ----
const tree1 = gitStatus();
if (tree1 !== tree0) die(`刀跑完之后工作树变了（刀不许碰仓里的文件）：\n--- before ---\n${tree0}\n--- after ---\n${tree1}`);
for (const k of picked) {
  // 台账那一行本来就会把「改成」原样抄一遍，所以那些行不算证据
  const src = read(k.file).split('\n').filter(l => !/^\| S\d+ \| /.test(l)).join('\n');
  if (src.includes(k.repl)) die(`${k.file} 里现在还能找到 ${k.id} 的改动串——刀打到了仓里`);
}

// ---- 每一把都必须既红又点到自己那一条 ----
const bad = results.filter(x => !x.ok);
if (bad.length) die(`有 ${bad.length} 把刀没红或没点名（${bad.map(x => x.id).join(' ')}）：README 台账保持原样，不回写任何 rc`);
console.log(`\n${results.length} 把刀全部红得住并点到了名：`);
for (const r of results) console.log(`  ${r.id} rc=${r.rc} 点名 ${r.named} 行 · ${r.secs}s`);

// ---- 回写实测 rc：台账末列那个数只能由脚本自己填，人不许抄 ----
// 子集跑（只点名几把刀）不回写：台账的前提是整跑一遍。
const subset = process.argv.slice(2).length > 0;
if (!subset) {
  const lines = read('README.md').split('\n');
  let written = 0;
  for (const k of picked) {
    const i = lines.findIndex(l => l.startsWith(`| ${k.id} | `));
    if (i < 0) die(`回写时找不到台账里 ${k.id} 那一行`);
    const rc = results.find(x => x.id === k.id).rc;
    const next = lines[i].replace(/\| (\?|\d+) \|$/, `| ${rc} |`);
    if (next === lines[i] && !lines[i].endsWith(`| ${rc} |`)) die(`${k.id} 那一行末尾既不是「? |」也不是数字，不知道该怎么回写：${lines[i].slice(-40)}`);
    if (next !== lines[i]) { lines[i] = next; written++; }
  }
  writeFileSync(join(ROOT, 'README.md'), lines.join('\n'));
  writeFileSync(join(ROOT, '_tmp-ferry-sab-writeback.log'),
    `README 台账回写\nGATE_RC=0\n回写行数=${written}\n${lines.filter(l => /^\| S\d+ \| /.test(l)).join('\n')}\n`);
  console.log(`  回写 ${written} 行的实测 rc（末列由脚本自己填；已经是同一个数时不动那一行）`);
}

// ---- 对照：不带刀的整副本跑同一条命令必须 rc=0（证明红是那一个扰动造成的，不是环境） ----
const ctrl = makeCopy('control');
const c = sh(process.execPath, ['tools/doctest.mjs'], { cwd: ctrl, timeout: 300000 });
writeFileSync(join(ROOT, '_tmp-ferry-sab-control.log'), `node tools/doctest.mjs（无刀副本）\nGATE_RC=${c.rc}\n${'='.repeat(60)}\n${c.out}`);
if (c.rc !== 0) {
  rmSync(ctrl, { recursive: true, force: true });
  die(`不带刀整跑时 doctest 竟然红了（rc=${c.rc}）：先看 _tmp-ferry-sab-control.log`);
}
console.log(`  对照 doctest · rc=0（刀没留在树上，闸本来是绿的）`);

rmSync(ctrl, { recursive: true, force: true });
for (const p of copies) rmSync(p, { recursive: true, force: true });
const residue = spawnSync('bash', ['-c', `ls -d ${join(WORKSPACE, '_tmp-ferry-sab-*')} 2>/dev/null | wc -l | tr -d ' '`], { encoding: 'utf8' });
console.log(`  副本清干净了：残留 ${(residue.stdout || '?').trim()} 个`);
if (subset) console.log('\n子集跑：没有回写台账（台账要的是整跑一遍）。');
