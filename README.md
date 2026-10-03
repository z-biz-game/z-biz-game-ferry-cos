# 迷津渡 · FERRY

把一整队角色渡到对岸。过河谜题（狼羊菜 / 传教士与野人）的浏览器实现，它和纸面版本的关键区别只有一条：
**屏幕上每一个"最少单程"都是搜索量出来的，而不是有人估计的**——在 `(船在哪一岸, 左岸名单)` 这张
`2^(n+1)` 的状态图上跑分层广度优先搜索，一次单程计 1、一次来回计 2。

本仓还有一条比"数字是量出来的"更硬的主张：**过河谜题有两套合法的船，而换一套船会改变答案**。
同一副 M&C 3+3 角色、同一条冲突规则，在"自由船"（无艄公，船上 1..2 人）下是 **11 单程**，
在"艄公船"（艄公必须在船上，另载 0..1 人）下**永远不可解**。所以"船怎么开"不是实现细节，
它是关卡数据的一部分：`js/data/lots.js` 每一行都印着自己的 `law`，面板上也印着它。

- **谁算了屏幕上的每个数字**：`js/core/river.js` 只有一个合法性来源（`loadingFault` / `cross` / `isSafe`）；
  `js/core/solve.js` 用它做分层 BFS，产出 `par`（最少单程）、`routes`（最短路线的**条数**）、
  `explored`（可通行局面数）与 `truncated`（这次搜索有没有被预算截断）。
  面板上的"最少 N 单程""最优路线 M 条""K 个可通行局面"、提示给出的下一步、四档难度的区间，
  全部来自这次搜索；关卡由 `tools/bake.mjs` 在构建期出题并**当场复验**，再由 `test/library.test.mjs`
  在每次 CI 里从**序列化之后**的数据重解一遍逐行比对。搜索器不给自己打分：
  `test/anchors.test.mjs` 用另一套独立实现（`layerSearch()`，纯 `Set` 一层一层推）复现同一条表，
  并把人类手写的狼羊菜 7 步逐步回放钉住。
- **"不可解"是一个证明，不是一条特判**：只有搜索前沿耗尽（`truncated === false`）才允许说不可解，
  全仓没有 `if (n >= 4) return false` 这种分支。
- 零依赖、零美术、零打包器：只有 `index.html` + `css/` + `js/`，浏览器加载的就是仓库里的文件。
- 24 关已烘焙（四档各 6 关）并逐关复验，四档带互不重叠，是从实测 par 直方图里取出来的。
- 战役 / 每日 / 随渡 / 分享链接四种入口，同一个 id 或同一个 token 在任何设备上都是同一条河。
- 本地存档（localStorage），无账号、无网络请求、可离线。

## 跑起来

```bash
node server.cjs            # http://127.0.0.1:5180/
npm run check              # node --check 全量（CI 的 Syntax 步骤就是这一条）
npm run unit               # 六个 node 套件（95 条断言）
bash tools/verify.sh       # node 套件 + 文档数字闸 + 破坏台账 + headless Chrome 真实拖拽验收（五段，门线 ≥38 条）
node tools/doctest.mjs       # 第六道闸：文档里每个现值 == 代码现值（370 项，含反空转的行数断言）
node tools/sabotage.mjs      # 破坏试验台账：8 把刀只改临时副本，逐把要求文档闸点名变红（verify.sh 与 CI 都跑它）
node test/balance.mjs      # 生成器实测：出题率 / 变异接受率 / 被替换掉的 scatter 对照
node tools/bake.mjs        # 重新出题并复验，写 js/data/lots.js（本机 4 档合计约 11.6 s）
npx electron .             # 桌面壳（需先自行 npm i -D electron，本仓不装）
```

`server.cjs` 是零依赖静态服务器，存在的唯一理由是 ES module 需要一个 origin，`file://` 会被 CORS 挡掉。
`tools/verify.sh` 默认另起端口（`WEB_PORT=5188`、`CDP_PORT=9348`），并且**在 :9348 已被占用时直接退出**
（`exit 6`），因为这个农场里还有别的仓在同一条机器上跑自己的 headless Chrome。

## 玩

- 画面上横着一条河，左右各一块码头，中间一艘船。角色是程序画的圆点，靠颜色区分艄公 / 人 / 兽 / 货。
- **三个手势，一对一映射到模型**（`js/view.js`）：
  把角色拖到船上 = 装船（**不计单程**）、拖回岸上 = 卸船（不计单程）、点船身或把船拉到对岸 = **一次单程**（唯一计数的地方）。
  装船时被拒的角色会抖一下并在面板上说明原因，计数不动。
