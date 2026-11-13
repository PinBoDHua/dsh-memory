# 迭代协议与待办 Iteration protocol & backlog

本文件是 dsh-memory 的「自迭代」工作台账：每轮增量、验证口径与后续 backlog 都记录在此，跨会话可续。
This file is the self-iteration ledger for dsh-memory: per-round increments, verification, and the running backlog.

## 每轮流程 Round loop

1. **基线**：`node --test tests/*.test.mjs` 全绿；对运行中的 GUI 跑 `node scripts/live-check.mjs --port=<GUI端口>`；必要时 `node scripts/gui-check.mjs --url=http://127.0.0.1:<GUI端口>/`。
2. **选增量**：从下方 backlog 取价值最高且可一轮交付、可验证的一项（或一组同类小修）；一次只做一个主题，避免不可审阅的大杂烩。
3. **TDD**：先写失败测试（纯函数优先：store/service/客户端纯逻辑都有独立测试边界），再最小改动。
4. **版本与文档**：`package.json` 升版本（修复=patch，功能/行为新增=minor）；`CHANGELOG.md` 同步（Keep a Changelog）；`docs/DETAIL.md` 的功能/工具/限制随行为同步。
5. **重载宿主**：host 端改动必须 `plugin_manager remove_bundle(dsh-memory)` → `install_bundle(target=D:\Questions\dsh-memory)`（HMR 不会重载链接插件的宿主代码）；纯 `client/client.js` 改动由分发 rev 自动生效，无需重载。
6. **三段验证**：
   - 单元：`node --test tests/*.test.mjs`（含新增回归测试）；
   - live：`node scripts/live-check.mjs --port=<GUI端口>`（回环 API 端到端＋客户端 bundle rev 分发断言）；
   - GUI（涉及面板/键盘/交互时必做）：`node scripts/gui-check.mjs --url=...`（Edge headless + CDP，自签登录 cookie；覆盖真实请求参数与键盘行为）。
