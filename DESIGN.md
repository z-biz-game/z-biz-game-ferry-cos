# 设计文档 · 迷津渡

面向维护者的技术说明：为什么这样实现、哪些约束一破就出 bug、契约禁止的"点击时现场搜索"与本仓允许的
做法边界在哪、难度带的四个数字是哪一次实测产出的、以及本仓真实踩过的"把经典题判成不可解"那个坑。
玩法与关卡清单见 [README.md](README.md)，真实存在且已验证的东西与改动表见 [deliverable.md](deliverable.md)。

---

## 1. 核心决策：`par` 是 `(bank, mask)` 状态图上的分层 BFS

一个局面就两样东西：**船在哪一岸**，以及**左岸还留着谁**（`mask` 是角色 id 的位掩码，位为 1 = 还在左岸）。
`n` 个角色 ⇒ `2^(n+1)` 个态（`js/core/river.js:81` 的 `size = 2 << n`），全部装进一条 `Int16Array`。
`js/core/solve.js:27` 的 `solve()` 在这张图上做一次分层广度优先遍历，返回：

| 字段 | 含义 | 谁读它 |
| --- | --- | --- |
| `par` | 从这个位置到"全员右岸、船也在右岸"的**最少单程数**（一次来回 = 2） | 面板"最少"、关卡行的 `par`、评星阈值、`grade()` |
| `route` | 一条最短路线，逐趟的货物 id 列表 | 提示、`@pointer` 的认证路线、bake 的复验 |
| `routes` | **最短路线的条数**（不是"有没有多解"，是一个数） | 面板"最优路线 M 条"、通关卡片 |
| `explored` | 从起点实际能走到的态数（可通行局面） | 关卡行的 `states`、面板"K 个可通行局面"、难度带的第二维 |
| `truncated` | 这次搜索有没有被 `limit` 截断 | 所有"不可解"声称的先决条件（见 1.2） |

三件实现上的事决定了这些数字可信，而不只是可用：

1. **距离表是 `Int16Array` 而不是 `Int8Array`**。12 角色的状态空间是 8192 项，一条最短路在某些题面上
   可以超过 127；用 `Int8` 会**静默回绕成负数**，然后 `dist[next] >= 0` 那个"已访问"判据就失灵了。
   契约文本写的是 `Int8Array`，本仓按实测改成了 `Int16Array`（每项 2 字节，形状与遍历代码一字未动）。
2. **遍历跑完整个可达分量，不是走到目标就停**。因为 `routes`（最短路线条数）要求所有比目标浅的层
   都已经被展开过；条数是在同一个队列（已按距离非序排列）上做**一遍**正向传播得到的
   （`js/core/solve.js:82`）。
3. **`eachSubset` 的枚举顺序是规范的一部分**（`js/core/river.js:212`）：子集按 id 升序生成，
   这决定了 BFS 报告的是"哪一条"最短路线。顺序一变，`#/<route>` 分享链接给出的路线就换了，
   而 `test/anchors.test.mjs` 里"求解器返回的狼羊菜路线 = 人类手写的那七步"这条断言会红 —— 这是设计意图。

### 1.1 为什么搜索放构建期，而提示可以是现场搜索

契约禁的是**成本上界由玩家输入决定的无上限搜索**。这里要分两件事，不能一句话打包：

- **生成 = 搜索**，而且很贵：迷津档一颗种子要 123 ms 中位 / 1812 ms 最慢，
  四万多次变异里只有三百多次被搜索同意（`node test/bake.mjs`、`node test/balance.mjs`，本次实跑，见 §3.3）。
  这种东西放进前端就是"手指点一下、页面算一秒"，所以它只在 `tools/bake.mjs` 里发生，
  shipped 代码不 import `js/core/make.js`（`grep -rn "core/make" js/main.js js/view.js js/core/library.js` 为空）。
- **提示 = 有界的现场搜索**：`js/core/game.js:152` 的 `hint()` 调 `bestCrossing`，
  带 `limit = 40000`。这个界不是装饰：shipped 关卡最多 8 角色 ⇒ 状态空间 ≤ 512 项，
  实测最多的一关只探索 212 态（`js/data/lots.js` 里 `labyrinth-02` 那行）。
  `test/anchors.test.mjs` 用 `limit: 8` 把"截断了就必须承认自己没证明"钉成了断言。

`par` 本身**永远不靠现场搜索**：它是烘焙进 `js/data/lots.js` 的测量值，玩家看到的是查表。
`hint()` 给的"还剩 N 单程"是从现在这一步起的第二次数，两者可以不相等（玩家绕了路就会超），
面板同时印"已用"与"最少"就是为了让这个区别可见，而不是藏进一个百分比里。

### 1.2 "不可解"只有在前沿耗尽时才成立

`solve()` 返回 `{ ok: false }` 的唯一条件是：**BFS 前沿走完且目标不在里面**。
被 `limit` 截停的搜索返回 `truncated: true`，任何调用方都不许把它当不可解：

```
M&C 4+4 自由船 容量 2   不可解 · 前沿耗尽于 98 个态（512 个里）
M&C 5+5 自由船 容量 2   不可解 · 前沿耗尽于 212 个态（2048 个里）
M&C 3+3 艄公船 容量 2   不可解 · 前沿耗尽于 49 个态（256 个里）
M&C 6+6 自由船 容量 2   不可解 · 前沿耗尽于 423 个态（8192 个里）
```

