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
| `scripts/live-check.mjs` | 运行中宿主回环 API 全链路＋客户端 bundle rev | `--port=` 或 `DSH_MEMORY_PORT`；测试条目自动清理、设置 toggle 后还原 |
| `scripts/gui-check.mjs` | 真实浏览器面板：过滤请求参数、下拉键盘、弹窗 Esc 草稿 | `--url=`；Edge headless + CDP；cookie 由 `<DSH_HOME>/.credentials.yaml` 自签；临时记忆清理，设置/备份用例前后快照恢复（0.24.15 起） |

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
- [ ] 脚本彻底隔离：默认只读/临时 `DSH_HOME` 跑破坏性用例，`--fail-at=` 失败注入，前后数据根快照 diff=0 自检。
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
- [ ] 大库导入可能超过客户端 15s 超时（0.24.15 导入单独 180s 已缓解，仍无进度/幂等确认）。

**P3**
- [ ] 删除「损坏的后继文件」不清理前驱 `superseded_by`，旧记忆永久隐藏。
- [ ] hidden 归类顺序（superseded→archived→expired）与 `entryStatus`（→expired→archived）不一致。
- [ ] `/stats` 不接收 status/include_*，「全部状态」视图下头部总数与列表不一致。
- [x] 编辑/删除确认弹窗写请求期间无「进行中」反馈（0.24.19：显示保存中/删除中）。
- [x] 搜索框清空按钮 aria-label 误用「清除筛选」；标签过滤输入框无清空入口（0.24.19：clearSearch 文案 + 标签清空按钮）。
- [ ] live-check bundle 标记仍为字符串包含断言（版本已动态化）。

**待验证**
- [ ] 常驻 tabpanel 共享单一滚动容器：切设置页会把列表 scrollTop 夹小，切回无法恢复。
- [ ] `backup()` 导出无锁快照：导入持 `.lock-import` 写盘期间可能备份到半批数据；同毫秒两次备份同名覆盖；`atomicWrite` 失败残留临时文件。

### 明确不做

dreaming/后台 LLM 提取、向量/图检索、完整 bi-temporal 四时间戳、git 版本化存储、画像 slots、回收站、默认 TTL、跨工作区移动（global↔当前工作区之外的组合）、会话级记忆开关。