7. **提交**：`git add -A` → 单条 `fix|feat: vX.Y.Z — …（N tests, M live checks[, K GUI checks]）` → 经系统代理推送：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push`（仓库身份 PinBoDHua）。
8. **记录**：把本轮结论/新发现补进本文件 backlog；若 backlog 空，做一次新的双端审计（宿主 `index.js` + `lib/*`；客户端 `client/client.js`）再选题。

## 验证脚本 Verification scripts

| 脚本 | 覆盖 | 说明 |
|---|---|---|
| `tests/*.test.mjs` | 纯逻辑/服务/路由/存储/锁/设置/守卫/客户端纯函数 | `node --test tests/*.test.mjs` |
| `scripts/live-check.mjs` | 运行中宿主回环 API 全链路＋客户端 bundle rev | `--port=` 或 `DSH_MEMORY_PORT`；测试条目/设置/备份自动恢复，`--fail-at=<子串>` 失败注入验证异常清理，运行前后数据根快照 diff=0 自检 |
| `scripts/gui-check.mjs` | 真实浏览器面板：过滤请求参数、下拉键盘、弹窗 Esc 草稿 | `--url=`；Edge headless + CDP（端口默认随机，可用 `--cdp-port=` 固定）；cookie 由 `<DSH_HOME>/.credentials.yaml` 自签；临时记忆清理，设置/备份用例前后快照恢复，运行前后数据根快照 diff=0 自检；中断安全（清理注册表 + SIGINT/SIGTERM/异常统一 abort；`--abort-after=<ms>` 注入验证） |
| `scripts/data-snapshot.mjs` | live/gui 共用的数据根快照/差异纯函数 | 条目内容 sha256、backups 内容 sha256、settings/meta；junk 清单（`.tmp-*`、`.lock-*`、非预期文件）；刻意排除 access.json/index.json 与派生 `.cache/`；`tests/data-snapshot.test.mjs` 覆盖 |
| `scripts/verify-lock.mjs` | 验证脚本互斥锁 | 数据根 `.lock-verify`（data-snapshot 忽略其存在）；并发第二个脚本码 `busy` 快速退出；陈旧锁按 mtime 自愈、owner 死 PID 立即自愈；`tests/verify-lock.test.mjs` 覆盖 |
| `scripts/watchdog.mjs` | live/gui 强杀看门狗 | 父进程启动时写清理 manifest（root/测试标记/settings 原始内容/backups 基线），detached 子进程每 1.5s 检查父存活；被 taskkill/CI 超时杀死后自动删测试条目、恢复 settings、删除新增备份与残留锁；正常结束由 cleanup 注册表停掉；`tests/watchdog.test.mjs` 覆盖，真实 `taskkill /F` 实测通过 |
| `scripts/bench.mjs` | 大库性能基准 | `--entries=30000 [--dir=<临时根>] [--regen] [--force]`；默认复用已存在数据根，只有带 `.bench-root` marker 或目录名为 `dsh-memory-bench-*` 的目录才允许 `--regen` 删除（否则拒绝，需显式 `--force`）；输出冷/热 listAll、`indexColdListMs`（从持久化索引进程冷启动）、status、export、recallPreview、search、forgetOne 毫秒数（JSON）；`tests/bench.test.mjs` 覆盖删除决策 |

环境注意：GUI 端口每次启动不同，以运行时上下文为准；PowerShell 5.1 输出中文需 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；`git push` 的 stderr 进度可能被 PS 报 NonZeroExit，需看内容判断。

## 待办 Backlog

来源：2026-11-13 双端只读审计（宿主端 12 项、客户端 12 项）。0.24.1 清掉 10 项小修；0.24.2 清掉 P1 数据一致性 6 项。以下保留未完成项。

### P1 数据一致性

- [x] **取代链不变量**（0.24.2）：禁止成环、禁止覆盖既有 `superseded_by`；`forget` 清理双向悬垂引用并恢复旧条目可见。
- [x] **`touchAccess` 旧快照整文件回写**（0.24.2）：写前重读、只合并 `last_access`/`hit_count`；`memory_search` 改为 `isConcurrencySafe: false`。（更彻底的 access 账本仍未做，见 P4 备注。）
- [x] **`parseEntry` 作用域以目录为准**（0.24.2）。
- [x] **`memory_update` 同时带 `scope`（移动）时 `supersedes` 被静默丢弃**（0.24.2）。
- [x] **导入跨作用域 id 唯一性**（0.24.2）：导入前扫描全部已占用 id。
- [x] **`export` 以目录为权威**（0.24.2）。
- [x] **`detectSecret` 只查 content**：tags 可绕过机密硬拒（0.24.6 已修复：正文＋标签统一检查）。

### P2 性能

- [x] **批量导入 O(N×M) 读放大**（0.24.3）：每个作用域一次预读建 `normalizeContent → id` 映射，批内新增/合并同步更新。
- [x] **热路径重复全量读盘**（0.24.3）：新增解析缓存（路径＋mtime/ctime/size 签名，热路径只 stat），`searchDetailed`/`stats`/系统提示装配不再整盘重复读；手工编辑与其它进程写入自动失效。

### P3 客户端健壮性

- [x] **fetch 无超时/无取消**（0.24.4）：15s `AbortSignal.timeout`；超时/网络/坏响应统一映射本地化错误并中止，不再永久骨架或 busy 卡死。
- [x] **删除失败路径**（0.24.4）：`Promise.allSettled` 逐项结算，成功后立即移除并刷新/保留撤销，失败项汇报，全部失败提示删除失败。
- [x] **撤销 toast 被后续 toast 覆盖**（0.24.4）：撤销吐司未到期时普通提示排队（最多 3 条），点击撤销先出队再恢复。
- [x] **批量选择与列表刷新同步**（0.24.4）：列表刷新后选中集合与当前页求交；选中项全失效时清空选择并提示。
- [x] **设置保存一致性**（0.24.5）：写路由 `{result}` 解包（此前保存设置必崩设置页）、夹取值回收、加载不覆盖防抖草稿、失败清除已保存态。
- [x] **标签数量/长度**（0.24.5）：客户端 `parseTags` 去重/12 上限/64 字符，并显示计数与超限提示。
- [x] **设置页加载失败永久骨架**（0.24.5）：错误 + 重试；召回预览 seq 守卫。
- [x] **WAI-ARIA Tabs 模式**（0.24.5）：tablist/tab/tabpanel 关联、roving tabIndex、方向键/Home/End。

### P4 边角

- [x] **非法 scope 回 400**（0.24.6）：`entries`/`stats`/`similar` 统一校验，service 抛 `invalid`。
- [x] **`update` 不刷新 workspaces/index.json 的 `lastSeen`**（0.24.6）。
- [x] **`workingDirectory` 在 `apply` 时一次性捕获**（0.24.6）：改为每次 `ctx.get`，晚就绪/跟随 cd 均生效，并有 fake-ctx 集成回归。
- [x] **命中语义口径对齐**（0.24.6 明确检索命中写 `last_access`/`hit_count`；0.24.7 起注入命中同样入 `access.json` 账本）。
- [x] **机密检查只查正文**（0.24.6）：正文＋标签统一硬拒。
- [x] **命中簿记迁移到独立 `access.json` 账本**（0.24.7）：`withLock` 保护＋原子写＋签名缓存；不再改写条目 Markdown（消除读-改-写窗口与写放大）；检索与系统提示注入均入账（节流 ≤1 次/小时）；旧文件命中字段兼容、坏账本自愈。

### 第二轮双端审计 backlog（2026-11-13，基于 0.24.7）

0.24.8 已清掉条目健壮性 5 项（文件名 id 权威、BOM/CRLF、坏文件可删、账本余影、Windows tick 缓存碰撞），其余按优先级：

**P1**
- [x] **export/import 保真**（0.24.9）：导出附权威 `workspaceKey`，导入按 key 落盘——索引损坏不再拒绝、陈旧不再搬错工作区；旧导出按 cwd 兼容，merge 可按 key 合并。
- [x] **设置写入状态机**（0.24.10）：`settingsStatusNext` 纯函数统一 dirty/saving/savedOnce/error；重置使在途保存失效、saving 用 token 收敛不卡死、保存失败保留草稿并可重试、saving 时禁用重置/备份。

**P2**
- [x] 客户端消费 `revived:true`：复活保存提示「已恢复为活跃」（0.24.11）。
- [x] 导出范围与视图一致：面板按「全局＋当前工作区 / 全局 / 指定工作区」导出，全量备份仍走立即备份（0.24.11）。
- [x] 空工作区空态误报「记忆库还是空的」（0.24.11：区分筛选无结果 / 工作区为空 / 整库为空）。
- [x] 卡片操作按钮 busy 期间禁用 + 列表 aria-busy（0.24.11）。
- [x] 卡片标签点击改为精确 `tag=` 过滤（0.24.11）。
- [x] 删除/批量删除后焦点丢失、撤销吐司对键盘用户不可达（0.24.12：撤销吐司出现即聚焦动作按钮）。
- [x] 导入：BOM JSON 解析失败；读文件失败/解析失败/格式错误归因混同；读文件窗口未置 busy（0.24.12：`parseImportText` + 读窗口 busy + 三种错误分开）。
- [x] 每次列表刷新都重取 recall-preview（注入徽章失败即清空）（0.24.14：与筛选解耦、失败保留旧值、设置/写操作/工作目录变化时刷新）。
- [x] ARIA 细节：类别 radiogroup 无方向键；非激活 tab 的 `aria-controls` 指向已卸载面板；吐司关闭按钮读作「取消」（0.24.12）。
- [x] 注入装配 `selectInjection` 复用后，缓存 FIFO 在条目数 >4096 时退化（0.24.14：LRU + 8192 + 可调上限）。
- [x] `defaultView='workspace'` 晚到 cwd 不生效（0.24.14：等 cwd 解析后再应用）。
- [x] 路由收到非对象 JSON（`null`/数组/标量）→ 500 internal，应回 400（0.24.13：`readJsonBody` 只接受 JSON 对象）。
- [x] move 去重把「已被取代」条目算冲突（与 save 语义不一致）（0.24.13）。
- [x] `withLock` 大导入临界区可超 `staleMs=10s`；且不支持 async 回调（0.24.13：导入显式 30s/120s；async 回调抛错）。
- [x] 注入装配 `selectInjection` 被算两遍（0.24.13：复用选择结果）；剩余：缓存 FIFO 在条目数 >4096 时退化（可提高上限或分段淘汰）。

**待验证**
- [x] `defaultView='workspace'` 时若 `SessionSummary.cwd` 缺失且 `/cwd` 晚返回，`viewInitialized` 已置 true → 默认视图不生效（0.24.14 已修复：等 cwd 解析后再应用）。
- [ ] 撤销删除使用列表快照；若删除前条目已被 agent 更新，撤销会回滚为旧内容（已知限制；未来若引入 trash 语义再处理）。

### 第三轮双端审计 backlog（2026-11-13，基于 0.24.14）

0.24.15 已清「脚本零污染 + 备份可恢复」：gui-check 设置/备份用例前后快照恢复真实 overlay 与 backups、live-check 幂等清理＋SIGINT/异常恢复＋账本锁内清理＋版本读 package.json；写路由 body 上限 1MB→32MB、导入落盘响应不再回传全量 entries、客户端导入预检 32MB + 超时 180s；修复「恢复默认」被防抖保存在慢网络下回滚、defaultView 使用权威 /cwd 后再 ready。其余按优先级：

**P1**
- [x] 脚本彻底隔离：`--fail-at=` 失败注入 + 运行前后真实数据根快照 diff=0 自检（0.24.22，`scripts/data-snapshot.mjs` 可单测）；不启动临时宿主，但所有破坏性用例结束后恢复并自证零残留。
- [x] import 落盘非原子：中途 IO 失败＝半套恢复 + 500 原样泄漏路径（0.24.16：暂存→统一提交→失败回滚；`code=io` 脱敏、`code=busy` 503 可重试）。
- [x] 大库读路径：`searchDetailed`/`stats` 各两遍全量扫描（0.24.17：单遍 `collectEntries`；5000 条暖缓存一次刷新约 960ms→500ms）。
- [x] 相似查重 O(N²)（0.24.17：特征倒排候选，1500 条比较阶段 <1.5s 断言，与暴力实现结果一致）。

**P2**
- [x] 大导入写放大 + 同步锁（0.24.16 合并 ensureMeta/索引刷新；0.24.18 账本簿记 400ms / 导入锁 3s 超时→busy，不再同步冻结）。
- [x] `access.json` 无 GC（0.24.18：启动与导入后惰性 prune，手工删除不再留幽灵命中）。
- [x] `backups/` 按任意 `*.json` 轮转与 lastBackup（0.24.18：只认 `dsh-memory-<时间戳>.json`，用户手放文件保留、外来未来 mtime 不再阻塞自动备份）。
- [x] v1→v2 迁移的强制备份失败被静默吞掉（0.24.18：保留 v1 并在 status 暴露 pending/error；maybeAutoBackup 降级）。
- [x] 导入悬垂 `superseded_by/supersedes` 指针使条目默认永久隐藏（0.24.18：丢弃不可达指针并计 repaired，批内前向引用保留）。
- [x] 常驻 tabpanel 导致 `/recall-preview` 初始化与设置保存各多一次（0.24.19：隐藏面板不加载，主面板徽章仅在记忆页刷新，一次设置保存只 +1）。
- [x] 撤销吐司：倒计时条不随新吐司重启；消失后焦点掉 body；hover/focus 不暂停（0.24.19：组件按 toast.id 重挂载、暂停/恢复计时、关闭后焦点回退面板容器）。
- [x] 分页时区块计数＝当前页条数，与统计条总数矛盾（0.24.19：仅单页完整结果显示计数）。
- [x] 批量选择浮栏在 DOM 末尾，键盘用户实际不可达（0.24.19：移到列表前 + region/aria-live）。
- [x] 设置页滑杆拖动触发整页逐帧重渲染（0.24.19：拖动只更新本地值，松手/失焦才提交）。
- [ ] 大库导入可能超过客户端 15s 超时（0.24.15 导入单独 180s 已缓解；第四轮审计升级为 P1：同步冻结宿主、无进度/取消、无幂等回执，见「第四轮审计 backlog」）。

**P3**
- [x] 删除「损坏的后继文件」不清理前驱 `superseded_by`，旧记忆永久隐藏（0.24.21：两分支共用取代指针清理）。
- [x] hidden 归类顺序（superseded→archived→expired）与 `entryStatus`（→expired→archived）不一致（0.24.20：统一按 entryStatus 优先级，含双态条目）。
- [x] `/stats` 不接收 status/include_*，「全部状态」视图下头部总数与列表不一致（0.24.20：stats 与列表同参数，客户端统计请求同步 status/include/category/origin/tag）。
- [x] 编辑/删除确认弹窗写请求期间无「进行中」反馈（0.24.19：显示保存中/删除中）。
- [x] 搜索框清空按钮 aria-label 误用「清除筛选」；标签过滤输入框无清空入口（0.24.19：clearSearch 文案 + 标签清空按钮）。
- [x] live-check bundle 标记仍为字符串包含断言（0.24.23：保留字符串闸门并增加陈旧 rev 必须被拒、bundle 体量下限两项行为断言）。

**待验证**
- [x] 常驻 tabpanel 共享单一滚动容器：切设置页会把列表 scrollTop 夹小，切回无法恢复（0.24.23：按 tab 记忆 scrollTop 并在 layout 阶段恢复；翻页/筛选等导航回到顶部）。
- [x] `backup()` 导出无锁快照：导入持 `.lock-import` 写盘期间可能备份到半批数据；同毫秒两次备份同名覆盖；`atomicWrite` 失败残留临时文件（0.24.21：备份与导入共用锁、唯一文件名、失败清理临时文件）。

### 第四轮双端审计 backlog（2026-11-13，基线 0.24.22）

> 三个只读审计员（宿主 / 面板 / 运维文档）的合并清单，按轮次逐项消化；0.24.23 已修项见 CHANGELOG。

### P1（下一轮优先）
- [x] **导入同步冻结宿主 + 无进度/幂等**（0.24.25 客户端分片+进度+部分失败；0.24.30 服务端 importId 幂等回执/单请求 1000 上限；0.24.34 停止按钮。剩余：回执仅进程内存，宿主重启后 merge 重放仍可能回滚用户编辑——见第六轮 P2）。
- [x] **跨工作区取代链清理不完整**：`clearSupersedeReferences/clearSupersededBy` 只扫 global＋当前 cwd；A 的工作区前驱被 global 后继取代、之后在 B 删除后继 → 前驱永久隐藏且工具无法修复（`memory_update` 无清 `superseded_by`）。方案：悬垂清理扫描 global＋全部工作区（新增 `listEverywhere`），或 `moveEntry` 跨 scope 时消解/拒绝跨作用域链。
- [x] **批量删除 = N 次全量扫描**（0.24.25：`/forget ids[]` 单请求、一次扫描/一次取代指针清理；GUI 断言只发 1 个请求、可一次撤销恢复多条）。

### P2
- [x] **解析缓存上限在大库退化**：20k 条目 warm list ≈ cold（9–11s，顺序扫描把 LRU 冲空）；status/save/export/装配同步全量。方案：默认上限提高到 32768 或按库规模自适应（压测入口保留），DETAIL 写明内存上界。
- [x] **/status 与设置响应同步全量**（0.24.27：status counts 改为 readdir 目录计数（不解析条目）；`storageUsage` 5 秒缓存，设置保存响应不再每次全树 stat；自动备份首检仍为 5s 后但冷缓存导出只发生一次）。
- [x] **写/读路由未知异常未脱敏**：`writeHandler/readHandler` 把 Node 原始错误（含本机绝对路径、`.tmp-` 名）500 回传面板；import 已脱敏为 `io`。方案：未知 code 统一 `500 {code:'internal'}`，日志留原文；客户端 `errorKeyFor` 映射 internal。
- [x] **导入绕过取代链不变量**：自指、A↔B 环、目标仅存在于其它工作区/损坏文件时指针被保留 → 永久隐藏且工具不可修。方案：导入校验自指/同作用域可达/环检测，违规计入 repaired。
- [x] **recall-preview 被 busy 翻转触发**（0.24.28：显式 `dataVersion` 只在写操作成功时 +1；导出/查重/导入预演不再触发全量召回扫描，GUI 断言导出前后 recall-preview 请求数不变）。
- [x] **三处操作后焦点掉 body**（0.24.28：Modal 在 busy→false 且焦点在弹窗外时聚焦回弹窗（覆盖保存失败/审计操作）；取消选择后焦点回面板容器；GUI 断言覆盖取消选择路径）。