这四行都是本次会话在这份代码上跑出来的（`node -e` 调 `js/core/solve.js`，也都在 `test/anchors.test.mjs` 里）。
全仓没有一处 `if (n >= 4) return false`。为什么这条要单独一节：

> **同样 8 个人，把船从容量 2 放宽到 3，"不可解"就变成了 9 单程**
> （M&C 4+4 自由船容量 3 实测 `par = 9`、`routes = 329472`、探索 196 / 512 态）。

任何"按人数判可解性"的写法都会在这一格说谎，而且它不会崩——它只是把可玩的关卡静默判成死的。
钉：`test/anchors.test.mjs` "the same heads are solvable under a roomier boat: 4+4 free cap 3 = 9, 4+4 ferry cap 3 = 7"
与 "6+6 free cap 2 is unsolvable by exhaustion too (no n>=4 rule anywhere)"。

### 1.3 独立证据：搜索器不能给自己打分

契约要求"一个独立证据说明 par 不是搜索器自己给自己打分"。本仓用的是**第二个实现**，不是闭式公式
（过河类没有已知闭式最短解；M&C 的可解性有经典结论兜底，但**最少单程数没有**，所以只能靠两套实现互证）：

- `test/anchors.test.mjs` 里的 `layerSearch()`：纯 `Set`、一层一层推、没有距离表也没有 `parent[]`，
  它同时给出两半证明——第 `d` 层里出现了目标（路线存在），且第 `d-1` 层里没有（更短的不存在）。
  每一条可解的锚点行都要求 `solve().par === layerSearch().depth`。
- 人类手写的七步：`test/fixture.mjs` 的 `WGC_ROUTE` 是散文翻译成的货物列表（带羊过去 / 空船回来 /
  带狼过去 / 把羊带回来 / 带菜过去 / 空船回来 / 带羊过去），期望值不从被测代码读。
  测试把**这七步**逐条喂 `cross()` 走完，再断言求解器返回的路线与它逐格相同（`routes = 2`：
  先狼与先菜是两条对称的最优解）。
- 产物复证：`test/library.test.mjs` 对 `js/data/lots.js` 的 24 行**从序列化后的 spec** 重解，
  逐行要求 `par`、`routes`、`explored` 三个数都等于印着的那三个，且 `truncated === false`。
  手改一个数字，这一条与 `tools/bake.mjs` 的复验各自会红一次。

`layerSearch` 自己也踩过一次坑，值得留在这里：第一版从 `eachCargo` 的回调里 `return`，
那只是离开回调，于是它对**每一题**都报"不可解"。现在目标判定在层循环出口处做，注释写在 `:22-26`。

---

## 2. 船的法：两条口径，一条时序

`boat.rule` 是玩法口径，不是实现细节。同一副角色、同一条冲突规则，换口径可以把答案从
**11 单程**改成**永远不可解**。所以它烤进每一行数据、印在面板"船的法"那一格、
并被 `test/library.test.mjs` 双向比对（印着的 `law` ↔ spec 里的 `boat.rule`）。

`js/core/library.js:26` 的 `LAWS` 是这两句话的唯一出处：

| 口径 | 装船规则（`loadingFault` / `eachCargo` 实际实现的） | 空船 | 谁监管岸上 |
| --- | --- | --- | --- |
| `'ferry'` 艄公船 | 艄公**必须**在船上，另可载 `0..capacity-1` 名乘客；船上总人数 ≤ `capacity` | **合法**（艄公单独过河是一趟） | 艄公所站的那一岸免判 |
| `'free'` 自由船 | 没有艄公，`1..capacity` 人任意组合 | **非法**（`'empty'`） | 没有任何一岸被监管，两岸都判 |

两处必须写死、不能靠巧合：

- `js/core/river.js:123` 的 `supervised()` 在非 `'ferry'` 口径下**显式 `return false`**。
  写成"查不到艄公索引就算没监管"也能跑对，但那是靠巧合；这条线本身就是两条口径的分岔，
  它得在这份文件里活着，别人才改得动。
- 校验器要求 `'ferry'` 关卡恰好一个艄公且**他的 id 必须是 0**，`'free'` 关卡一个都不许有
  （`js/core/river.js:351-352`）。理由：`make.js` 的变异算子会增删角色并重排 id，
  位置化的 id 是它们能保持自洽的唯一前提。

### 2.1 装船判据（`loadingFault`，`js/core/river.js:195`）

返回值是 `null`（合法）或一个故障名，四个名字各有对应正/负例：

| 故障 | 条件（按代码里的判定顺序） | 说明 |
| --- | --- | --- |
| `'far'` | `cargo & ~here` 非空 | 有人在船不在的那一岸 |
| `'over'` | `countBits(cargo) > capacity` | **超的是总人数**，艄公算一个人（`'ferry'` 口径下容量 2 = 艄公 + 1 乘客） |
| `'ferry'` | 口径是 `'ferry'` 且艄公不在船上 | 光装乘客不开船 |
| `'empty'` | 口径是 `'free'` 且船上 0 人 | 空船不许开 |

注意判序：载法先于岸上冲突判（超载的船说 `'over'` 而不是顺手报一个冲突），
这是 `test/river.test.mjs:121` "moment 4, the loading is judged before the banks" 的内容。

### 2.2 合法性的四个时刻（`cross()`，`js/core/river.js:256`）

`cross()` 先验载法，再算出**船离开之后**的状态，然后对**新状态**的两岸各判一次：
`stateConflict()` 遍历两岸，跳过 `supervised()` 为真的那一岸。于是四个时刻都要有正反例：