- **"拉到对岸"必须真的到对岸**：半途而废的拖船（位移超过点击抖动、但没到对岸那一侧的判定线）
  船回原位、一个人也不上岸、不计数；判定线是"两码头间距的 45%"，所以船体不许铺满河面
  （`js/view.js:124-131` 的上限就是这条规则的几何表达，来历见 `DESIGN.md` §7.1）。
  按在空白河面上则什么都不发生——`@pointer` 里有一条断言先证明按的那个点确实什么都碰不到。
- **两条船的口径**（`js/core/library.js` 的 `LAWS`，也是面板上"船的法"那一格）：
  - **艄公船** `boat.rule = 'ferry'`：艄公**必须**在船上，另可载 `0..capacity-1` 名乘客，
    船上总人数 ≤ `capacity`。**艄公独自过河合法**——狼羊菜的第 2、4、6 步就是这么走的；
    禁掉它就等于把经典题判成不可解（这是本仓真实踩过的坑，见 DESIGN.md 第 2 节）。
  - **自由船** `boat.rule = 'free'`：没有艄公，船上 `1..capacity` 人任意组合，**空船不许开**。
    这一口径下没有任何一岸"有人监管"，所以两岸都按无人监管判冲突。
- **冲突判定**：`pair` 型（如 狼↔羊、羊↔菜）看某岸上是否同时留着一条边的两端；
  `majority` 型（野人严格多过传教士，且传教士 ≥1）看数量。艄公站的那一岸免判（只在 `'ferry'` 口径下存在这种岸）。
  如果某一步走完会让任一岸出事，**这一步整个被拒绝**，并且高亮说出是哪两个角色、在哪个岸、
  是"离开"还是"到达"出的事——这是本玩法的教学点。
- 目标：所有人到右岸，**且船是他们一起坐过去的**（`mask === 0 && bank === RIGHT`）。
- 面板实时印 `单程（已用）/ 最少 / 最优路线几条 · 几个可通行局面 / 第几渡 / 船的法 / 乘客 / 已在船 / 最佳`。
  提示（`h`）给出"从现在这个位置出发、最短路线的第一趟该装谁"，并说还剩几单程；退回 `u`、重开 `r`、
  空格或回车 = 开船。
- 走完 par 单程 = ★★★ 分毫不差；超出 1–2 单程 = ★★ 稳操渡桨；更多 = ★ 曲折抵达。
  三档定义写在 `js/core/game.js:161` 的 `grade()`，只对着量出来的数字算，不看感觉。

## 这张表是谁算的

`test/anchors.test.mjs` 逐行复现下表。每一条期望数字都是**人类在读到代码之前写下的**，
并且每条都被两个独立实现同意过：`js/core/solve.js` 的分层 BFS，和该文件里手写的 `layerSearch()`
（`Set` + 一层一层推的朴素实现，它同时证明"这条路线存在"与"更短的不存在"）。
右侧两列是本次会话在交付的这份代码上跑出来的：

```bash
node --test test/anchors.test.mjs      # 21 条断言，全绿
```

| 题面 | 船的口径 | 最少单程 | 最短路线条数 | 可通行局面 / 状态空间 |
|---|---|---|---|---|
| 狼羊菜（艄公 + 狼/羊/菜，冲突 狼-羊、羊-菜） | 艄公船，容量 2 | **7** | 2 | 10 / 32 |
| 狼羊（最小的关） | 艄公船，容量 2 | **3** | 2 | 6 / 16 |
| M&C 1+1 | 自由船，船上 1..2 | **1** | 1 | 6 / 8 |
| M&C 2+2 | 自由船，船上 1..2 | **5** | 18 | 22 / 32 |
| M&C 3+3 | 自由船，船上 1..2 | **11** | 8100 | 64 / 128 |
| M&C 4+4 | 自由船，船上 1..2 | **不可解** | 0 | 98 / 512（前沿耗尽） |
| M&C 5+5 | 自由船，船上 1..2 | **不可解** | 0 | 212 / 2048（前沿耗尽） |
| M&C 1+1 | 艄公船，容量 2 | **3** | 2 | 8 / 16 |
| M&C 2+2 | 艄公船，容量 2 | **7** | 4 | 28 / 64 |
| M&C 3+3 | 艄公船，容量 2 | **不可解** | 0 | 49 / 256（前沿耗尽） |
| M&C 4+4 | 艄公船，容量 2 | **不可解** | 0 | 112 / 1024（前沿耗尽） |
| M&C 4+4 | 自由船，容量 3 | **9** | 329472 | 196 / 512 |
| M&C 4+4 | 艄公船，容量 3 | **7** | 900 | 356 / 1024 |
| M&C 6+6 | 自由船，船上 1..2 | **不可解** | 0 | 423 / 8192（前沿耗尽） |