### P3
- [x] **备份 `-1` 后缀不被白名单识别**（0.24.24：正则允许 `(?:-\d{1,3})?`，备份按 mtime 排序轮转，count/lastBackup 准确）。
- [x] **settings.json 覆盖层读-改-写无跨进程锁**：两进程并发 patch 不同键 14/20 轮丢一个键。方案：`withLock(root/.lock-settings)` 包住 read-modify-write。
- [x] **withLock 长临界区/双释放风险**（0.24.29：锁目录写入 owner nonce，释放前校验 nonce，超时被抢占后不会删他人锁；`touchLock` + `writeEntryBatch onProgress` 每 128 条刷新锁 mtime，长导入不再被并发进程判陈旧抢占）。
- [x] **导出静默漏损坏条目**（0.24.28：导出/备份文档增加 `skipped` 计数（目录文件数−可解析条目数），损坏文件可被审计发现；导入端忽略该字段）。
- [x] **gui-check 中断不清理**（0.24.26：模块级清理注册表 + SIGINT/SIGTERM/uncaughtException 统一 abort 路径（清理→数据根 diff 断言→非 0 退出）；`--abort-after=<ms>` 可复现注入；启动时扫描并清理 `__gui_`/`__livecheck_` 残留；实测 15s/45s 中断均零残留）。
- [x] **data-snapshot 漏检面**（0.24.26：junk 清单覆盖 `.tmp-*`、`.lock-*`（验证锁除外）、条目目录非 .md、backups 非 .json；backups 改为内容 sha256；abort 路径也做 diff 断言）。
- [x] **验证脚本并发不安全**（0.24.26：`scripts/verify-lock.mjs` 数据根互斥锁（陈旧自愈），live/gui 启动即获取、busy 快速退出；GUI CDP 端口默认随机动态）。
- [x] **迁移 meta 写失败被吞**（0.24.27：`migrateSchema` 写失败抛 code=io、服务层维持 `migrationPending`/`migrationError`，最近备份 10 分钟内复用避免轮转；`tests/service.test.mjs` 有回归）。
- [x] **导入悬垂指针指向「根内已存在但无关」id 不修复**（0.24.24/0.24.27：磁盘目标必须反向声明 `supersedes` 才保留，否则丢弃计 repaired；`tests/import-atomic.test.mjs` repaired=5 断言；跨片同链由 0.24.29 `chunkEntriesPreservingLinks` 保证同批）。
- [x] **包分发/引擎**：`files` 已补 `scripts`（0.24.28 + `tests/package.test.mjs` 守卫）；`engines.dsh` 严格 semver 口径仍待宿主实际校验语义确认（当前 link 安装可用，先记录不改）。
- [x] **可观测/自愈边角**：`status.schemaVersion` 在 meta 损坏时回落 2 掩盖损坏（0.24.27：null+metaError）；未来 mtime 的锁永不 stale（0.24.27：绝对时间差）；live-check cleanup 先置 cleaned 再请求，任一步抛错即留残留（0.24.25 已改批量 forget，0.24.26 中断路径自检）。
- [x] **设置重载与在途保存窄窗口**（0.24.10–0.24.15 GUI 用例 8b/8d/8e 已覆盖：备份触发重载不覆盖未保存草稿、重置不被在途保存回滚、慢网络防抖保存不覆盖 reset；连续两轮全套 GUI 通过，视为已验证）。