| 时刻 | 情形 | 结果 | 钉（`test/river.test.mjs` / `test/anchors.test.mjs`） |
| --- | --- | --- | --- |
| 1 | 船离开的那一岸在新状态下没有艄公且留着一条冲突边 | 拒绝，`where = 'departure'`，报出是哪两个角色 | `:80` "moment 1, departure bank"；`anchors:205` 教学性拒绝（`conflict.roles = [2, 3]`） |
| 1' | 同样的趟但带走的是羊不是菜 | 通过 | `:89` "moment 1, positive control" |
| 2 | `'ferry'` 口径下到达岸留下艄公 | 免判，一对冲突角色可以一起上岸 | `:96` "moment 2, arrival bank under the ferry law" |
| 3 | `'free'` 口径下同一个落地 | 拒绝（没人监管到达岸） | `:107` "moment 3, arrival bank under the free law" |
| 4 | 载法本身就不合法（超载 / 没艄公 / 空船） | 先报载法故障，不判岸 | `:121` "moment 4" |
| 补 | `'free'` 口径下离开岸同样按无人监管判 | 拒绝 | `:133` |

**这一节为什么值一整节篇幅**：写这份规格的初稿把"船怎么开"当成一条实现细节（写成"空船不许走"），
实测之下那个口径直接把狼羊菜判成不可解 —— 因为经典解的第 2、4、6 步就是**艄公独自把船划回来**。
`test/anchors.test.mjs:161` "step 2 and step 6 of 狼羊菜 are the boatman crossing alone (a first draft banned this)"
是把这条教训钉成断言的地方：`loadingFault(comp, 0b1111, LEFT, 1 << 0) === null`，
并且在经典路线真正使用它的那个位置（`mask = 0b1010`、船在右岸）`cross()` 必须放行。
同时它反向钉一次：同样的"单人船"在 `'free'` 口径下是 `'empty'`。

### 2.3 冲突判据

- `pair`：某岸同时留着一条边的两端就出事（`js/core/river.js:134`）。生成器限制**每个角色度数 ≤ 3**，
  并且这条限制**按角色数而不是按边数**判 —— `test/river.test.mjs:332` 用"四角色六条边仍合法"钉住这个区别。
- `majority`：某岸上强类**严格**多过弱类，且弱类 ≥ 1（`js/core/river.js:154`）。
  一岸全是野人是"无聊"不是"致命"，这条被 `:60` "majority is strict, and a bank of nothing but 野人 is dull rather than fatal" 钉住。
  数量型冲突只能在 `'free'` 口径下表达"人人会划船"的 M&C 原题，所以两条口径 × 两个家族都得进生成器
  （`js/core/data` 的实测分布见 README 的难度带表：迷津档 6 关里 5 关 pair、1 关 majority）。

### 2.4 终点判定

`solvedState(comp, mask, bank) = mask === 0 && bank === RIGHT`（`js/core/river.js:285`）。
第二个条件是必要的而不是冗余：`'ferry'` 口径下艄公是角色之一，所以全员右岸自动蕴含船在右岸；
**`'free'` 口径下不蕴含**（最后一个人被送过去、艄公位置空着把船留在左岸，是可能的中间形状）。
`test/river.test.mjs:270` "solvedState wants everyone off the left bank *and* the boat with them" 各给一正一负。

---

## 3. 难度带的数字来自哪一次实测

**一次烘焙**：`node tools/bake.mjs`（本次会话实跑，输出原样贴在下面，它同时重写
`js/data/lots.js`，产物与仓里那一行行 diff 为**逐字节相同**，md5 `caaf916210af2a3e828c07c52317a303`）。

```
shoal      收 6 题  seeds 40 → levels 40 (100%) · unique 9 (23%)  · 变异接受 10/10     (100.0%)
           弃因 无提升 0 不可解 0 超带 0 人数不合 4 低于带 0 同数平移 2 · 0.0s
           选中 par 1,1,3,3,3,3 · 船口径 艄公,自由,艄公,艄公,艄公,自由
ford       收 6 题  seeds 40 → levels 40 (100%) · unique 20 (50%) · 变异接受 68/4563   (1.5%)   · 0.2s
           弃因 无提升 3483 不可解 357 超带 655 人数不合 7 低于带 5 同数平移 37
           选中 par 5,5,5,5,7,7 · 船口径 艄公,艄公,艄公,自由,艄公,自由
rapids     收 6 题  seeds 40 → levels 40 (100%) · unique 16 (40%) · 变异接受 194/25146 (0.8%)   · 2.1s
           弃因 无提升 20068 不可解 4287 超带 597 人数不合 8 低于带 40 同数平移 85
           选中 par 9,9,9,9,11,11 · 船口径 艄公,艄公,艄公,艄公,艄公,自由
labyrinth  收 6 题  seeds 40 → levels 40 (100%) · unique 29 (73%) · 变异接受 339/41452 (0.8%)   · 9.3s
           弃因 无提升 27287 不可解 13826 人数不合 33 低于带 25 同数平移 93 · 超带 0
           选中 par 13,13,15,15,15,15 · 船口径 全部艄公
最慢一题 1126 ms · 最大搜索 212 态（2^(n+1) 之中）
写入 24 题 -> js/data/lots.js
```