倒数第三、二行是这张表存在的理由：**同样 8 个人，把船从容量 2 放宽到 3，"不可解"就变成了 9 单程**。
任何按人数判可解性的代码都会在这一格上说谎，所以这一格被断言钉着（`test/anchors.test.mjs`
"the same heads are solvable under a roomier boat"）。6+6 那一行是把"不许特判"推到表外的尺寸上再验一次。

## 难度带（已发布池子实测）

下面每一行都是这条命令的输出（它读的是 `js/data/lots.js` 里真的写着的那些行）：

```bash
node -e 'import("./js/core/library.js").then((L)=>{const s=L.stats();for(const t of L.TIERS){const b=s.byTier[t.key];console.log(`${t.key} ${b.n} 关 par ${b.parMin}-${b.parMax} med ${b.parMed} states ${b.statesMin}/${b.statesMed}/${b.statesMax} 艄公 ${b.ferry} 自由 ${b.free} 角色 ${b.rolesMin}-${b.rolesMax} 家族 pair ${b.pair}/majority ${b.majority}`)}})'
```

| 档 | 关卡数 | 最少单程（实测区间） | par 中位 | 可通行局面 min/med/max | 角色数 | 艄公船 / 自由船 | 冲突家族 |
|---|---|---|---|---|---|---|---|
| 浅滩 shoal | 6 | 1–3 | 3 | 6 / 10 / 14 | 2–4 | 4 / 2 | pair 3 · majority 3 |
| 短渡 ford | 6 | 5–7 | 5 | 32 / 45 / 66 | 5–6 | 4 / 2 | pair 3 · majority 3 |
| 急流 rapids | 6 | 9–11 | 9 | 40 / 57 / 64 | 6–7 | 5 / 1 | pair 4 · majority 2 |
| 迷津 labyrinth | 6 | 13–15 | 15 | 160 / 160 / 212 | 8–8 | 6 / 0 | pair 5 · majority 1 |

两个只有量才知道的事实：

1. **每一个 par 都是奇数**。船从左岸出发、必须停在右岸，所以任何解的单程数都是奇数
   （`test/make.test.mjs` 把 `par % 2 === 1` 钉成了断言）。这意味着难度带只能是 `1-3 / 5-7 / 9-11 / 13-15`，
   写成 `1-4 / 5-8` 那种"整数等宽"的带会是空的。
2. **迷津档一关自由船都没有**。撒点与变异两条路都量过：8 角色的自由船题要么不可解、要么落不进 13–15 这个带。
   这一格不是配平失败，是这条河真的长这样——所以它印在表里而不是藏起来。

难度带**不是**由 `js/core/make.js:431` 的 `TIERS` 说的：那份 `min/max` 只是生成包络，
屏幕上与文档里印的是 `js/data/lots.js` 第 7 行的 `TIERS_META`，由 `tools/bake.mjs:196`
从**实际入库的行**里量出来。`test/library.test.mjs` 再比对一次两者并断言四档互不重叠。

## 为什么生成不在浏览器里跑

因为这里的生成 = 搜索，而搜索不便宜。`node tools/bake.mjs`（本次实跑）给的是：

```
shoal      seeds 40 → levels 40 (100%) · unique 9 (23%)  · 变异接受 10/10     (100.0%) · 0.0s
ford       seeds 40 → levels 40 (100%) · unique 20 (50%) · 变异接受 68/4563   (1.5%)   · 0.2s
rapids     seeds 40 → levels 40 (100%) · unique 16 (40%) · 变异接受 194/25146 (0.8%)   · 2.1s
labyrinth  seeds 40 → levels 40 (100%) · unique 29 (73%) · 变异接受 339/41452 (0.8%)   · 9.3s
最慢一题 1126 ms · 最大搜索 212 态（2^(n+1) 之中）
```