dreaming/后台 LLM 提取、向量/图检索、完整 bi-temporal 四时间戳、git 版本化存储、画像 slots、回收站、默认 TTL、跨工作区移动（global↔当前工作区之外的组合）、会话级记忆开关。

### 第五轮双端审计 backlog（2026-11-13，基线 0.24.29）

> 三个只读审计员（宿主 / 面板 / 运维文档）的合并清单。0.24.29 已修项：分片导入按取代链分量打包（P1 数据损坏）、部分成功导入刷新 dataVersion、导出 skipped UI 提示、frontmatter 换行注入防护、busy 不粘滞 backupError、GUI profile 回收（实测回收 85 目录/9.7GB）、verify-lock 死 PID 自愈、settings 真并发测试、skipped 导入往返测试。

#### P1
- [x] **30k 库全量遍历同步冻结宿主（热路径）**（0.24.33：≥1024 文件的目录缓存解析结果数组，靠「本进程写路径同步打补丁 + fs.watch 递归增量重读单文件 + watcher 不可用退化为不缓存」三路维护；30k 合成库实测 warm listAll **1450→约 50ms**、export **1466→86ms**、recallPreview **1568→152ms**、search→91ms、单条 forget **1594→75ms**；小目录/测试库保持逐文件 stat 的严格语义。冷启动首次解析已由 0.24.36 持久化索引解决：索引冷启动 1.72–1.76s，首次建索引为一次性 19–23s）。
- [x] **30k 库冷启动解析 19–23s**（0.24.36：持久化解析索引 `<root>/.cache/entries-v1.json`——进程重启只 stat 校验签名，未变化条目复用解析结果，30k 冷启动实测 **1.72–1.76s**；新增/变更/删除按签名重读，索引缺失/损坏回退全量；`.cache` 属派生数据被快照忽略；`DSH_MEMORY_INDEX=0` 可禁用）。
- [x] **/import 单请求无条数上限**（0.24.30：>1000 条 400 invalid，dryRun 同样；客户端整档预演分片 dry-run 聚合，确认仍 ≤300/片）。
- [x] **importId 幂等回执**（0.24.30：内存 LRU 200（importId+chunkIndex），重放返回 `{cached:true}` 不写盘；客户端稳定 runId + 部分失败保留弹窗重试，merge 重试不再回滚用户编辑）。
- [x] **导入取代关系物化**（0.24.30：`supersedes` 自动补齐批内/磁盘目标的反向 `superseded_by`，磁盘目标随同一原子批次写；`superseded_by` 补齐批内目标 `supersedes`；冲突/未声明反向丢弃计 repaired；环检测含物化反向边）。
- [x] **验证脚本临时条目强杀残留**（0.24.31：`scripts/watchdog.mjs` detached 看门狗——父验证脚本被 taskkill/CI 超时强杀后 1.5–8s 内自动删除 `__gui_`/`__livecheck_` 测试条目、恢复 settings、删除新增备份与残留锁；真实 `taskkill /F` 实测通过，残留窗口从「下次脚本运行」缩短到 ≤2s。专用 workspaceKey 迁移留作后续加固）。