**这一段是哪一次实测**：上面贴的是本会话第一次烘焙（17:4x）。验收前又跑了两次同一条命令：
结构性数字**逐位相同**（`seeds 40 → levels 40`、`unique 9 / 20 / 16 / 29`、变异接受
10/10 · 68/4563 · 194/25146 · 339/41452、直方图八格、`写入 24 题`），产物 md5 三次都是
`caaf916210af2a3e828c07c52317a303`（与仓里那一版 `diff` 为空 ⇒ 烘焙跨进程可复现，见 §3 开头那句）。
**只有耗时列在漂**：`最慢一题` 三次分别是 1126 / 1110 / 2414 ms，labyrinth 档 9.3 / 9.2 s。
所以这张表里能被引用的是带、接受率、状态数；毫秒不是，引用前先重跑 `node tools/bake.mjs`。

三个只有量才知道的事实，都进了文档与断言：

1. **par 只能是奇数**（`1,3,5,7,9,11,13,15`）。船从左岸出发、终点要求船停在右岸，
   于是任何解的单程数都是奇数。这条把难度带**唯一地**约束成 `1-3 / 5-7 / 9-11 / 13-15`；
   写成 `1-4 / 5-8` 那种"看起来等宽"的带，偶数那一半格子永远是空的。
   钉：`test/make.test.mjs:57` 断言每一个生成的 lot 满足 `par % 2 === 1`。
2. **迷津档一关自由船都没有**。labyrinth 那行 `选中 ... 船口径 全部艄公` 是烘焙的实际结果，
   `TIERS_META` 里 `free: 0` 印的就是它，`js/data/lots.js:7`。
   这一格没有为了"每档都要两种船"而被手工凑出来 —— 凑出来的做法是让 `make.js` 生成一个
   实际落不进带的题，那是把测量换成意见。
3. **par 直方图只有两个取值**（每档 `min` 与 `min+2`）。带内的"目标梯级"由 `ladderOf()` 取带里的奇数，
   增长一到达标就停，所以 1/3、5/7、9/11、13/15 各自成对。想要四档里出现 6 个不同的数，
   就得改停止条件，那不是测量结果的错。

### 3.1 `TIERS` 与 `TIERS_META`：两个数不能混

- `js/core/make.js:430` 的 `TIERS` 是**生成包络**（带里允许哪些 par、允许几个角色、搜索预算多少）。
- `js/data/lots.js:7` 的 `TIERS_META` 是**已入库的行实际落成的 min/max/两种船各几关**，由
  `tools/bake.mjs:191` 从 `out` 里量出来。屏幕上、README 表里、`library.stats()` 里印的都是后者。

这两格在别的仓被抄错过，所以钉在两个地方：`test/library.test.mjs` "every band shows both boat laws
where the data claims it does"（要求 `b.parMin === t.min && b.parMax === t.max`、
`b.n === t.free + t.ferry`）与 "the four bands do not overlap and the campaign walks them in measured order"。

### 3.2 排序也是一种口径

战役顺序 = 档从低到高、档内 `par` 升序、`par` 相同再按 `explored`（可通行局面）升序
（`tools/bake.mjs:150`）。`test/library.test.mjs` 断言同档内 `previous.par <= lot.par` 且 `order` 连续。
第二维不是装饰：`ford-01`/`ford-02` 都是 5 单程、40 个可通行局面、`rapids-04` 是 9 单程但 64 个局面 ——
"7 步穿过 40 个态"是练习，"7 步穿过 400 个态"才是谜题，这句话在 `js/core/solve.js:111` 的注释里，
而 `states` 这一列就是它的量。

### 3.3 生成实测的第二份量具

`node test/balance.mjs`（本次实跑，每档 60 颗种子、墙钟 90 s 上限）：

```
shoal      出题率 100.0%  变异接受 58.3%  同数平移 0    判不可解 0      中位 0 ms    最慢 8 ms     唯一题面 8/60
ford       出题率 100.0%  变异接受  1.6%  同数平移 51   判不可解 191    中位 0 ms    最慢 47 ms    唯一题面 32/60
rapids     出题率 100.0%  变异接受  1.0%  同数平移 80   判不可解 3852   中位 1 ms    最慢 422 ms   唯一题面 33/60
labyrinth  出题率 100.0%  变异接受  0.7%  同数平移 139  判不可解 24369  中位 123 ms  最慢 1812 ms  唯一题面 36/60

撒点生成器（scatter，已被替换的那个）
labyrinth: probed 3521 个随机题面 · 落进 13-15 带 40 (1.14%) · 不可解 1265 · 可解率 62.3% · 低于带 2153
（这一行来自另一次定点测量：40 次 scatter("probe4000-<s>", labyrinth)）
```

**与代码注释里旧数字不符的地方，诚实登记**（本任务禁止改代码文件，所以只写在这里并在 deliverable.md 复述）：
`js/core/make.js:9-16` 与 `tools/bake.mjs:4-9` 引用的 "约 46% 随机题面可解"、
"4000 个样本里顶档只回来 17 个（0.4%）"、"60 颗种子只有 14 个不同题面"这三组数字
在本次实测下分别是 **62.3% / 1.14%（40/3521）/ 36 个不同 signature（60 颗种子）**。
量级不同是因为它们测的是**加入同数平移（lateral）之前**的严格递增版生成器；
定性结论没变，而且变强了：撒点仍然填不满顶档（1.14%），所以生成必须放构建期。
**引用这些注释里的数字之前，先重跑上面两条命令。**

---

## 4. 出题：为什么是变异阶梯而不是撒点

