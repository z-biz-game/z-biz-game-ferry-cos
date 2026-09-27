# 迷津渡 - 交付报告

读者：接手的维护者代理。本文件只登记**磁盘上真实存在、且在本次会话里被命令跑绿过**的东西。
每一条声称都指到一个具体文件与一条能跑的命令；输出行都是本机实跑后原样粘贴，不是从 README.md / DESIGN.md 抄的。

本次会话**只新增 5 个文件**：`.github/workflows/ci.yml`、`.github/workflows/pages.yml`、`README.md`、
`DESIGN.md`、本文件。没有修改任何已有代码文件，没有新增功能，没有执行任何 git 写操作，没有写进任何其它仓目录。
唯一"被验证过内容而没被改写"的产物是 `js/data/lots.js`：`node tools/bake.mjs` 的重跑是在
**复制到 `/tmp/ferry-bake-*` 的那一份**上做的（这个工具会写死路径覆盖 `js/data/lots.js`，
而本任务禁止改动仓内文件），结果与仓里那一版 **diff 为空**、md5 同为 `caaf916210af2a3e828c07c52317a303`。
也就是说烘焙是跨进程可复现的，而不是"这次会话重烤了一遍、可能烤动了"。

**本文件没有"线上验收"一节**：GitHub Pages 与 headless Chrome 门禁由 lead 统一跑（本机 Chrome 被农场里
多个仓争用），本次会话按指示**没有执行 `bash tools/verify.sh`**，因此不声称浏览器层绿。见 §6-1。

---

## 摘要

| 字段 | 值 | 复现命令 |
|---|---|---|
| **App 名称** | 迷津渡 | `head -1 README.md` → `# 迷津渡 · FERRY`（取中文部分，与本行完全一致） |
| 仓 | `/Users/zifang/workplace/ceo_workplace/z-biz-game/z-biz-game-ferry-cos` | — |
| 玩法一句话 | 把全部角色渡到右岸：拖人上船不计步，开一次船 = 1 个单程；任何一岸无人监管时留下冲突就被整步拒绝 | `js/core/river.js:195`（`loadingFault`）与 `:256`（`cross`）；`node --test test/river.test.mjs` |
| 难度的来源（本仓用哪一种证明） | **BFS 证明值**：`par` = `(船在哪岸, 左岸名单)` 这张 `2^(n+1)` 状态图上的**最少单程数**，由分层 BFS 量出；"不可解"只在**前沿耗尽**（`truncated === false`）时成立。独立证据 = 第二个实现（`layerSearch`）+ 人类手写 7 步 + 从序列化产物重解 | `node --test test/anchors.test.mjs`（21 条）、`node --test test/library.test.mjs`（9 条） |
| 外部锚点 | 经典题面表逐行复现：狼羊菜 7、M&C 1+1/2+2/3+3 自由船 = 1/5/11、4+4/5+5 自由船不可解、M&C 1+1/2+2 艄公船 = 3/7、3+3/4+4 艄公船不可解 | `test/anchors.test.mjs:85-97`；数字见 §3 表 |
| 关卡 | 24 关（4 档 × 6 关），每关印 `par / routes / states` 三个实测值 | `grep -c '^  {' js/data/lots.js` → `24`；`node tools/bake.mjs` |
| node 断言 | **95 条，fail 0**（6 个套件） | `node --test test/`（原文见 §5.2） |
| 浏览器断言 | **本次未执行**（`tools/playtest.mjs` 五段齐备，门线 `MIN_BROWSER_ROWS=38`） | `SKIP_UNIT=1 bash tools/verify.sh` —— 由 lead 跑，见 §6-1 |
| npm 依赖 | `dependencies = {}`、`devDependencies = {}`、无 `node_modules` | `node -e 'const p=require("./package.json");console.log(p.dependencies,p.devDependencies)'`；`ls node_modules` → No such file |
| 二进制资产 | 0：非文本文件只有 `LICENSE` | `find . -type f ! -name '*.md' ! -name '*.js' ! -name '*.mjs' ! -name '*.cjs' ! -name '*.css' ! -name '*.html' ! -name '*.json' ! -name '*.sh' ! -name '*.yml' ! -name '.gitignore'` |
| 磁盘文件 | 34 个（本文件写完即 34），源码/样式/脚本 5585 行 | `find . -type f -not -path './.git/*' \| wc -l`；`cat js/*.js js/*/*.js test/*.mjs tools/*.mjs server.cjs electron/main.cjs css/game.css index.html \| wc -l` |
| 路由 / 测试钩子 | `#/c/<n>`、`#/lot/<id>`、`#/daily`、`#/random/<档>/<token>`；`window.ferry` | `js/main.js:48`（`parseHash`）、`js/main.js:474`（`window.ferry`） |
| 未实现清单 | 9 条（含 3 处代码注释里的旧数字与本次实测不符） | 见 §6 |

---

## 1. 文件清单 —— 每个文件由谁验证

"由谁验证"只填**某个 `test/*.test.mjs` 的断言**或**某条命令**；没有门禁的文件明确写"无门禁"。

### 壳与画面

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `index.html` | 壳：顶栏 / `#lot` 画布 / 右侧面板 / 通关卡；`<link rel="icon" href="data:,">`（`:8`） | `js/core/library.js` 与 `test/library.test.mjs`(9) 跑的是数据层，**HTML 本身无 node 门禁**；`tools/verify.sh:69-73` 用 `grep 'id="lot"'` 作为"这个端口服务的是本仓"的就绪判据（本次未执行）。favicon 那条是契约 §2 的家族教训，静态存在 |
| `css/game.css` | 全部样式，单文件（131 行） | **无 node 门禁**。`tools/playtest.mjs:455` 的 `@boot` "the canvas has real pixels, not the 300x150 default" 是它的唯一门禁（本次未跑，§6-1） |
| `js/view.js` | canvas 绘制（河/岸/船/角色）+ 三种手势 + `rolePoint/boatPoint/dockPoint/reach` | **无 node 门禁**；由 `@boot` / `@pointer` 覆盖（本次未跑）。它对 core 的只读关系被 `test/game.test.mjs:266` "the game object borrows the compiled cast instead of mutating it" 从另一侧钉住 |
| `js/main.js` | 路由、DOM、存档写入、`window.ferry` 钩子 | **无 node 门禁**；由 `@routes`(17 条量级) / `@save` 覆盖（本次未跑）。`js/core` 不含 DOM 这一事实由 `grep -rn "window\.\|document\." js/core/` 核查（只命中 `storage.js` 的守卫式访问，见 §3） |