#### P2
- [x] **merge 导入可产生同作用域重复内容**（0.24.30：merge 更新前查同内容去重表，命中即计 deduplicated 跳过）。
- [x] **moveEntry 无回滚**（0.24.34：旧文件删除失败时回滚刚写入的新文件并抛 `code=io`，同 id 不再双作用域并存；测试 patch `fs.rmSync` 抛 EBUSY 验证零变更）。
- [x] **withLock 陈旧自愈 check-then-rm 双持有**（0.24.34：陈旧锁改为 `rename` 到 owner nonce 认领目录（只有一个进程能成功），认领后复核 mtime 仍陈旧才删除；若误抢到新锁则 rename 放回并继续等待。锁超时错误带 `code=busy`）。
- [x] **settings 锁争用映射**（0.24.34：`resetOverlay` 不再吞锁超时，`withLock` 超时统一 `code=busy` → 路由 503；测试断言 write/reset 争用时均抛 busy、释放后恢复）。
- [x] **settings 错误提示文案**（0.24.34：503 busy 走 `errBusy` 映射，GUI/live 已断言；文案无需额外代码）。
- [x] **面板归档撤销在 busy 窗口被静默丢弃**（0.24.32：撤销类动作 `quickUpdate({force:true})` 绕过 busy 守卫；GUI 用 1.5s 延迟注入「归档→toast 出现→刷新 busy 中撤销」断言最终未归档）。
- [x] **分类 chip 计数失真**（0.24.32：`categoryChipCount` 在分类筛选时隐藏其它分类数字，仅保留「全部」与当前分类；GUI 断言筛选后只有 2 个数字）。
- [x] **分片导入不可取消**（0.24.34：busy 时导出弹窗提供唯一可点的「停止导入」；当前片结算后不再发后续片，已落盘片保留并提示「已停止：已写入 d/t」；GUI 用 620 条 + 延迟注入验证只提交首片、后续片未落盘）。
- [x] **撤销 toast 无条件抢焦点**（0.24.32：`shouldFocusToastAction` 纯函数——仅焦点已丢失/卡片动作按钮/面板容器时接管，输入框/可编辑区/有弹窗时不抢；单测覆盖 9 种描述符）。
- [x] **空态/错误态按钮卸载后焦点掉 body**（0.24.32：`focusPage()` 用于清除筛选、列表/面板/设置重试；GUI 断言清除筛选后焦点回 `.dm_page`）。
- [x] **dataVersion 写路径缺正向断言**（0.24.32：GUI 断言归档成功→召回预览 +1、撤销归档→再 +1；失败路径沿用「不刷新」语义）。
- [ ] **dataVersion 失败路径正向断言**：保存/删除失败时不得 +1（低优先，当前负例覆盖主要回归面）。
- [ ] **分片导入失败/重试路径无自动化覆盖**。方案：mock fetch 第 2 片 500 → 提示已写入 d/t、重试不重复、最终全落盘。