`js/core/make.js` 的 `grow()` 从一副**答案已知的经典题面**出发（`SEEDS`，28 个种子，
包括那些搜索判定不可解的种子——`seedPool()` 会把它们量出去，顶档的种子筛选因此是实测而非字面量），
然后反复做一次随机变异，**每变一次就重新 BFS**，只留下"搜索认为变难了（par 上升）且还没超过目标"的那些：

| 算子 | 做什么 | 为什么必须有它 |
| --- | --- | --- |
| `opEdge` | 加/删一条冲突边（度数上限 3） | 改变"谁不能单独留下"，这是唯一的结构性难度来源 |
| `opRole` | 加/删一个**没有被任何冲突提到**的角色 | 实测：容量 2 口径下每加一个闲人恰好多 2 个单程 —— 顶档就是靠它爬上去的 |
| `opClass` | majority 家族一次加/减一教一野 | 单加一类会当场把起始岸判成冲突，整棵树直接死 |
| `opCap` | 船容量 ±1 | 见下面的边界 |
| `opLaw` | 同一副角色在 `'ferry'`/`'free'` 之间切换 | **本仓存在的意义**：答案可以从 11 单程变成不可解 |

四条边界都是实测换来的，不是审美：

- **`'ferry'` 容量 1 永不出现**：`opCap` 的下界写死 `Math.max(2, tier.caps[0])`。
  容量 1 的艄公船 = 艄公独自来回，永远运不走乘客（`js/core/make.js:238` 记的是 342 个撒点样本里 0 个可解）。
- **`'free'` 容量上界 4**：4+4 一次装完的那不是变难，是不再是谜题。
- **同数平移（lateral）有配额**：严格要求 par 递增会把一个档收敛到两三种"标准形状"
  （注释里的旧测量：40 颗种子 9 个不同题面）。本次实测允许 lateral 后是
  shoal 9/40、ford 20/40、rapids 16/40、labyrinth 29/40 个不同 signature。
  放行的那些步**不改变印着的数字**（发布的是最后量到的 par），只改变形状；
  配额 `tier.lateral` 与 0.5 概率两道闸都在 `grow()` 里。
- **两颗停止闸**：`tier.probes`（次数）与 `tier.budget`（墙钟毫秒），弃因分别计数并在 bake 里打印。
  `test/make.test.mjs:87` "the grower stops: bounded probes, bounded budget, and it says which bound it hit"
  与 `:122` "a mutation ladder that cannot be fed produces null instead of a lie"（要求
  `min: 41, max: 41` 这种带必须返回 null，而不是就近交一个别的东西）。

`scatter()`（同文件 `:375`）是被替换掉的撒点生成器，**故意留着且不接线**：
它是 §3.3 那个 1.14% 的唯一来源，`test/make.test.mjs:100` 拿它做诚实性断言（上界 `rate < 0.5`
放得松是为了"种子串将来重哈希也不会把 CI 弄红"，而不是为了让它容易过）。

确定性：`makeLot(seed, tier)` 对同一 seed 产出逐字段相同的题面，
`test/make.test.mjs:27` 与 `:73` 各钉一次（后者还要求带 `stats` 对象的运行与不带的一次跑出同一个 par，
即计数器不许影响搜索）。

---

## 5. 确定性：`hashSeed` 是 FNV-1a **派生**的两轮混合，不是教科书 FNV-1a

`js/core/rng.js:4` 的 `hashSeed(str)` 对每个 UTF-16 code unit 做**两次**异或+乘：

```js
h ^= str.charCodeAt(i) & 0xff;   h = Math.imul(h, 0x01000193);   // 低字节，乘一次
h ^= (str.charCodeAt(i) >> 8) & 0xff; h = Math.imul(h, 0x01000193); // 高字节，再乘一次
return h >>> 0;
```

它借了 FNV-1a 的偏移量 `0x811c9dc5` 与素数 `0x01000193`，但**不是**那个算法，
所以对 ASCII 种子**不等于**公开向量：

```bash
node -e 'import("./js/core/rng.js").then(m=>console.log(m.hashSeed("a")))'   # 723832900
# 教科书 FNV-1a("a") = 3826002220 —— 这两个数不相等，是预期的，不是 bug
```

维护者要守的是两条，而不是一条：

1. **不要把它改名或标注成 "FNV-1a"**，更不要拿公开向量当"应等于"的期望值写进测试 ——
   那会红，而且红的是测试而不是实现。本仓现有的 hashSeed 断言都是**自洽**的：
   `test/library.test.mjs:109`（`hashSeed('daily|<day>') % 24` 必须等于实际选中的行号）、
   `test/make.test.mjs:36`（不同种子不许相等）。契约 §1 要求的
   "同种子两次调用相等 / `>>>0` 落在 32 位内"这两条**目前没有被单独写成断言**（见 deliverable.md 未实现清单），
   但由 `test/library.test.mjs` 的"同一日期连调两次必须给同一个 id"间接钉住了稳定性。
2. **不要换种子哈希的实现**。`mulberry32(hashSeed(seed))` 是全仓确定性的根：
   `js/core/make.js` 的每一颗生成种子、`#/daily` 的日期、`#/random/<档>/<token>` 的 token 都过它。
   换掉它的同一天，`js/data/lots.js` 必须重新烘焙，并且所有已分享出去的 `#/random/...` 链接会指向另一条河。