### js/core/*（纯函数层，`node --test` 直接 import）

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/core/river.js` | 模型：`(bank, mask)`、两条船口径、`supervised`/`conflictOnBank`/`loadingFault`/`cross`、`validate`、`compile ↔ toSpec`、`signature` | `test/river.test.mjs`(28)：四个时刻正反例、`'ferry'` 艄公单独合法、`'free'` 空船被拒、超载说 `over` 不说 conflict、度数上限按角色数判、编码互逆、`eachSubset` 顺序、`solvedState` 要船随人走、纯函数性 |
| `js/core/solve.js` | 分层 BFS：`par` / `route` / `routes` / `explored` / `truncated`；`bestCrossing`；`census` | `test/anchors.test.mjs`(21) 全部经过它，并与 `layerSearch()` 交叉验证；`truncated` 语义由 `:127` "a search that hits its budget says truncated instead of pretending" 钉住。**`census`(:115) 无任何调用方**（§6-3） |
| `js/core/game.js` | 一局进行中状态：`boardFault/board/unboard/loadBoat/depart/undo/reset/standing/hint/grade` | `test/game.test.mjs`(17)：装船一律不计费、艄公独自开船计 1、`'free'` 空船不计步、超载抖动、教学性拒步报出两个角色、24 关认证路线逐趟走通且 `moves === par`、`undo`/`reset`、评星三档、`hint` 从无解位置返回 null |
| `js/core/make.js` | 构建期生成器：`SEEDS`（28 副经典题面）+ 5 个变异算子 + `grow/makeLot`；`scatter` 保留作对照 | `test/make.test.mjs`(7)：种子仍能量出注释里的数字、同种子同题面、产出的每个 lot 三个数自洽且 `par` 必为奇数、变异不许改 `TIERS`、两颗停止闸、`scatter` 顶档接受率 < 0.5、喂不出来的带必须返回 null |
| `js/core/library.js` | 查表：`ALL`(24) / `TIERS` / `LAWS` / `byId` / `campaign` / `levelAt` / `randomLot` / `dailyLot` / `stats()` | `test/library.test.mjs`(9)：24 行**从序列化 spec 重解**复现 `par`/`routes`/`explored`、`law` 与 `boat.rule` 双向一致、四档不重叠且 `order` 连续、每档两种船与两个家族的实际计数、每日题 = `hashSeed("daily|<day>") % 24` 的算术可复算 |
| `js/core/storage.js` | localStorage 存档 + 三条单调性 + 清档 | `test/storage.test.mjs`(13)：无 `window` 退化内存、`best` 只降、`unlocked` 只升、`perfect` 粘滞且用提示即不给、corrupt payload 修复、DOM 侧落盘、清档连 key 一起删 |
| `js/core/rng.js` | `hashSeed`（FNV-1a **派生**的两轮混合，**不是**教科书 FNV-1a）+ `mulberry32` + `rngFrom` + `todayKey` | **无独立测试文件**。间接证据：`test/library.test.mjs:109`（同一日期两次 `dailyLot` 同 id，且 id 下标 = `hashSeed % 24`）、`test/make.test.mjs:36`（不同种子不许相等）、`test/make.test.mjs:27`（同种子逐字段相同）。契约要求的"`hashSeed('a') = 723832900` / `>>>0` 落在 32 位内"两条**没有写成语句级断言**（§6-4）；本次实测：`node -e 'import("./js/core/rng.js").then(m=>console.log(m.hashSeed("a")))'` → `723832900` |
| `js/data/lots.js` | 构建期产物：`TIERS_META`（第 7 行）+ 24 行关卡 | `test/library.test.mjs` 对磁盘上的行独立复算 + `node tools/bake.mjs` 的复验（`tools/bake.mjs:123-129` 三条 throw：par 不可复现 / routes 不可复现 / `truncated` 为真）。本次重跑产物与仓内版本 diff 为空 |

### 服务器与桌面壳

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `server.cjs` | 零依赖静态服务器，默认端口 **5180**（`:48,:59`；`npm run dev` 用 5190） | 本次只有语法门禁 `npm run check`。运行时门禁在 `tools/verify.sh:41,68-73`（起它并轮 web 根目录**内容**）——本次未执行，§6-1 |
| `electron/main.cjs` | 桌面壳，复用 `server.cjs` 且 `port: 0`（`:7-8`） | **只有语法门禁**。未真实启动过（仓内不装 electron），§6-5 |

### tools/ 与 test/

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `tools/bake.mjs` | 出题 → **序列化后复验** → 写 `js/data/lots.js`，打印接受率/弃因/直方图 | 本次实跑（在 `/tmp` 副本上），输出见 §4 |
| `tools/harness.mjs` | 微型框架 `test/ok/eq/run`，node 与浏览器套件同形状 | §5.2 的 6 行 `rows: N fail: M` 全部由它打印；`tools/verify.sh:101-128` 按同一形状解析浏览器段 |
| `tools/playtest.mjs` | 零依赖 CDP 驱动：`open/nav/eval/shot/logs` + Node 侧 `@pointer` 真实鼠标 | 本次**未执行**（§6-1）。它自己的语法由 `npm run check` 的 `node --check tools/*.mjs` 覆盖 |
| `tools/verify.sh` | 一次性验收门（独立 `mktemp -d` profile、`/json/version` 与 web 内容双就绪、`trap cleanup EXIT` 里对 Chrome/服务器/看门狗都 `wait`、花括号计数截 JSON、`SKIP_UNIT=1`、端口占用即 `exit 6`） | 本次**未执行**。静态一致性核查见 §3 末行：脚本要求的 `id="lot"` 确实在 `index.html:25`，`window.ferry` 确实在 `js/main.js:474`，`MIN_BROWSER_ROWS=38` 与 `SCENARIOS` 的五段名（boot/play/routes/save/pointer）都在 `tools/playtest.mjs:447-687` 里存在 |
| `test/fixture.mjs` | 手算题面：`WGC`、`WGC_ROUTE`（人类散文翻译成的七步）、`PAIR`/`PAIR_ROUTE`、`missionaries(n, rule, cap)` | 被 `test/anchors.test.mjs` import；`:141` 断言这七步本身长度 7 且逐条 `cross()` 通过、终点 `mask = 0 / bank = RIGHT`；期望值不从被测代码读 |
| `test/anchors.test.mjs` (21) | §0 锚点表逐行复现 + `layerSearch` 独立实现 + 前沿耗尽的不可解 + 手写七步 + 教学性拒步 | `node --test test/anchors.test.mjs`（§5.2） |
| `test/river.test.mjs` (28) | 冲突判定四个时刻、两条口径、`validate` 负例、编码互逆、纯函数性 | 同上 |
| `test/game.test.mjs` (17) | 计费口径（装船不计/开船计 1）、拒步不改状态、24 关认证路线回放、撤销/重开/评星/提示 | 同上 |
| `test/library.test.mjs` (9) | 24 行产物复证、`law` 双向一致、四档不重叠、`stats()` 与 `TIERS_META` 对齐、每日/随渡确定性 | 同上 |
| `test/make.test.mjs` (7) | 生成器纯净性、停止闸、`scatter` 诚实性、不可能带必须交 null | 同上 |
| `test/storage.test.mjs` (13) | 存档三条单调性、退化、清档、corrupt payload | 同上 |
| `test/balance.mjs` | **量具，不是门禁**（无 `rows/fail`）：文档引用的生成实测数字来自它 | 本次实跑，行见 §4 |

### 其它

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `package.json` | `"type":"module"`、零依赖、`check/dev/bake/balance/unit/verify` 脚本 | `npm run check` rc=0（§5.1）；`npm run unit` 与 §5.2 同一集合（脚本 `unit` = `for f in test/*.test.mjs; do node "$f"`） |
| `.github/workflows/ci.yml` | unit job（`node --check` 全量 + 逐个 `test/*.test.mjs`）+ browser job（`SKIP_UNIT=1`、`WD_TIMEOUT=240`） | **本机未执行 Actions**（无远端、禁止 git 写操作）。它的两个 run 与 `npm run check` / `npm run unit` 的文件集合**逐字一致**（同一条 for-glob），因此 §5.1 与 §5.2 就是它们的本地等价物 |
| `.github/workflows/pages.yml` | 文件拷贝式部署：只 `cp index.html` + `cp -r css js`（绝不 `path: .`） | **本机未执行**。被拷的三样东西就是 `index.html`/`css/`/`js/`，与 `index.html:10,67` 引用的路径一致；`server.cjs`/`tools/`/`test/` 不在产物里 |
| `README.md` / `DESIGN.md` | 玩法与面向维护者的约束/踩坑说明 | **无自动门禁**。数字复现命令是 `node test/balance.mjs`、`node tools/bake.mjs` 与 §4 那条 scatter 命令；`App 名称` 与 `README.md:1` 的一致性见摘要表第一条 |
| `.gitignore` / `LICENSE` | 忽略物；MIT，`Copyright (c) 2026 z-biz-game`（`head -3 LICENSE`） | 无门禁 |
| `deliverable.md` | 本文件 | 自身无门禁；每条声称指向 §4/§5 |

---

## 2. 磁盘事实（本次核查，命令与输出对应）

| 声称 | 命令 | 实测 |
|---|---|---|
| `js/core/*` 不碰 DOM，`node --test` 才能直接 import | `grep -rn "window\.\|document\." js/core/` | 4 行命中，全在 `js/core/storage.js:30,37,64,122`，且 `:30` 是 `typeof window !== 'undefined'` 守卫 —— 契约 §1 明示的唯一豁免 |
|  shipped 代码不 import 生成器 | `grep -rn "core/make" js/main.js js/view.js js/core/library.js` | 空（生成只发生在 `tools/bake.mjs`） |
| 零依赖 | `node -e` 读 `package.json` | `dependencies {}`、`devDependencies {}` |
| 无 `node_modules` | `ls node_modules` | `No such file or directory` |
| 无二进制资产 | 摘要表里的 `find` | 只剩 `LICENSE` |
| 关卡确实是产物而不是手写 | `grep -c '^  {' js/data/lots.js` → `24`；`head -1 js/data/lots.js` | `// Generated by tools/bake.mjs — ...`；本次重跑（`/tmp` 副本）产物与仓内版本 **diff 为空** |
| 每条 par 都是奇数（难度带为什么长成 1-3/5-7/9-11/13-15） | `node -e` 打印 `library.js` 的 `ALL.map(l=>l.par)` | `1,1,3,3,3,3,5,5,5,5,7,7,9,9,9,9,11,11,13,13,15,15,15,15`；断言在 `test/make.test.mjs:57` |
| 全仓没有 `if (n >= 4) return false` 这类特判 | `grep -rn "n >= 4\|n > 3" js/core/`（配合 §5.2 里两条 truncated / 6+6 断言） | 无命中；不可解只由 `solve()` 的前沿耗尽给出 |
| `hashSeed` 不是教科书 FNV-1a | `node -e 'import("./js/core/rng.js").then(m=>console.log(m.hashSeed("a")))'` | `723832900`（教科书 FNV-1a 是 `3826002220`） |
| `verify.sh` 内部自洽 | 对读脚本要求与页面/钩子 | 它 grep 的 `id="lot"` 在 `index.html:25`；它轮询的 `window.ferry.state.id` 在 `js/main.js:474`+`:487`；五段场景名在 `tools/playtest.mjs:447`（`SCENARIOS`）与 `:129`（pointer 特判）里都存在；`CDP_PORT=9348`/`WEB_PORT=5188` 由脚本 `export` 给 `playtest.mjs`，覆盖后者的 9340/5180 默认值 |

---

## 3. 数字从哪来（一条命令复现那张表）

本仓的难度证明是 **BFS 证明值 + 前沿耗尽**，不是唯一解证明，也不是闭式公式。
三段量具，每条都可重跑：

### 3.1 外部锚点：`node --test test/anchors.test.mjs`

21 条断言全绿（§5.2）。表里每个数字都被两个独立实现同意：`js/core/solve.js` 的分层 BFS，
与 `test/anchors.test.mjs:27` 的 `layerSearch()`（纯 `Set`、逐层推进，无距离表、无 `parent[]`）。
"不可解"的每一行都额外要求 `truncated === false`（前沿耗尽）与 `layerSearch.exhausted === true`。

| 题面 | 船口径 | 期望（人类先写） | 实测 par | 最短路线条数 | 探索态 / 状态空间 |
|---|---|---|---|---|---|
| 狼羊菜（艄公+狼/羊/菜，cap 2） | `'ferry'` | 7 | **7** | 2 | 10 / 32 |
| 狼羊（最小关，cap 2） | `'ferry'` | 3 | **3** | 2 | 6 / 16 |
| M&C 1+1 | `'free'` | 1 | **1** | 1 | 6 / 8 |
| M&C 2+2 | `'free'` | 5 | **5** | 18 | 22 / 32 |
| M&C 3+3 | `'free'` | 11 | **11** | 8100 | 64 / 128 |
| M&C 4+4 | `'free'` | 不可解 | — | 0 | 98 / 512（前沿耗尽） |
| M&C 5+5 | `'free'` | 不可解 | — | 0 | 212 / 2048（前沿耗尽） |
| M&C 1+1 | `'ferry'` | 3 | **3** | 2 | 8 / 16 |
| M&C 2+2 | `'ferry'` | 7 | **7** | 4 | 28 / 64 |
| M&C 3+3 | `'ferry'` | 不可解 | — | 0 | 49 / 256（前沿耗尽） |
| M&C 4+4 | `'ferry'` | 不可解 | — | 0 | 112 / 1024（前沿耗尽） |
| M&C 4+4 | `'free'` cap 3 | 9 | **9** | 329472 | 196 / 512 |
| M&C 4+4 | `'ferry'` cap 3 | 7 | **7** | 900 | 356 / 1024 |
| M&C 6+6 | `'free'` cap 2 | 不可解 | — | 0 | 423 / 8192（前沿耗尽） |

倒数第三行是本仓最要紧的一条：**同样 8 个人，船从容量 2 放宽到 3，"不可解"就变成 9 单程** ——
所以可解性不许按人数判。手写七步（`test/fixture.mjs:29` `WGC_ROUTE`）与求解器返回的路线被断言为
**逐趟相同**（`test/anchors.test.mjs:176`），其中第 2、6 步是**艄公独自划回来**（`:161`）。

### 3.2 产物复证：`node tools/bake.mjs` 的复验条款 + `node --test test/library.test.mjs`

bake 只让"重新解一遍能复现印着的数字"的关卡入库，三条不满足直接 throw：
`tools/bake.mjs:123`（par 不符）、`:127`（routes 不符）、`:129`（搜索被截断，即结论不是证明）。
本次实跑（`/tmp` 副本，stdout 原样）：

```
shoal      收 6 题  seeds 40 → levels 40 (100%) · unique 9 (23%)  · 变异接受 10/10     (100.0%) · 弃因 无提升 0 不可解 0 超带 0 人数不合 4 低于带 0 同数平移 2 · 0.0s
           选中 par 1,1,3,3,3,3 · 船口径 艄公,自由,艄公,艄公,艄公,自由
ford       收 6 题  seeds 40 → levels 40 (100%) · unique 20 (50%) · 变异接受 68/4563   (1.5%)   · 弃因 无提升 3483 不可解 357 超带 655 人数不合 7 低于带 5 同数平移 37 · 0.2s
           选中 par 5,5,5,5,7,7 · 船口径 艄公,艄公,艄公,自由,艄公,自由
rapids     收 6 题  seeds 40 → levels 40 (100%) · unique 16 (40%) · 变异接受 194/25146 (0.8%)   · 弃因 无提升 20068 不可解 4287 超带 597 人数不合 8 低于带 40 同数平移 85 · 2.1s
           选中 par 9,9,9,9,11,11 · 船口径 艄公,艄公,艄公,艄公,艄公,自由
labyrinth  收 6 题  seeds 40 → levels 40 (100%) · unique 29 (73%) · 变异接受 339/41452 (0.8%)   · 弃因 无提升 27287 不可解 13826 超带 0 人数不合 33 低于带 25 同数平移 93 · 9.3s
           选中 par 13,13,15,15,15,15 · 船口径 艄公,艄公,艄公,艄公,艄公,艄公

实测 par 直方图（候选池，决定难度带边界）：
  shoal      1 单程 x2  3 单程 x7
  ford       5 单程 x11  7 单程 x9
  rapids     9 单程 x9  11 单程 x7
  labyrinth  13 单程 x16  15 单程 x13

最慢一题 1126 ms · 最大搜索 212 态（2^(n+1) 之中）
写入 24 题 -> js/data/lots.js
```

| 要报的 | 实跑值 |
|---|---|
| 题数 | 160 颗种子（4 档 × 40）→ 160 题产出（每档 100% 出题率）→ 去重后候选池 9/20/16/29 → 每档收 6 题，共 **24 题** |
| 每档 par 范围（已发布，UI 印的） | 浅滩 1–3、短渡 5–7、急流 9–11、迷津 13–15 |
| 变异接受率 | shoal 10/10 = 100%、ford 68/4563 = 1.5%、rapids 194/25146 = 0.8%、labyrinth 339/41452 = 0.8% |
| 弃因计数 | 无提升 50838 · 判不可解 18470 · 超带 1252 · 人数不合 52 · 低于带 70 · 同数平移 217（四档相加，原值见每档行） |
| 耗时 | 单题最慢 1126 ms；四档分别 0.0 / 0.2 / 2.1 / 9.3 s（合计约 11.6 s） |
| 最大搜索状态数 | 212 态（`labyrinth-02`，8 角色 ⇒ 512 个态里可到 212 个） |
| 复现命令 | `node tools/bake.mjs`（可选 `PER_TIER=8`、`COLLECT=60` 两个环境变量，`tools/bake.mjs:28-29`） |

### 3.3 生成器与前端代价：`node test/balance.mjs`（本次实跑）

```
== 变异生成器（js/core/make.js 的 makeLot，实际出货口径）==
shoal        100.0%     58.3%         0         0        4           0 ms     8ms  8/60   实测 par 分布 {"1":34,"3":26}
ford         100.0%      1.6%        51       191     1333           0 ms    47ms  32/60  实测 par 分布 {"5":38,"7":22}
rapids       100.0%      1.0%        80      3852      525           1 ms   422ms  33/60  实测 par 分布 {"9":36,"11":24}
labyrinth    100.0%      0.7%       139     24369        0         123 ms  1812ms  36/60  实测 par 分布 {"13":42,"15":18}

== 撒点生成器（scatter，已被替换的那个）==
shoal          109     18.3%      38.5%     41.3%      0.0%
ford            89     22.5%      40.4%     13.5%     22.5%
rapids         164     12.2%      39.0%      0.6%     45.7%
labyrinth     2016      1.0%      35.1%      0.0%     61.3%

== 状态规模与前端代价（浏览器里点一次提示要搜多少态）==
狼羊菜 4 角色           7 单程 / 2 条最优 · 搜了 10 态 · 0 ms · truncated=false
M&C 3+3 无艄公        11 单程 / 8100 条最优 · 搜了 64 态 · 0 ms · truncated=false
M&C 6+6 无艄公        不可解 · 搜了 423 态 · 1 ms · truncated=false
```

第三段就是"前端为什么不需要生成"的答案：** shipped 关卡的提示搜索最多 212 态、亚毫秒**。
`scatter` 那一段是把 `js/core/make.js` 顶注里的旧数字拿出来对了一遍 —— 见 §5 改动表 #7。

### 3.4 scatter 顶档接受率的定点复现（文档里那句 1.14% 的出处）

```
$ node -e 'Promise.all([import("./js/core/make.js")]).then(([M])=>{const tier=M.tierByKey("labyrinth");const st={};for(let s=0;s<40;s++)M.scatter(`probe4000-${s}`,tier,st);const probed=(st.found||0)+(st.unsolvable||0)+(st.tooHard||0)+(st.underBand||0)+(st.invalid||0)+(st.nofit||0);console.log("probed",probed,"found",st.found,"rate",((st.found/probed)*100).toFixed(2)+"%","unsolvable",st.unsolvable,"solvable",(((st.found+st.tooHard+st.underBand)/probed)*100).toFixed(1)+"%");})'
probed 3521 found 40 rate 1.14% unsolvable 1265 solvable 62.3%
```

结论与建造者写在注释里的定性判断一致（撒点填不满顶档），但**数字不同**，登记在 §5-#7 与 §6-7。

---

## 4. 已发布池子的形状（`library.stats()`，本次实跑）

| 档 | 关卡数 | par 区间 / 中位 | 角色数 | 可通行局面 min/med/max | 艄公船 / 自由船 | pair / majority |
|---|---|---|---|---|---|---|
| 浅滩 shoal | 6 | 1–3 / 3 | 2–4 | 6 / 10 / 14 | 4 / 2 | 3 / 3 |
| 短渡 ford | 6 | 5–7 / 5 | 5–6 | 32 / 45 / 66 | 4 / 2 | 3 / 3 |
| 急流 rapids | 6 | 9–11 / 9 | 6–7 | 40 / 57 / 64 | 5 / 1 | 4 / 2 |
| 迷津 labyrinth | 6 | 13–15 / 15 | 8–8 | 160 / 160 / 212 | 6 / 0 | 5 / 1 |

复现命令（就是 README「难度带」那一节印的那条，本次实跑）：

```bash
node -e 'import("./js/core/library.js").then((L)=>{const s=L.stats();for(const t of L.TIERS){const b=s.byTier[t.key];console.log(...)}})'
```

迷津档 `自由船 = 0` 是实测结果而不是配平失败；`test/library.test.mjs` 要求 `b.n === t.free + t.ferry`
且 `b.parMin === t.min && b.parMax === t.max`，所以想把它"配平"必须先重烤。

---

## 5. 改动表（先写错在哪 → 为什么对）

标签：**[本仓真踩过的]** = 这份代码/台架里确实错过，注释或断言记着；**[规格主张，被实测否证]** =
简报 `/tmp/puzzle-brief/ferry.md` 写错而本仓按实测交付；**[契约偏差]** = 契约文本与本仓实现的差异，
且本仓的选择有实测理由；**[风险类]** = 容易错、DESIGN 要求"错法要有对应的钉"，本仓没有提交过；
**[本次核查新发现，未修]** = 这一轮读文件发现的文档/注释缺陷（本任务禁止改代码，只登记）。

| # | 当时错在哪 | 为什么现在是对的 | 证据 |
|---|---|---|---|
| 1 | **[本仓真踩过的]** 把"船怎么开"当成一条实现细节，写成"空船不许走"，于是经典狼羊菜被判成**不可解** | 狼羊菜解的第 2、4、6 步就是**艄公独自划回来**。`'ferry'` 口径的实现是"艄公必须在船上，另可载 `0..capacity-1` 人"，**艄公单独是一趟合法渡河**；`'free'` 口径才禁空船 | `js/core/river.js:20-24`（口径注释）、`:195`（`loadingFault` 的两条分支）；`test/anchors.test.mjs:161` "step 2 and step 6 … are the boatman crossing alone (a first draft banned this)" —— 同一条测试还反向断言 `'free'` 口径下同样的单人船返回 `'empty'`。跑：`node --test test/anchors.test.mjs` |
| 2 | **[规格主张，被实测否证]** 简报 §0 的表（含"3+3 加艄公就不可解"那行）需要有人独立复现才算数，否则就是把简报当 oracle | 简报的 8 行全部由 `test/anchors.test.mjs` 逐行复现（期望值手写在测试里，不从被测代码读），并由 `layerSearch()` 第二次同意；规格自己说的"我 2026-09-27 用 BFS 亲自跑出来的"在本仓变成了可重跑的断言而不是引用 | §3.1 那张表（14 行全部实测）；`node --test test/anchors.test.mjs` 21 条全绿 |
| 3 | **[本仓真踩过的]** `layerSearch()` 从 `eachCargo` 的回调里 `return` 表示"找到目标" | 那只是**离开回调**，于是它对每一题都报不可解 —— 一个坏掉的第二实现差点把"独立证据"变成假证据。现在目标判定放在层循环出口处 | `test/anchors.test.mjs:22-26` 的注释；`:65-73` 对不可解行同时要求 `layers.exhausted === true` 且 `states < full`（前沿真的空了，不是守卫先撞） |
| 4 | **[契约偏差]** 契约 §1 与规格 §2 要求距离表用 `Int8Array` | 12 角色 = 8192 项，某些题面的最短路可以超过 127，`Int8` 会**静默回绕成负**，然后 `dist[next] >= 0` 的"已访问"判据失灵。改用 `Int16Array`（每项 2 字节，遍历代码一字未动） | `js/core/solve.js:14-16`（决策与理由）、`:36`（`new Int16Array(size).fill(-1)`）；`node --test test/` 全绿 |
| 5 | **[契约偏差]** "不可解"可以被写成按人数特判（`if (n >= 4) return false`，M&C 的教科书结论） | 特判会让"把船容量放宽到 3"这类变化无法被表达：实测 4+4 自由船 cap 2 不可解、cap 3 = **9 单程**、4+4 艄公船 cap 3 = **7 单程**。本仓的不可解只由前沿耗尽给出，并带 `truncated` 标记区分"没搜完"与"搜完了" | `test/anchors.test.mjs:110`（roomier boat）、`:117`（6+6 也由耗尽给出）、`:127`（预算截断必须报 `truncated: true`）；`js/core/solve.js:73-75` |
| 6 | **[本仓真踩过的]** 生成器要求"每次变异必须让 par 严格变大"，于是一个档收敛到两三种标准形状 | 加入**有配额的同数平移**（`tier.lateral` + 0.5 概率）：形状可以变、发布出去的 par 仍然是最后量到的那个数，且必须落在带内。本次实测唯一题面：shoal 9/40、ford 20/40、rapids 16/40、labyrinth 29/40（§3.2） | `js/core/make.js:315-324`（lateral 分支与两个测量值）、`tools/bake.mjs:35-44`（`faceOf` 多样性挑选，注释同样引用这次测量）；跑：`node tools/bake.mjs` 看 `unique` 那一栏 |
| 7 | **[本次核查新发现，未修]** `js/core/make.js:9-16`、`:238` 与 `tools/bake.mjs:4-9` 的注释印着 "4000 样本 17 个（0.4%）"、"约 46% 随机题面可解"、"60 颗种子 14 个不同题面" | 本次在同一份代码上实测是 **1.14%（40/3521）**、**62.3% 可解**、**36 个不同 signature/60 颗种子**（§3.3、§3.4）。差异来源：那些数字是**加入 lateral 之前**的严格递增版生成器量的。定性结论没变且更强，但注释数字已过期，**引用前先重跑** `node test/balance.mjs` 与 §3.4 那条命令。本任务禁止改代码文件，故只登记 | 复现命令与输出就在 §3.4；文档侧的处理写在 `DESIGN.md` §3.3 末段与 §10 第三条 |
| 8 | **[风险类]** 难度带写成 `1-4 / 5-8 / 9-12 / 13-16` 这种"看着等宽"的区间 | 船从左岸出发、终点要求船停在右岸 ⇒ **每个 par 都是奇数**，偶数那半边格子永远空着。带只能是 `1-3 / 5-7 / 9-11 / 13-15`，并且 `par % 2 === 1` 本身是断言 | `test/make.test.mjs:57`；`js/core/make.js:427-429` 的注释说明"每个 par 都是奇数"这件事是量出来的；§3.2 的直方图只有 `1,3,5,7,9,11,13,15` 八格 |
| 9 | **[家族教训]** 把"生成包络"与"已发布关卡实际落成的 min/max"当同一个数（Gridlock 抄错过的那一格） | `js/core/make.js:430` 的 `TIERS` 是生成时允许什么；`js/data/lots.js:7` 的 `TIERS_META` 是入库行量出来的 min/max/两种船各几关，由 `tools/bake.mjs:191` 现算，UI 印后者 | `test/library.test.mjs` "every band shows both boat laws where the data claims it does"（要求 `parMin === t.min`、`n === t.free + t.ferry`）+ "the four bands do not overlap…" |
| 10 | **[风险类]** 让 shell 或 view 自己再判一次"这步能不能开船" | 两条船口径的差异必须只有一个出处，否则改一处漏一处，画面会**安静地说谎**。`js/view.js` 只把三种手势翻成一次 `onBoard/onUnboard/onDepart` 请求；拒因文案由 `js/main.js:112` 的 `faultText()` 直接消费 core 返回的 `why`/`conflict` | `test/game.test.mjs:99`（拒步报出**是哪两个角色**）、`:88`（超载抖动不计数）、`:25`（装卸一律不计费）；`js/core/river.js:256`（`cross` 是唯一判定点） |
| 11 | **[本仓真踩过的]** `'free'` 口径下"没有艄公"如果靠"查不到艄公索引"来表达，任何一岸都会因巧合被判无人监管 | 这条差异必须写死：`supervised()` 在非 `'ferry'` 口径下**显式 `return false`**，注释就地说明这条线就是两条口径的分岔 | `js/core/river.js:120-127`；`test/river.test.mjs:35` "under the free law no bank is ever supervised, even the one a 'ferry' cast would call home"、`:107`（moment 3：同一个落地在 `'free'` 下死） |
| 12 | **[风险类]** 终点只判"左岸空了" | `'free'` 口径下左岸空了并不蕴含船也过去了。`solvedState` 是 `mask === 0 && bank === RIGHT`，两个条件都写出来 | `js/core/river.js:283-286`；`test/river.test.mjs:270` "solvedState wants everyone off the left bank *and* the boat with them" |
| 13 | **[风险类]** 冲突判定的**时刻**搞混（判船离开前的旧状态 / 判到达岸却免判了离开岸 / 载法与岸上冲突混报） | 实现是：先 `loadingFault`（`'far'/'over'/'ferry'/'empty'`），再对**新状态**的两岸判，跳过被监管的那岸。四个时刻各有正反例 | `test/river.test.mjs:80,89,96,107,121,133`（moment 1-4 与两条补充）；`test/anchors.test.mjs:205`（教学性拒步，`where = 'departure'`、`conflict.roles = [2, 3]`） |
| 14 | **[家族教训]** 台架导航之后 `sleep()` 等待、或多个仓共用一个 DevTools 端口 | `tools/playtest.mjs:99` `waitShell()` 轮询 shell；`tools/verify.sh` 先轮 `/json/version` **再轮 web 根目录的内容**（`grep 'id="lot"'`，别人家的 index.html 不算就绪），`:91-96` 再轮 boot 关卡 id；`:32-35` 端口被占直接 `exit 6`；`:43-53` 的 `trap cleanup EXIT` 对 Chrome/服务器/看门狗都 `wait` 并 `pgrep` 查残留；结果 JSON 用**花括号计数**截（`:101-128`） | 静态核查见 §2 末行；**运行性本次未验证**（§6-1） |
| 15 | **[风险类]** 搜索被预算截停时仍然交出一个"不可解"结论 | `solve()` 返回 `truncated` 标记，任何"不可解"声称都以 `truncated === false` 为前提；bake 遇到 truncated 直接 throw（`:129`），`test/library.test.mjs` 对 24 行逐行要求它 | `js/core/solve.js:49-50,73-75`；`test/anchors.test.mjs:127`；`node --test test/library.test.mjs` |

---

## 6. 未实现清单（诚实列）

按"缺什么"排序，不是"做完了什么"换种说法。

1. **浏览器层本次没有跑，所以本文件不声称它绿**。`tools/playtest.mjs` 五段（`@boot @play @routes @save @pointer`）
   与 `tools/verify.sh`（`SKIP_UNIT=1` 支持、门线 38 条）都在磁盘上、语法过 `node --check`，
   但 `bash tools/verify.sh` 按指示**没有执行**（本机 headless Chrome 被农场多仓争用，归 lead 跑）。
   因此本文件**没有**浏览器断言条数、没有截图路径、**没有** §线上验收，也没有"ALL GREEN"这一行。
2. **GitHub Actions 未在本机执行过**（无远端、本任务禁止 git 写操作）。`ci.yml` 的两个 step 与
   `npm run check` / `npm run unit` 的文件集合逐字一致，§5.1 与 §5.2 是它们的本地等价物；
   "CI 绿"要等主代理推上去才成立。`pages.yml` 同理未执行。
3. **一个未接线的 core 导出**：`js/core/solve.js:115` 的 `census()`（返回 `{states, share, truncated}`）
   **没有任何调用方** —— `grep -rn "census" js test tools` 只命中定义本身与两处测试**名称**里的英文单词。
   契约 §5 要求"导出而无人调用则删"，但本任务禁止修改代码文件，所以登记而不删。
   它想表达的第二维（可通行局面数）实际上已经落地了：关卡行的 `states` 字段、`solve()` 的 `explored`
   与面板"K 个可通行局面"都不经过 `census()`。
   另一格是 `js/core/rng.js` 的 `mulberry32`：只被同文件的 `rngFrom` 使用（导出多余），
   那是契约 §1"rng.js 原样搬运"与 §5"无人调用则删"的冲突格，本仓按 §1 保留。
4. **`hashSeed` 缺两条自洽断言**：契约 §1 点名的"同种子两次调用相等 / 结果落在 `>>>0` 的 32 位内"
   没有写成独立语句（现有的是 `test/library.test.mjs:109` 的日期算术与 `test/make.test.mjs:36` 的不同种子不相等），
   而 `hashSeed('a') = 723832900` 这个"不是教科书 FNV-1a"的事实**目前只由文档与本文件 §2 那条命令承载**。
   补法是在 `test/` 里加一个小套件（本次禁止动 `test/`）。措辞已经正确：
   `grep -rni "fnv" js test tools` **0 命中**（代码、测试与台架里没有出现过 "FNV-1a" 这个标签），
   全仓唯一提到它的是 `README.md` 文件地图里那句"hashSeed（FNV-1a 派生的两轮混合）"与 `DESIGN.md` §5。
5. **Electron 壳从未真实启动**。只有 `npm run check` 里的 `node --check electron/main.cjs`；仓内不装 electron。
   `electron/main.cjs:7-8` 确实复用 `server.cjs` 且 `port: 0`（契约要求），但运行性未验证。
6. **移动端未真机验证**。`css/game.css:43` 有 `touch-action: none`、`:119` 有 ≤820px 断点，
   但台架 `@pointer` 派发的是 `Input.dispatchMouseEvent`，没有派发过触摸事件。README 已声明。
7. **代码注释里的生成器旧数字与本次实测不符**（0.4% / 46% / 14 个不同题面 vs 实测 1.14% / 62.3% / 36），
   见改动表 #7。已登记在 `DESIGN.md` §3.3 末段，但**注释本身没改**（本任务禁止改代码文件）。
8. **玩家可以把可解的关卡走进无解局面**，UI 没有补偿（无自动撤销、无"这题已死"的提示，只有
   `hint()` 返回 `null` 与 `depart()` 的 `already` 拒绝）。这是接受的设计边界而不是 bug，
   但对玩家不友好，写在 `README.md` 已知边界与 `DESIGN.md` §10 末条。
9. **`tools/balance.mjs` 不是门禁**：它只打印，不返回 `rows/fail`，也不参与 CI 的任何一步。
   文档里引用的生成实测数字（§3.3）因此**没有**被自动比较 —— `test/make.test.mjs:115` 那条
   `rate < 0.5` 是唯一沾边的自动上界，而且它故意放得松。

### 规格符合性（对照 `/tmp/puzzle-brief/ferry.md`）

| 规格条 | 要求 | 实测 |
|---|---|---|
| §0 锚点表逐行复现 | 8 行 + "3+3 加艄公即不可解"是本仓最重要的教训 | 达成（`test/anchors.test.mjs` 21 条；§3.1 表 14 行）。**规格自称的"实测"在本仓变成了可重跑断言** |
| §1 两种船口径都实现 | `'ferry'` 艄公必在船上、另载 0..cap-1，独自过河合法；`'free'` 1..cap、空船不许 | 达成（`js/core/river.js:195-207,228-243`；改动表 #1/#11） |
| §1 冲突两型 + `'free'` 下两岸都判 | `pair` / `majority`，且这条要显式写而不靠巧合 | 达成（`river.js:123` 的显式 `return false`；`test/river.test.mjs:35,107,133`） |
| §1 合法性时序四个时刻 | DESIGN 画成表并给正反例 | 达成（`DESIGN.md` §2.2 的表 + 6 条断言行号） |
| §1 不可解由前沿耗尽给出 | 不许 `if n >= 4` 特判 | 达成（`js/core/solve.js:73-75`；§2 的 grep；改动表 #4/#5/#15） |
| §2 求解器返回 par + 路线 + 最优路线条数 | 分层 BFS、按 `(bank,mask)` 索引 | 达成，但距离表是 `Int16Array`（契约写 `Int8Array`，见改动表 #4） |
| §2 手算 fixture + 序列化复证 | 狼羊菜 7 步逐条写出、产物重解复现 par | 达成（`test/fixture.mjs:29`、`test/anchors.test.mjs:141,176`、`test/library.test.mjs:20`） |
| §3 生成策略与接受率必须打印 | 撒点接受率低就改成"经典题面局部变形 + 复测 par" | 达成（`js/core/make.js:13-20` 记的就是这个决定；`tools/bake.mjs:176-184` 打印接受率与弃因；§3.2/§3.3/§3.4 是本会话实跑） |
| §3 四档带由实测直方图定、互不重叠 | 附加维度：角色数、船容量与口径、冲突边数 | 达成（§4 表 + `test/library.test.mjs` 不重叠断言）。**"两口径各占一定比例"在迷津档实测为 0**，如实印出（§4） |
| §4 UI：拖人上船不计数、点船/拖船 = 一次渡河、超载抖动、两种口径各一条断言、教学性拒步高亮两个角色 | — | 代码与台架都在（`js/view.js:594-625`、`tools/playtest.mjs:238-437`），但**运行性本会话未验证**（§6-1） |
| §5 node ≥ 38 | — | **95 条，fail 0**（§5.2） |
| §5 browser ≥ 38，含真实输入段 | `@pointer` 用 `Input.dispatchMouseEvent` 走完一关 par ≤ 7 | 场景已写成 par 3 的 `shoal-03`（`tools/playtest.mjs:238`）；条数与绿否本会话未测（§6-1） |
| §7 已知不做 | 波浪/时间流动、手电筒类变体、多船 | 达成（`DESIGN.md` §9）；船容量随关卡变**已实现**（每行 `capacity`） |

---

## 7. 验收结论（真跑出来的输出行）

### 7.1 `npm run check`

```
$ npm run check

> ferry@1.0.0 check
> for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check "$f" || exit 1; done && echo OK

OK
rc=0
```

这一条 with `ci.yml` 的 `Syntax` step **逐字同集合**（同一个 for-glob），所以本地绿 = 那一步绿。

### 7.2 `node --test test/`

```
$ node --test test/
rows: 21 fail: 0
✔ test/anchors.test.mjs (57.879292ms)
rows: 17 fail: 0
✔ test/game.test.mjs (51.2815ms)
rows: 9 fail: 0
✔ test/library.test.mjs (55.681042ms)
rows: 7 fail: 0
✔ test/make.test.mjs (902.534459ms)
rows: 28 fail: 0
✔ test/river.test.mjs (45.745917ms)
rows: 13 fail: 0
✔ test/storage.test.mjs (42.698334ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
rc=0
```

**断言行数 = 21 + 17 + 9 + 7 + 28 + 13 = 95，fail = 0，文件数 = 6，rc = 0。**
两个口径要说清，别混：`ℹ tests 6` 数的是**文件**（每个套件自跑自 `process.exit`，对 node 的 TAP 层只算一个用例）；
`rows: N` 才是 `tools/harness.mjs` 里的断言数。聚合命令：

```
$ node --test test/ | awk '/^rows:/{a+=$2; b+=$4} END{print "asserts="a" fail="b}'
asserts=95 fail=0
```

### 7.3 `node tools/bake.mjs`（在 `/tmp` 副本上）与 `node test/balance.mjs`

原文见 §3.2 与 §3.3。烘焙产物与仓内 `js/data/lots.js` diff 为空（md5 `caaf916210af2a3e828c07c52317a303`）。

### 7.4 没有的东西（不要在这里找）

`SKIP_UNIT=1 bash tools/verify.sh` 的输出、`=== ALL GREEN ===` 这一行、浏览器段的每段 rows、
截图路径、线上 URL 的状态码 —— **本会话一个都没产生**。谁要声称它们，必须先自己跑那一条命令
（并且本机同一时刻只允许一个 headless Chrome）。

## 线上验收（GitHub Pages，主代理 2026-09-27 实抓，补上上面那句话缺的证据）

发布 sha `695d24b`，CI trigger `6be9db6` → Actions `success`。

主代理门禁：`npm run check` rc=0；node **95 / 0 fail**；浏览器 **187 / 0 fail** 且
`=== ALL GREEN ===` rc=0。

| 资源 | 结果 |
| --- | --- |
| `/`（index.html） | 200 / 3,351 B |
| `js/main.js` | 200 / 20,893 B |
| `css/game.css` | 200 / 8,348 B |
| `js/data/lots.js` | 200 / 17,155 B |
| `<title>` | 与 README 首行一致（迷津渡） |

一条过程教训，写在这里以免后人把它当成仓库缺陷：本仓两次报出"0 行浏览器断言"都是**测量侧**的假阴。
第一次是别的代理被杀后留下的孤儿进程占住了 :9348（Chrome）与 5188（`node server.cjs`），
本仓的单 Chrome 守卫据此拒绝启动（rc=6）；确认两者 PPID 已为 1 且 `lsof` 无 ESTABLISHED 连接后清掉，
同一轮就跑到 187 行全绿。第二次是审计脚本只认 `rows: N fail: []` 这一种方言，
对 `rows: N passed: M fail: []` 直接读成 0。断言层从来不是 0。