#### P3
- [x] **Windows 大小写不敏感 id 冲突**（0.24.35：导入按小写归一核对占用；同批 `m-X`/`m-x` 第二条自动分配新 id、merge 模式用磁盘实际大小写更新同一文件；测试覆盖两文件/合并更新）。
- [x] **相对时间超 7 天不带年份、未来时间夹成「刚刚」**（0.24.35：跨年显示年份、未来时间直接显示日期）。
- [x] **i18n 错误拼接写死中文「：」、服务端 rejected.reason 双语直出**（0.24.32：`errJoin` 中英键替代硬编码冒号；导入拒绝项 `importRejectText` 已知 code 走本地化、未知才回退服务端 reason）。
- [ ] **导出/备份沿用 15s 超时**（大库可能误报超时且备份已成功）。方案：export/backup 独立 timeout（如 120s）+ 进行中文案。
- [x] **engines.dsh 严格 semver 不满足预发布宿主**（0.24.35：README 安装节写明 Node ≥22.6 / DSH ≥0.2.0-rc.2 与预发布语义；`engines.dsh` 保持 `>=0.2.0-rc.2`，link 安装在 0.2.2-alpha.3 实测可用。若宿主启用硬校验且不做 includePrerelease 再按宿主语义调整）。
- [ ] **设置重载与在途保存**：reset 不等待 in-flight save（窄窗口），可持 in-flight promise 串行化。