前端把算术印在屏幕上正是为了这条能被外部检查：`js/main.js:78` 的 `seedNote` 直接给出
`hashSeed("daily|2026-09-27") = 2210448354 · 2210448354 % 24 = 18`（→ `labyrinth-01`），
用户在控制台里就能复算。裸 `#/random/<档>` 不写 token 就会每次访问不同，
所以 `js/main.js:348` 一旦 mint 出 token 就 `location.replace` 写回地址栏（`@routes` 有断言）。

---

## 6. 三层不许互相串

| 层 | 文件 | 可以知道 | 不许知道 |
| --- | --- | --- | --- |
| 模型 | `js/core/river.js`、`solve.js`、`game.js` | 位掩码、两条口径、BFS、计数 | `window`、`document`、canvas |
| 画面 | `js/view.js` | 像素、指针坐标、动画位移 | 任何合法性判断（只**问** `boardFault` / `standing`） |
| 外壳 | `js/main.js` | 路由、DOM、存档写入、`window.ferry` | 规则细节（不自己判船能不能开） |

`grep -rn "window\.\|document\." js/core/` 只应该命中 `js/core/storage.js` 的守卫式访问
（`:30` 的 `typeof window !== 'undefined'` 与 `:37/:64` 的 `window.localStorage`，三处都包在 try/catch 里）。
core 里一旦出现 DOM，`node --test` 那一层直接瘫掉 —— 而那一层是本仓全部主张所在。

`js/core/game.js` 把两件事分开，这是 §2 那些判据能落到手指上的前提：

- **状态** `(bank, mask)` 只在船真的过河时变，而玩家站过的每个状态都是无冲突的（`depart()` 拒出一切会造出冲突的趟）；
- **载法**（谁站在船上等着走）随时可改，装/卸**一律不计单程**，只按可达性与容量判。

于是"一次拖 = 一次装船，不计数"和"点船 = 一次单程，计一步"是模型性质而不是 UI 约定。
`test/game.test.mjs:25` "boarding is free: three failed attempts and two loadings still bill nothing"
与 `:136` "the certified route of every baked lot replays through board+depart, one move per trip"（24 关全走）
把这两句钉住。

存档的三条单调性是产品语义（`js/core/storage.js`）：`best` 只会变小、`unlocked` 只会变大、
`perfect` 的定义是 `moves <= par && !(hints > 0)` 且一旦获得就粘住 ——
**"用提示打平 par"不算完美**，因为"匹配了搜索出的最少单程"是关于玩家的声称，不是关于提示的。
清档是全仓唯一破坏性操作，`reset()` 连内存缓存一起换掉（留陈旧缓存比不清档更糟）。
`localStorage` 是**抛异常**而不是返回 null，所以 `load()`/`persist()` 全都包在 try/catch 里，
`test/storage.test.mjs` 有 13 条断言（含 corrupt payload 修复、DOM 侧落盘、清档后再用）。

---

## 7. 画面与手势：三种，且一对一映射到模型

`js/view.js` 只把三种手势翻译成对 core 的**一次**请求，计数权永远在 `depart()`：

| 手势 | 落到 | 计数 |
| --- | --- | --- |
| 角色拖到船上 / 拖回岸上 | `onBoard(id)` / `onUnboard(id)` | 不计 |
| 点船身（按压位移 ≤ `TAP_SLOP = 6` px） | `onDepart()` | 计 1 单程 |
| 把船拖向对岸（`|dx| > 0.45 × 两码头间距` 且方向正确） | `onDepart()` | 计 1 单程 |

两处非显然的实现：

- **`TAP_SLOP`**：浏览器在 pointerdown/pointerup 之间常给一两像素抖动，"点船开船"不能因为抖动就变成
  "什么也没发生"；反过来，一次半途而废的拖船**不许**成行 —— 船回原位、没人上船（`js/view.js:611-623`，
  `@pointer` 有对应断言：把船拖到 20% 距离不动、拖到对岸恰好计 1 单程并获胜）。
- **命中半径由页面自己公布**（`reach()`，`js/view.js:737`）。台架要断言"点空白处什么都没发生"，
  就必须先证明那个坐标离所有角色的命中盒都够远 —— 否则这条断言会因为**错误的原因**成立
  （那个坐标根本没落进画布）。

被拒的操作画成"船身或角色抖一下 + 相关角色红一下"，计数不动；拒因文案由 `js/main.js:112` 的
`faultText()` 从 core 返回的 `why` / `conflict` 生成，shell 不重写第二套判定。
冲突高亮的是**core 报的那两个角色**（`conflict.roles`），不是视图自己配的。

画布上下文**没有**开 `willReadFrequently`（`js/view.js:82`）。理由：像素回读只发生在**台架侧**
（`tools/playtest.mjs:457` 采样 alpha 证明"河真的被画出来了"），shipped 代码不读像素，
给游戏自己的绘制路径开这个标志是拿性能换一条不会踩门的 warning；
`tools/verify.sh:138` 的 console 门只拦 `[EXCEPTION]`。这一条与九连环/Gridlock 的做法**不同**，
是有意选择而不是遗漏；若将来要在页面里读像素，就同时把 `willReadFrequently` 与 console 门一起改。

### 7.1 两条被几何咬掉的断言（2026-09-27 实修，因果记在这里）

`@pointer` 曾有两真失败："pressing the open water in place does nothing" 与
"a haul that stops short of the far bank casts nobody off"。**两条断言写的都是规格 §4 的口径，
错的是 `layout()` 交出来的几何**。修前/修后都在 1280×820 窗口（画布 886×610、水带宽 570、
pitch 46、命中半径 `max(11, pitch*0.5)` = 23）里用 `window.ferry` 的钩子量过：