迷津档要在四万多次变异里挑出三百多次"搜索同意的"变异，一颗种子中位 123 ms、最慢 1812 ms
（`node test/balance.mjs` 本次实跑）。这是构建期可以接受、玩家手指不能接受的代价。
所以：**前端绝不生成**，浏览器只做三件事——查表、按 `js/core` 的规则判这一步合不合法、以及在玩家要求提示时
跑一次有上限的现场搜索（`js/core/game.js:152` 的 `hint()`，`limit = 40000`，状态空间 ≤ 8192）。
烤进产物的除了关卡还有 `par` / `routes` / `states`，玩家永远不需要等一次搜索才知道"最少几步"。

被替换掉的那个"随机撒点再筛"生成器还留在 `js/core/make.js:376` 的 `scatter()` 里，
因为它给出的正是上面那句结论的数字（本次实跑，40 次调用、3521 个随机题面）：

```
scatter labyrinth: probed 3521 · 落进 13-15 带 40 (1.14%) · 不可解 1265 · 可解率 62.3% · 低于带 2153
```

## 验收

`bash tools/verify.sh` 一条命令跑完两层（CI 里是两个 job，`ci.yml` 的 browser job 用 `SKIP_UNIT=1`）：

- **node 层 95 条断言，fail 0**（本次实跑，`node --test test/`）：
  `anchors`(21) 锚点表逐行复现 + 狼羊菜 7 步手算路线 + 前沿耗尽的不可解、
  `river`(28) 冲突判定的四个时刻正负例 + 两条船口径 + 校验器负例 + 编码互逆 + 纯函数性、
  `game`(17) 装船不计费 / 艄公独自开船计 1 / 空船被拒 / 认证路线逐关回放 / 撤销 / 评星、
  `library`(9) 24 行产物从序列化态重解复现 par 与路线条数、
  `make`(7) 生成器纯净性 + 边界 + scatter 诚实性、
  `storage`(13) best 只降、unlock 只升、清档、无 `window` 退化内存。
- **浏览器层五段**：`tools/playtest.mjs` 起真实 headless Chrome，`@boot @play @routes @save @pointer`
  各段独立返回 `{rows, fail}`，`tools/verify.sh:18` 的门线是五段合计 `MIN_BROWSER_ROWS=38` 条。
  `@pointer` 跑在 Node 侧：坐标取自页面里的 `window.ferry.rolePoint(i)` / `boatPoint()`，
  事件是真的 `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent` / `Input.dispatchKeyEvent`——
  mouse 与 touch 两条腿各自把 `shoal-03`（艄公船，par 3）从装船拖到过河走完，
  并断言 `shoal-04`（容量 3）里第四个角色拖不上船、对岸的角色拖不进船、`shoal-02`（自由船）的空船按压
  不计单程，而 `shoal-01`（艄公船）里"把船拖到对岸"恰好计一单程。
  **本次实跑（`bash tools/verify.sh`，不跳 unit，2026-10-02 重跑）：五段合计 116 条、fail 0**
  （`@boot` 11 / `@play` 11 / `@routes` 17 / `@save` 13 / `@pointer` 64），console `(none)`，
  末行 `=== ALL GREEN ===`、rc=0。`@pointer` 是三条真输入腿的合计数（mouse 35 / touch 18 / keys 11），
  其中 mouse 那 35 条里有 2 条是**前提断言**：
  按下之前先证明那个坐标真的既不在船体矩形内、也不在任何角色的命中半径内，
  以及两个码头之间的行程真的长到"拖到对岸"是一个手势（`DESIGN.md` §7.1 记的就是这条来历）。

## 破坏试验台账（8 把刀）

`node tools/sabotage.mjs` 把每一类谎各写回**一份临时副本**里一遍（仓里的真文件一个字都不动，跑完删副本），
再在副本里跑 `node tools/doctest.mjs`。一把刀算数，必须同时满足：rc != 0 **且**输出点名它那一条 FAIL 行——
语法炸了也是 rc != 0，但那不是闸红。任何一把没红或没点名，整体判红并点名是哪把。最右列由这个脚本从子进程
读回来**自己回写**（手抄的数下一次整跑会被它判成不符）；回写之后再跑一次"不带刀对照整跑"，rc=0 才算刀拔干净了。
台账的每一格（文件、针、改成、期望红行）都由 `tools/doctest.mjs` 的 D11 与脚本里的 `KNIVES` 逐字对上，
改表格不改脚本、或改脚本不改表格，都会立刻红。