### 第六轮双端审计 backlog（2026-11-14，工作树 0.24.36）

> 三个只读审计（宿主 / 面板 / 运维文档）的合并清单。**0.24.36 已修**：持久化索引冷启动装 watcher / 索引形状校验 / 库删空或低于阈值时删除索引（隐私正文不残留）/ 索引加载前装 watcher；forget 文件删不掉时不再谎报 deleted（单条 busy 503、批量 failed）；bench --regen 拒绝删除非基准目录；相对时间 45–59s「0 分钟前」；toast 焦点只接管卡片动作按钮（不再抢复选框/输入）；导入停止按钮只在真实写盘阶段出现；分片预演 rejected 下标重定位；停止/中断文案与 dataVersion 使用真实写入数（imported+updated）；errJoin/labelSep 收口；禁用态 hover 视觉。

#### P1
- [x] **索引残留已忘内容**（0.24.36：total<1024 时删除索引文件 + forget 后立即重写；清空/缩容不再留正文副本）。
- [x] **forget 文件占用仍报 deleted:true**（0.24.36：只计真正 unlink 成功的 id；单条 code=busy 503、批量返回 failed；测试用 EBUSY patch 覆盖）。

#### P2
- [x] **/similar 候选对无上限且超高频特征整段跳过**（0.24.37：limit 夹取 ≤200、每条目候选采样 128、稀有特征候选优先保留、超高频特征按步长抽样、特征集相同的模板大簇只取代表并输出一条 100% 对——大簇不再冻结宿主或返回 0 对）。
- [x] **取代关系不可撤销**（0.24.37：`memory_update` 传 `supersedes:''` 清除本条取代并全作用域解除旧目标反向隐藏；`superseded_by:''` 修复悬垂误隐藏；工具 schema/描述同步）。
- [x] **save 去重命中时静默丢弃显式 supersedes；revive 忽略 pinned/expires/category/tags**（0.24.37：去重命中按调用方真正提供的字段应用 supersedes/pinned/expires/category/tags，返回 `applied` 并渲染「已应用显式字段更新」；revive 同样应用；非法 supersedes 直接 400）。
- [ ] **importId 回执仅进程内存**：宿主重启/插件重载后同 importId merge 重放会回滚失败窗口内用户编辑（跨实例 PoC 复现）。方案：回执持久化到 .cache/import-receipts.json（含每片内容哈希）或 merge 时 updated 晚于回执则跳过；至少文档限定「同一宿主进程内」并补跨实例测试。
- [ ] **verify-lock 陈旧锁 check-then-rm + watchdog 无条件删锁**：放大调度窗口后 2/3 轮双持有；watchdog 会删 owner 仍存活的 .lock-verify。方案：verify-lock 复用 lib/lock.js 的 rename 认领+owner nonce；watchdog 删锁前校验 owner PID 存活。
- [ ] **索引写入放大**：单条写入 5s 后 14MB 全量同步重写（stringify 79ms+写 33ms）；forget 路径内同步重写。方案：按目录分片只重写 dirty 目录，或降低重写频率/在空闲期分批。
- [ ] **导入预演无进度、预演期不可取消**：首次 dry-run 期间无弹窗（只有工具栏禁用），改模式时停止按钮不显示（0.24.36 已只在写盘阶段显示，但预演期仍无进度/取消）。方案：预演分片上报「正在预演 d/t」并支持取消 ref。