| 量 | 修前 | 修后 |
| --- | --- | --- |
| 船体宽 `boatW` | 562（≈整条河） | 214 |
| 两码头中心距 `dock[1]-dock[0]` | **2 px** | 350 px |
| 彼岸角色列的画布 x | 443（航道正中，压在船底下） | 799（彼岸沙地上） |

1. **座位宽度被定义成"河面的一个份额"**：`slot = max(pitch*0.8, floor((waterW-30)/capacity))`
   ⇒ 船体永远等于水宽。后果两条：渡河补间在 2 px 上滑行（画面看不出船动过）；更要紧的是
   `far` 的判据是 `|dx| > 0.45 × 两码头间距` = **0.9 px**，于是任何一次 1 px 的拖动都算"拖到对岸"。
   台架要的"拖到 20% 距离"在这种几何下就是 `round(2×0.2)` = 0..1 px ⇒ 半途而废的拉船被结算成靠岸；
   而 `shoal-01` 的 par 恰好是 1，所以"过拉"一步直接判完成（`done/curtain/busy` 全 true，`boat` 被
   `depart()` 清空）。规格 §4 写的是"点船（**或拖船到对岸**）= 一次渡河"——没到对岸就不属于那个手势：
   船回原位、一个人也不上岸。现在座位宽度跟着**角色尺寸**走（`min((waterW-30)/capacity, pitch*1.4)` 取整），
   船体另外封顶在水宽的 60%，两码头之间必然剩下至少 40% 河面 = 真实行程（`js/view.js:124-131`）。
2. **右岸的角色网格以水带为中心**：`bankBox[1] = { x: waterX0, w: waterW }` ⇒ 已过河的人站在航道正中、
   船体底下（截图里直接看得见），而这一列的中心 x 恰好等于画布中心。台架取"空白水面"用的是
   `(画布中心 x, 12% 高度)`，那个点离艄公的圆只有 8 px，落在 23 px 命中半径内 ⇒ `down()` 把它认成
   "按在角色上"，`up()` 的 `!wasAboard && !moved` 分支于是**合法地**把艄公装上了船。这条失败打印出来是
   `{"wBefore":1,"wAfter":1}` 却判 FAIL，因为 detail 只印 `trips`，而真的动了的是 `boat.length`。
   现在右岸列以**右岸沙地**为中心（`js/view.js:135-142`，与命中用的 `bankRect` 同一条线），并且台架在
   按下之前先用页面自己公布的 `reach()` 证明那个坐标既不在船体矩形内也不在任何角色的命中半径内
   （`tools/playtest.mjs:353-371`，多出来的那条 `the point about to be pressed really is open water`）。
   **没有放宽任何期望**：两条原断言原文保留，另加两条前提断言（`:368`、`:400`），`@pointer` 从 38 条变 40 条。

同一类"画面与状态各说各话"的还有第三格：`frame()` 过去只在动画仍挂着时重绘，于是补间结束的**那一帧没人画**
—— 河面冻结在"人还在船上"的最后一帧，而旁边面板写着"已在船 0/3"。现在动画集合变空时补画最后一帧
（`js/view.js:483-493`）。这三格全在 view（像素与手势归它），**`js/core/*` 一条规则都没改**，
`node --test` 前后都是 95 条、fail 0。

**第四格只有重跑才会露出来**：`busy()` 说"补间结束了"用的是
`performance.now() >= glide.until`，而 `roleAt()` 说"这个人还在船上"用的是**裸 `glide` 对象** ——
后者要等下一次 rAF 才被置空。于是 `settle()`（等 `busy`）之后立刻问 `rolePoint(i)`，有大约一帧的
窗口拿到的是"船上的座位"，而真正按下时人已经回到岸上 ⇒ 那一按谁也没命中，装船**静默失败**，
后面整条认证路线一起崩（`@pointer` 曾以 1/2 的概率报 6 条失败，detail 长这样：
`{"before":[],"after":[],"trips":2}`）。规矩因此是：**位置类查询与 `busy()` 必须共用同一条时钟判据**
（现在都走 `glideNow()`，`js/view.js:182-189`）；只有绘制路径可以继续读裸 `glide`，因为那一帧本来就该画船。
台架没有为此加 `sleep`，断言也没有放宽。

---

## 8. 验证台架

### 8.1 为什么是 CDP 而不是 Playwright

`package.json` 的 `dependencies` 与 `devDependencies` 都是 `{}`，这是刻意的：这仓要进 Pages CI，
多一个依赖就多一条供应链。Node 21+ 自带全局 `fetch` 与 `WebSocket`，`tools/playtest.mjs`
用它们直讲 CDP（`open|nav|eval|shot|logs` + Node 侧的 pointer 场景）就够覆盖注入、真实输入、截图、抓 console。

### 8.2 `@pointer` 为什么必须存在

页面内注入的断言能证明 `board()/depart()` 对，**证明不了手指点得着船**。`@pointer` 场景
（`tools/playtest.mjs:171`）跑在 Node 侧：坐标来自页面里的 `window.ferry.rolePoint(i)` / `boatPoint()`，
事件是真的 `Input.dispatchMouseEvent` 按下/移动/放开。它断言的是四条口径各自的正反例：

- `shoal-03`（艄公船，par 3）整条认证路线用**真实拖拽**走完，通关卡片在 par 上给出 ★★★，纪录落在 par 且 `perfect`；
- `shoal-04`（容量 3）里第四个角色被真实拖拽拒上船，船位仍 3、计数 0、`fault.why === 'over'`；
  把船上的人拖回岸上是卸船、同样不计单程；对岸的角色拖不进船、不计单程；