这台台架在 2026-10-03 之前是**第七道"看起来有、实际没跑"的闸**：文件在仓里、README 在写它，
`tools/verify.sh` 与 `ci.yml` 却都没有调用它——也就是说下面这张表的 rc 一列一旦被回写，
之后任何一次让它跑不起来的改动（断言改名、针漂了）都不会有人发现。现在它接在 verify.sh 的逻辑档
（`SKIP_UNIT=1` 的浏览器 job 不重复跑它）和 ci.yml 的 check job 里，而 `D4n` 拿四处同源钉这条接线：
verify.sh、ci.yml、package.json、README 少任何一处调用，文档闸就红。

最后那句不是修辞——下面这张表的第八把刀 S8 干的就是"把这条调用摘掉"：在临时副本里把 CI 那一行换成
`run: echo "ledger not wired"`，红的正是 `D4n`，而它打印的四个布尔里只有 `ci=false`、另外三处仍是 `true`
（逐把证据 `_tmp-ferry-sab-S8.log`）。一把只摘一处的刀能同时报出"其余三处还在"，这条接线才算被钉住，
而不是被一把大锤整段砸红。

| 刀 | 这一类谎 | 文件 | 针（唯一命中） | 改成 | 期望点名的红行 | rc |
|---|---|---|---|---|---|---|
| S1 | 文档抄的实测读数漂一格 | `README.md` | `\| 迷津 labyrinth \| 6 \| 13–15 \| 15 \| 160 / 160 / 212 \|` | `\| 迷津 labyrinth \| 6 \| 13–15 \| 15 \| 161 / 160 / 212 \|` | `D1 labyrinth 可通行局面 min/med/max == 实测现值` | 1 |
| S2 | 代码改了常数、文档还引用旧值 | `js/core/river.js` | `export const MAX_ROLES = 12;` | `export const MAX_ROLES = 11;` | `D5a 文档写的 MAX_ROLES 处处等于 river.js 现值` | 1 |
| S3 | 文档的行号引用指回旧位置 | `README.md` | `` `js/core/make.js:431` 的 `TIERS` `` | `` `js/core/make.js:430` 的 `TIERS` `` | `D6 文档引用的「make.js 的 TIERS」` | 1 |
| S4 | 表格改了形状，正则一条都不命中 | `README.md` | `\| 浅滩 shoal \| 6 \| 1–3 \| 3 \|` | `\| 浅滩 shoal \| 6 \| 1-3 \| 3 \|` | `D1a README 的难度带表解析到 4 行` | 1 |
| S5 | 锚点表某个态数被改一个位 | `README.md` | `**11** \| 8100 \| 64 / 128 \|` | `**11** \| 8100 \| 65 / 128 \|` | `D2 第 5 行的可通行局面 == 重算的 explored` | 1 |
| S6 | 门线被调低（浏览器腿可以少一半） | `tools/verify.sh` | `MIN_BROWSER_ROWS=${MIN_BROWSER_ROWS:-38}` | `MIN_BROWSER_ROWS=${MIN_BROWSER_ROWS:-19}` | `D4a README 的门线等于 verify.sh 的 MIN_BROWSER_ROWS` | 1 |
| S7 | 现场搜索的预算被改小、文档还写着 40000 | `js/core/game.js` | `limit: 40000 }` | `limit: 4000 }` | `D5e 文档写的 hint 预算处处等于 game.js 现值` | 1 |
| S8 | 台账的调用从 CI 里被摘掉：闸还在、没人跑它 | `.github/workflows/ci.yml` | `run: node tools/sabotage.mjs` | `run: echo "ledger not wired"` | `D4n 破坏台账接进了 verify.sh、ci.yml` | 1 |

台账之外的那些数（烘焙与 balance 的毫秒、scatter 的 3521 个样本、浏览器 116 条与各腿分布）
在 `tools/doctest.mjs` 的 D10 里被登记成 **unpinned 清单**：它们没有代码出处，钉不住，但每条都配一句
"这段文字还必须在文档里"的反删除断言——钉不住不等于可以删掉让它变绿。

## 文件地图