#### P3
- [ ] **settings storageUsage 全树 stat**：30k 实测 493ms 同步阻塞、5s 缓存，且不含 .cache/backups。方案：大库用目录缓存签名 size 汇总或 TTL 60s；标注统计范围。
- [ ] **search/entries limit 无上限**：limit=1e6 返回 29,998 条/9.4MB。方案：schema maximum + 服务层夹取（工具 200、路由 ≤1000）。
- [ ] **索引加载窗口顺序**（0.24.36 已把 watcher 提前到 stat 循环之前，残余窗口仍待时序构造验证）。
- [ ] **导出/备份沿用 15s 超时**（大库冷启动/首次导出可能假失败且备份已写盘）。方案：export/backup 120s + 进行中文案。
- [ ] **列表无外部写入刷新路径**：切回记忆 tab/窗口聚焦不刷新，agent 在其它会话写入后看不到新条目。方案：工具栏刷新按钮 + focus/visibilitychange 节流刷新（seq 防乱序、保留滚动）。
- [ ] **禁用态 hover 已视觉修复（0.24.36），缺 GUI 计算样式断言**。
- [ ] **关键异步状态缺 live region**：导入进度/列表与设置加载失败/保存状态加 role=status/alert。
- [ ] **origin=auto 徽章浅色对比度 3.64:1**（WCAG AA 需 4.5:1）；方案：浅色文字改 #6d28d9。
- [ ] **超大取代链分量 >1000** 会被服务端上限拒绝（极难出现，标记待验证）。
- [ ] **last_access 详情行按原始 ISO 展示**，与 created/updated 本地化不一致。