- `shoal-02`（**自由船**）空船按压被拒且 `empty`，计数不动；
- `shoal-01`（**艄公船**）里把船拖到对岸恰好计 1 单程并获胜；半途（约 20% 距离）放开则船回原位、不计步。

这两条"两种口径的行为差异各有一条断言"是规格 §4 要求的，本仓确实各有其一。

### 8.3 导航之后等的是 shell，不是秒表

`Page.navigate` 之后调 `waitShell()`（`tools/playtest.mjs:99`）轮询 `window.ferry` 的状态，
`tools/verify.sh` 也一样：先轮 `/json/version` **和** web 根目录（而且 grep 的是
`id="lot"` 这**一段内容**，不是状态码 —— 一个正在服务别的仓的端口不该被当成"就绪"），
再轮 boot 关卡 id；取每段结果用**花括号计数**从 console 里截 JSON（headless 会在同一行后面追加文本，
`JSON.parse(整行)` 是随机失败）。固定 sleep 在 localhost 够用、打线上就是假故障（canvas 停在 300×150）。

`tools/verify.sh` 里另外三条容易被删掉的保护，都别动：

1. `CDP_PORT` 已被占用时**直接 `exit 6`**，而不是换端口继续（`:32-35`）——
   连到别人的 DevTools 或别人的 index.html 会产出自信的错误结论。
2. `trap cleanup EXIT` 里对 Chrome、静态服务器**和看门狗**都 `kill` + `wait`（`:43-53`、`:143`），
   并且用 `pgrep -f "user-data-dir=$UDD"` 检查残留；看门狗那一路还显式
   `</dev/null >/dev/null`，否则它继承了 stdout，跑在管道里会把写端一直攥到超时。
3. 不要加 `--use-gl=angle --use-angle=swiftshader` 之类软件光栅 flag（`:6-8` 的注释）：
   这游戏是 2D canvas，加了反而会把 CPU 打满且进程不自退。

### 8.4 不暂停 `visibilitychange`

headless Chrome 把自己报成 hidden。渡河的滑行动画、抖动与胜利卡片由同一个 rAF 循环驱动，
一暂停测试就永远看不到通关，所以 `js/main.js:466` 显式不接这个事件（注释就地说明）。

---

## 9. 刻意不做的东西

- **不做多船、不做"夜里要手电筒"式的变体规则、不做水流/时间推移**。它们都会改变"最少单程"的定义，
  而本仓每个数字的意义就是那个定义（规格 §7）。
- **不做浏览器内的"重烤池子"**：`tools/bake.mjs` 与 `js/core/make.js` 是构建期工具，shipped 代码不 import 它们。
- **不做成就 / 排行榜 / 签到 / 云存档 / 分享战绩**（组织 E 组禁令）。分享只有 `#/lot/<id>` 与
  `#/random/<档>/<token>`，分享的是谜题本身，不含分数。
- **不做"按人数判可解性"的快捷分支**，即使它总是对（见 §1.2）。
- **无图片 / 音频 / 字体 / 打包器 / npm 依赖**：河、岸、船、角色全部由 `js/view.js` 程序绘制，二进制资产 0 个。
- **不加容量 1 的艄公船、不加容量 > 4 的自由船**（§4 的两条实测边界）。

## 10. 实测出的边界

- **角色数上界是 12（`MAX_ROLES`），生成的关卡只到 8**。8 角色 = 512 个态，提示搜索实测最多探索 212 态；
  12 角色 = 8192 个态，`solve` 的四张表（`Int16` 距离 + `Int32` 父节点 + `Int32` 载货 + 队列）
  约 8192 × 14 字节 ≈ 115 KB，一次遍历 1 ms 量级（本次实测 M&C 6+6 的 423 态 1 ms）。
  再往上就是"提示要搜几十万态"，那属于构建期，`par` 也要开始依赖 `limit` —— 而 `limit` 一参与，
  本仓每一句"量出来的"都得改写成"估出来的"。
- **`routes`（最短路线条数）用 `Float64Array` 累加**。M&C 3+3 自由船实测 8100 条；
  放宽到容量 3 的 4+4 实测 329472 条，仍远在 `2^53` 之内。这条要写下来，因为它是"会溢出"的那一类隐患，
  而本仓现在没踩到它。
- **计时数字不逐位可复现，结构数字才复现**。本次会话把仓复制到 `/tmp` 后重跑 `node tools/bake.mjs`，
  写出的 `lots.js` 与仓里那一版（由建造者那次烘焙写入）**diff 为空**、md5 相同（见 §3），
  但耗时行（0.0/0.2/2.1/9.3 s、最慢 1126 ms）随机器负载浮动；
  `js/core/make.js:9-16` 与 `tools/bake.mjs:4-9` 注释里的旧数字与本次实测的差（0.4% vs 1.14%、
  46% vs 62.3%）就是这一类漂移，见 §3.3。
- **玩家可以把可解的关卡走进无解局面**。烘焙保证起点有解、每一步拒绝制造冲突的趟，
  但"每步都合法"不蕴含"仍可解完"。此时 `hint()` 返回 `null`、`depart()` 用 `already` 挡住继续开船，
  UI 没有任何补偿（没有自动撤销、没有"这题已经死了"的弹窗）。这是接受的边界，不是 bug。