```
index.html            壳：顶栏 / 画布 / 右侧面板 / 通关卡（含 data: 的 favicon，防 404 污染 console）
css/game.css          全部样式，一个文件
js/core/river.js      模型：状态 (bank, mask)、两条船口径、冲突判定、cross()、validate()（无 DOM）
js/core/solve.js      分层 BFS：par / 路线 / 最短路线条数 / 探索态数 / truncated 标记
js/core/game.js       一局进行中的状态：board/unboard/depart/undo/reset/hint/grade（无 DOM）
js/core/make.js       构建期生成器：经典题种子 + 变异阶梯（scatter 保留作对照，不接线）
js/core/library.js    查表：战役 24 关 / 每日 / 随渡 / id + LAWS 文案 + stats()
js/core/storage.js    localStorage 存档，无 window 或存储被拒时退化成内存
js/core/rng.js        hashSeed（FNV-1a 派生的两轮混合，见 DESIGN.md 第 5 节）+ mulberry32
js/data/lots.js       构建期产物：TIERS_META + 24 行带实测 par / routes / states 的关卡
js/view.js            canvas 2D 绘制（河 / 两岸 / 船 / 角色）+ 三种手势，不判合法性
js/main.js            路由、DOM、存档写入、window.ferry 测试钩子
server.cjs            零依赖静态服务器（默认 5180）
electron/main.cjs     桌面壳（复用同一个服务器，port: 0）
tools/bake.mjs        出题 → 序列化后复验 → 写 js/data/lots.js，并打印实测直方图与接受率
tools/playtest.mjs    零依赖 CDP 驱动：注入、真实鼠标拖拽、截图、抓 console
tools/verify.sh       一次性验收门（独立 profile、双端点就绪轮询、花括号计数截 JSON、SKIP_UNIT）
tools/harness.mjs     微型测试框架，node 与浏览器套件输出形状一致
tools/doctest.mjs     第六道闸：README / DESIGN / deliverable 里每个现值 == 代码现值，每条解析配反空转行数断言
tools/sabotage.mjs    破坏试验台账：刀只改临时副本，逐把要求上那道闸点名变红，实测 rc 由脚本读回来
test/                 六个套件 + 手算 fixture（fixture.mjs）+ 难度台架 balance.mjs
```

## 已知边界

- **8 个角色是模型边界**（`js/core/river.js:34` 的 `MAX_ROLES = 12`，生成器只出到 8）。
  状态空间 `2^(n+1)` 在 n = 12 时是 8192 个态：`solve` 的距离表按 `Int16Array` 一次分配，
  提示的现场搜索也还在这个量级里。再往上就是"提示要搜几十万态"，那属于构建期而不是手指。
- **`hint()` 是现场搜索**，这是本仓唯一一处玩家可触发的搜索：它带 `limit = 40000`，
  而 shipped 关卡的状态空间 ≤ 512（迷津档 8 角色），最坏探索 212 态，实测亚毫秒级
  （`node test/balance.mjs` 末段：狼羊菜 10 态、M&C 3+3 64 态、M&C 6+6 423 态，均 0–1 ms）。
  它给的是"从现在这一步起还剩几单程"，**不改写**印着的 par。
- 走错一步是可能把自己困死的：`depart()` 只拒绝制造冲突的那一步，玩家仍可在一堆合法步里走进
  一个无解局面（bake 出来的关卡起点都是有解的）。此时 `hint()` 返回 `null`、面板说"没有可行的下一趟"，
  `depart()` 也会用 `already` 拒绝从已出事的状态继续开船。没有自动认输、没有退回上一关的补偿。
- 通关后没有彩带、没有音效、没有分享弹窗；分享只分享谜题本身（`#/lot/<id>`、`#/random/<档>/<token>`），不带战绩。
- Electron 壳过 `node --check`，但仓库不装 electron，**没有跑过真实启动**。
- 移动端断点已写、`touch-action` 已接，但**没有真机验证**（台架派发的是鼠标事件，不是触摸事件）。
- 多语言：UI 只有中文。

## License

MIT © 2026 z-biz-game

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高。
- **钉住两个数**：`EXPECT_CHECKS=25`（R 段实际检查的路径条数）与 `EXPECT_ROWS=43`
  （这一次跑的断言条数）。没改页面却掉了，说明解析断了；删掉一张图标会同时少一条 R10 与那张的
  P1/P2，所以两个数一起钉，rows 能漂就是闸在缩水的信号。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸），要求每一刀都让闸**点名**变红；X10 是阴性对照——往入口 JS 追加一行只写在注释里
的假路径，闸必须仍然绿、条数仍然 `25`、rows 仍然 `43`。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑，所以页面改了、仓与仓不同，台架跟着走。

`npm run deploy-set` 与 `npm run deploy-set:selftest` 是同两条命令的本地入口；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。
