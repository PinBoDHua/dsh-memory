# Changelog — dsh-memory

本项目的所有重要变更都记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here. Format follows Keep a Changelog; versions follow SemVer.

## [0.24.28] - 2026-11-13

### 修复 Fixed（第四轮审计面板/导出收尾）
- **召回预览只随数据变化刷新**：用显式 `dataVersion`（保存/更新/删除/撤销/导入/取代成功时 +1）替代 `busy` 依赖；导出、查重、导入预演不再各触发一次全量 `/recall-preview` 扫描（大库每次省约 500ms 同步扫描）。
- **弹窗 busy 结束后焦点回弹窗**：Modal 在 `busy` true→false 且焦点掉到 body/弹窗外时，自动聚焦弹窗内首个可用控件（覆盖保存失败、审计弹窗取代后）；「取消选择」后焦点回面板容器（GUI 已断言）。
- **导出/备份不再静默漏损坏条目**：导出文档新增 `skipped`（目录 `.md` 文件数 − 可解析条目数），损坏文件可被审计/面板发现；导入端忽略该字段，向后兼容。
- **包分发**：`files` 补 `scripts`（验证入口随包发布），新增 `tests/package.test.mjs` 守卫（无 runtime deps、type/main/node engine）。
- **测试稳定性**：inode 缓存测试改用「无论路径形态都命中的 stat 补丁 + 实时 stat 派生签名」消除偶发假失败；GUI 保存失败用例改用 `.lock-settings` 确定性阻塞（不再依赖 CDP offline 的 15s 超时时机）。

### 验证证据
- 单元 **295/295**；live **186/186**；真实 GUI **82/82**（+导出不触发召回刷新、取消选择焦点）。

## [0.24.27] - 2026-11-13

### 修复 Fixed（第四轮审计 P2/P3 性能与可观测性）
- **`/status` 不再解析全库**：counts 改为 `store.countEntries` 目录文件计数（20k 库从 9.5s 降到毫秒级；客户端本来只用 counts 显示规模）。
- **设置页存储统计缓存**：`storageUsage` 加 5 秒缓存，设置保存响应不再每次对全树 `stat`（20k 库 790ms 级开销消失）。
- **迁移 meta 写失败可观测**：`migrateSchema` 写失败抛 `code=io` 而不是静默返回成功；服务层保持 `migrationPending=true` 并暴露 `migrationError`，schema 仍为 v1。迁移前强制备份**节流**：最近 10 分钟已有备份则复用，避免反复启动重试新增备份、轮转掉用户历史恢复点。
- **损坏 meta 不再伪装健康**：meta.json 存在但不可解析时 status 上报 `schemaVersion:null` + `metaError:'meta.json 损坏'`（缺失仍视为未初始化、按当前版本）。
- **未来 mtime 的锁可自愈**：锁陈旧判断改用绝对时间差（时钟漂移/手工改时间不再让写操作永久 busy）。

### 新增测试
- 迁移 meta 写入失败（patch rename）→ status pending/error 且 schema 仍 1；恢复后复用最近备份并升级 v2。
- status counts 为目录文件计数（含损坏文件）；损坏 meta 上报 null+metaError。
- 锁 mtime 在未来时按 stale 自愈。

### 验证证据
- 单元 **292/292**；live **186/186**（+counts 整数/`metaError=null` 断言）；真实 GUI **80/80**。

## [0.24.26] - 2026-11-13

### 新增 Added / 测试基础设施
- **验证脚本中断安全**：gui-check 增加模块级幂等清理注册表（临时 id、分片导入 id、settings overlay、backups、验证锁）与统一 abort 路径（SIGINT/SIGTERM/uncaughtException/unhandledRejection：清理 → 数据根 diff 断言 → 非 0 退出）；`--abort-after=<ms>` 可复现中断。启动时先扫描并清理上次残留的 `__gui_*`/`__livecheck_*` 测试条目，再拍零残留基线。实测 15s/45s 中断均「数据根零残留」退出 130。
- **验证脚本互斥锁**：新增 `scripts/verify-lock.mjs`（数据根 `.lock-verify`，陈旧锁按 mtime 自愈）；live-check/gui-check 启动即获取，并发第二个脚本 code=busy 快速退出；GUI CDP 端口默认随机动态（固定 9334 会让并发连到同一页面）。
- **快照漏检面补齐**：data-snapshot 的 junk 清单覆盖 `.tmp-*`、`.lock-*`（验证锁除外）、条目目录非 `.md`、backups 非 `.json`；backups 改为内容 sha256（同名备份被改写也能发现）；abort 路径同样做 diff 断言。live-check 清理改为批量 `/forget ids[]`，再次运行前先清历史残留。
- **Windows 退出健壮性**：gui-check 改用 `process.exitCode` 而非 `process.exit()`（Edge 子进程收尾时强制退出偶发 libuv 断言 0xC0000409；并发锁 busy 场景复现并修复）。

### 新增测试
- `tests/data-snapshot.test.mjs`：junk/临时文件/锁目录/同名备份内容变更检测、验证锁忽略。
- `tests/verify-lock.test.mjs`：获取/释放、并发 busy、陈旧自愈、自动创建数据根。

### 验证证据
- 单元 **289/289**；live **184/184**；真实 GUI **80/80**；中断注入（15s/45s）与并发互斥（第二个脚本 exit 1 且数据零变化）实测通过；live `--fail-at` 中断路径同样输出「数据根零残留」。

## [0.24.25] - 2026-11-13

### 修复 Fixed（第四轮审计 P1 导入/删除可用性）
- **批量删除走单请求**：面板批量删除此前对每条发一次 `/forget`，而每次 forget 都全量扫描清理取代指针（5000 库删 100 条 21.9s）。现在 `/forget` 接受 `ids[]`，`store.forgetEntries` 一次目录扫描定位/删除、一次全作用域扫描清理取代指针、批量清账本；客户端批量删除只发 1 个请求，撤销仍可一次恢复多条。
- **大文件导入分片 + 进度 + 可重试**：面板导入按 ≤300 条/片顺序提交（每片仍是原子批次），导入弹窗显示「正在导入 d/t」；中途失败提示「已写入 d/t，可重试（已存在条目会去重/合并）」。单次请求不再冻结宿主数十秒，也不会撞上 180s 超时；320 条导入实测 2 次 `/import`、全部落盘。
- **单条 forget 统一走批量实现**：损坏文件按文件名跨全部工作区删除，取代指针清理覆盖所有工作区（与 0.24.24 一致口径）。

### 新增 Added
- 测试：`forgetEntries` 批量正确性（取代前驱恢复、损坏文件、缺失 id、400 条批量 <1.5s 冒烟）、`/forget ids[]` 路由契约、客户端 `chunkEntries` 分片纯函数、GUI 批量删除单请求 + 一次撤销、GUI 320 条分片导入（≥2 次 /import + 进度文本 + 全部落盘）。
- live-check：批量删除单请求与取代指针清理、620 条导入落盘 + 批量清理（零残留）。

### 验证证据
- 单元 **284/284**；live **184/184**；真实 GUI **80/80**（数据根快照前后一致、零残留）

## [0.24.24] - 2026-11-13

### 修复 Fixed（第四轮审计 P1/P2 数据安全批次）
- **跨工作区取代链清理**：`forget/update/move` 的悬垂指针清理此前只扫 global＋当前 cwd；「A 工作区里 P 被 S 取代 → S 升级为 global → 在 B 工作区删除 S」会让 P 永久隐藏且工具无法修复。现在新增 `store.listEverywhere`（global＋全部工作区目录，返回原文件路径），两处清理统一全作用域扫描并按原路径原子写回。
- **导入取代链不变量**：导入数据（手工编辑/第三方导出）现在拒绝 ① 自指 ② 批内环（A↔B…）③ 从条目自身作用域不可达的目标（global→workspace、跨工作区）④ 磁盘上已存在但未反向声明 `supersedes` 的无关目标；全部计入 `repaired` 且条目恢复可见。环检测用安全节点反向传播，线性复杂度，不会因大导入退化。
- **未知异常脱敏**：`writeHandler/readHandler` 只透传已知业务 code；Node 原始错误（EEXIST/ENOTDIR、含本机绝对路径与 `.tmp-` 临时名）统一 `500 {code:'internal', error:'internal error'}`；客户端新增 `errInternal` 本地化文案（中英）。
- **备份去重名纳入白名单**：`-1/-2` 后缀的备份现在被 `BACKUP_FILE_PATTERN` 识别并参与轮转；备份列表/轮转改为按 mtime 排序（同时间戳按名称），count/lastBackup/24h 节流不再失真。
- **settings.json 覆盖层并发安全**：`writeOverlay/resetOverlay` 的读-改-写用 `.lock-settings` 跨进程锁包住（≤1s 超时），多窗口/多进程同时改不同键不再互相覆盖丢失。
- **解析缓存默认上限 8192→32768**：20k 条目库上顺序全量扫描会把 LRU 冲刷到 0 命中（warm≈cold 9–11s）；提高默认上限后大库仍保持高命中（压测环境变量保留）。

### 新增 Added
- 测试：跨工作区 forget 恢复前驱；导入自指/环/作用域不可达/无关磁盘目标 5 类修复；路由未知异常脱敏（不含 root/.tmp）；settings 双进程并发写不同键不丢；`-1` 后缀备份计数与轮转。
- live-check：导入不变量 dry-run、持锁设置写返回 internal 且不泄漏路径。

### 验证证据
- 单元 **280/280**；live **175/175**；真实 GUI **74/74**（数据根快照前后一致）

## [0.24.23] - 2026-11-13

### 修复 Fixed（第四轮审计已确认问题 + 0.24.19 回归）
- **标签静默丢失**：`parseTags` 用普通对象去重，`constructor`/`toString`/`__proto__` 等与 `Object.prototype` 同名的标签被丢弃（与宿主 `Set` 口径分叉，用户敲了保存不上）→ 改用 `Object.create(null)`；新增回归测试。
- **连续删除丢撤销入口**：第二个撤销吐司会直接覆盖第一个（`shouldQueueToast` 对 action→action 返回 false），第一条删除的撤销闭包被 GC。现在旧撤销吐司入队（上限内），两条都能先后撤销；GUI 实测连续删 K/L 后依次撤销均恢复。
- **暂停时进度条继续走**：吐司悬停/聚焦暂停只停 setTimeout，CSS 倒计时条仍 6 秒走空（视觉与真实可撤销窗口矛盾）→ `animation-play-state` 与 JS 计时同步冻结/恢复（含首次聚焦分支）。
- **tab 滚动位置丢失**：常驻 tabpanel 共享 `.dm_page` 滚动容器，切设置页会把列表 scrollTop 夹小且切回不恢复 → 按 tab 记忆 scrollTop，`useLayoutEffect` 恢复；GUI 断言改为「保存被夹取前的最大滚动位置且 > 设置页最大滚动」，能真正区分修复前后。
- **翻页/筛选不回顶部**：在第 1 页底部点下一页会停在新页中后段 → `changePage`/各筛选/清空筛选/切换作用域统一回列表顶部并同步 tab 记忆。
- **导入体积文案错误**：`errBodyTooLarge` 中英均写「超过 1 MB」，实际上限 32 MB → 改为 32 MB；新增 i18n 守卫测试（键集一致、占位符一致、重复键检测——顺带发现并修复 `saved` 重复键）。
- **复选框不可区分**：50 张卡片都是同一个 aria-label「选择这条记忆」→ 改为「选择这条记忆：<内容前 30 字>」；GUI 断言前两张标签不同且各含自身内容。
- **标签清空按钮读作「清空搜索」**：新增 `clearTag` 文案（清空标签过滤）。

### 新增 Added
- live-check：bundle 陈旧 rev 必须被拒 + 体量下限断言；GUI 新增 7 项（滚动恢复判别、翻页回顶、复选框标签、进度条冻结、连续删除双撤销等）；保存失败断言改为轮询错误态，消除偶发假失败（连续两次 74/74）。
- ITERATION 新增「第四轮双端审计 backlog（基线 0.24.22）」：宿主/面板/运维三份审计合并的 P1–P3 清单（导入冻结与幂等、跨工作区取代链、批量删除全量扫描、缓存 8192 上限、路由错误脱敏、验证脚本中断安全等）。

### 验证证据
- 单元 **276/276**；live **166/166**；真实 GUI **74/74**（数据根快照前后一致、零残留）

## [0.24.22] - 2026-11-13

### 新增 Added / 测试基础设施
- **数据根快照自检**：新增可单测的 `scripts/data-snapshot.mjs`（条目内容 sha256、`backups/` 文件名集合、`settings.json`/`meta.json`；刻意排除 access.json/index.json 等允许变化的派生数据）。live-check 与 gui-check 运行前后各拍快照并断言 **diff=0**，任何临时条目/设置/备份残留都会让脚本失败。
- **live-check 失败注入**：新增 `--fail-at=<检查名子串>`，在指定检查后抛错，验证「异常中断也会走同一幂等清理」；`main().catch` 现在会先执行应急清理再退出。
- 新增 `tests/data-snapshot.test.mjs`（4 条）：快照内容、access.json 变化被忽略、条目/设置/备份增删改全部可检出、空快照降级。

### 验证证据
- 单元 **274/274**（含新增快照测试）
- live **164/164**（新增「真实数据根快照前后一致」；`--fail-at=命中簿记` 实测 exit 1 但数据根零残留：backups=1、settings 不存在、1+5 条目、账本 6 条、无锁文件/测试标记）
- 真实 GUI **67/67**（新增「真实数据根快照前后一致」）

## [0.24.21] - 2026-11-13

### 修复 Fixed（第三轮审计剩余边角）
- **删除损坏后继文件会清理前驱取代指针**：`forget` 的坏文件兜底分支此前只删文件，其它条目里的 `superseded_by: <坏文件 id>` 仍在 → 前驱记忆永久隐藏且工具无法修复。现在两分支共用 `clearSupersedeReferences`（best-effort 清理 `superseded_by/superseded_at/supersedes`）。
- **备份快照与导入互斥**：`backup()` 与批量导入共用 `.lock-import`（≤500ms），锁忙返回可重试 `busy`（503）而不是静默保存「半批」快照；显式备份失败仍写 `status.backupError`，自动备份降级。
- **同毫秒备份不互相覆盖**：备份文件名经 `uniqueFileName` 去重（`-1/-2…`），同毫秒两次备份都会保留。
- **atomicWrite 失败不留临时文件**：写入/改名失败时清理 `.tmp-*`，用户数据目录不再积累垃圾临时文件。

### 新增 Added
- 测试：损坏后继 forget 后前驱恢复可见且无悬垂指针、导入锁期间 backup 快速 busy 且零文件写入、同毫秒两次备份文件名唯一、atomicWrite 失败无临时残留、`uniqueFileName` 冲突递增；live-check 增加「备份在导入锁期间快速失败」真机检查。

## [0.24.20] - 2026-11-13

### 修复 Fixed（第三轮审计 P3：展示口径一致性）
- **隐藏归类与状态分布同口径**：`collectEntries` 的 hidden 计数改为按「首个生效的排除原因」归类，原因顺序与 `entryStatus` 一致（superseded → expired → archived）；archived+expired 双态条目在隐藏提示与状态 chips 中不再算成两类，`include_*` 部分放宽时按实际拦截原因归类（与列表可见性一致）。
- **`/stats` 与列表同参数**：`service.stats` 接受 `status/include_superseded/include_expired/include_archived/category/origin/tag`，路由透传；客户端统计请求与列表请求同口径（`entriesParams`）。「全部状态/已归档」视图下统计头总数、分类分布与列表一致，不再出现列表 N 条而头部 0 条。

### 新增 Added
- 测试：archived+expired 双态 hidden/byStatus 优先级、`include_expired` 部分放宽归类、`service.stats` 过滤视图 totals、`GET /stats` status/include/category 透传；GUI 断言归档视图的统计请求同步 `status/include_archived`。

## [0.24.19] - 2026-11-13

### 修复 Fixed（第三轮审计 P2：面板体验/可访问性批次）
- **召回预览去重**：设置页预设在隐藏 tabpanel 中仍会加载；现在仅在设置页激活时加载，主面板注入徽章只在记忆页刷新——一次设置保存从 2 次 `/recall-preview` 降到 1 次。
- **撤销吐司生命周期**：Toast 组件按 `toast.id` 重挂载（倒计时条从头开始，不再复用旧动画）；悬停/聚焦时暂停计时、失焦恢复，暂停期间其它普通提示不会替换撤销吐司；吐司关闭/替换时若焦点在吐司内会回退到面板容器（不再掉到 body）。
- **分页区块计数**：只有「单页完整结果」才显示全局/工作区分组条数，分页或筛选状态下不再与统计条全量数字矛盾（纯函数 `sectionCountsExact`）。
- **批量选择浮栏键盘可达**：浮栏 DOM 移到列表之前（视觉仍 fixed 底部），加 `role=region` + `aria-live` 计数，Tab 不必穿过整页卡片才能到「删除所选」。
- **设置页滑杆性能**：拖动期间只更新本地显示值，松手/失焦/按键抬起才提交（不再逐帧 setDraft 触发整页含列表重渲染）；GUI 断言拖动期间 0 次设置保存、松手后恰好一次。
- **写请求进行中反馈**：编辑弹窗 footer 在保存中显示「保存中…」，删除确认弹窗显示「删除中…」，不再整框静默变灰。
- **搜索/标签清空语义**：搜索清空按钮 aria-label 改为「清空搜索」（原误用「清除筛选」）；标签过滤输入框新增清空按钮。

### 新增 Added
- 客户端纯函数 `sectionCountsExact` 单测；GUI 验收新增 7 项（删除中反馈、聚焦暂停 7s、批量浮栏 DOM 顺序/region、滑杆不中途保存+松手提交、吐司新节点/焦点回退、召回预览只 +1），GUI 58→65 项。

## [0.24.18] - 2026-11-13

### 修复 Fixed（第三轮审计 P2：存储卫生）
- **`access.json` 幽灵记录惰性 GC**：新增 `store.pruneAccessLedger`（`withLock` 内比对存活 id，原子写回），服务启动与导入落盘成功后 best-effort 调用。手工/外部删除文件后账本不再只增不减，同 id 重导入也不会继承「前世」命中。真实数据里 2 条幽灵记录已在重载后自动清理。
- **`backups/` 只轮转插件自己的文件**：备份文件名白名单（`dsh-memory-<ISO 时间戳>.json`）用于计数、轮转与 `lastBackup`。用户手放的 JSON 不再被静默删除；外来「未来 mtime」文件也不会让自动备份永久不触发。
- **迁移/备份失败可观测**：v1→v2 强制备份失败不再静默吞掉——保留 v1、`status` 暴露 `migrationPending/migrationError`；`maybeAutoBackup` 失败降级返回 null 并记录 `status.backupError`（显式 `backup()` 仍抛错给调用方）。
- **导入悬垂取代指针修复**：指向「目标根不存在且本批不提供」的 `supersedes/superseded_by` 在导入时丢弃并计数 `repaired`（批内前向引用保留）——不再产生默认永久隐藏、工具无法修复的条目。
- **簿记锁短超时**：`touchAccess`/账本清理/导入锁等待改为有界（账本 400ms、导入 3s→`code=busy` 503），锁被另一进程持有时检索/装配不再同步冻结事件循环。

### 新增 Added
- 测试：幽灵账本 prune + 同 id 重导入无继承、簿记锁忙时 search <1.5s、外来 JSON 不被轮转/未来 mtime 不阻塞自动备份、迁移备份失败降级与修复后恢复、并发导入快速 busy、悬垂指针 repaired 且批内前向引用保留；live-check 增加账本幽灵清理/悬垂指针/手放备份保留/status 可观测字段真机检查。

## [0.24.17] - 2026-11-13

### 性能 Performance（第三轮审计 P1/P2：大库读路径）
- **单遍收集**：新增 `store.collectEntries`——一次列目录＋一次遍历同时产出可见集（排序后）、隐藏态计数与 `byStatus`；`service.searchDetailed` 与 `service.stats` 改用它，不再各自做两遍全量过滤（旧实现一次面板刷新 = 4 次全量遍历，同步阻塞宿主事件循环）。
- **相似查重倒排候选**：`findSimilarPairs` 由 O(N²) 两两比较改为「共享特征倒排索引」候选（Jaccard≥阈值必然共享特征；超高频近似停用词特征不参与候选生成），并保持与暴力实现结果逐项一致。1500 条库比较阶段由秒级降到 <900ms 断言内（实测百毫秒级）；伪造相近对仍能召回。
- 同步把 `searchEntries` 建立在新 `collectEntries` 之上，检索语义/排序/分页与原实现一致（既有 256 项测试全部通过）。

### 新增 Added
- 测试：`collectEntries` 单遍结果与旧 `filterEntries` 在可见集/隐藏计数/byStatus/status 筛选/include_* 组合上逐项一致；`stats/searchDetailed` 单次调用只 stat 每个条目一次（countSync 计数）；倒排候选与暴力 Jaccard 结果集完全一致；1500 条库耗时上界回归。
- 实测（5000 条：1000 global＋4000 workspace，暖缓存）：面板一次刷新（entries+stats）由约 960ms 降到约 500ms（各一次全量遍历）；冷启动首次列表仍以解析 5000 文件为主（约 3.1s）。

## [0.24.16] - 2026-11-13

### 修复 Fixed（第三轮审计 P1：导入落盘原子性）
- **导入全成或零变更**：`store.writeEntryBatch` 先把所有条目暂存为临时文件（目录创建/磁盘 IO 错误在提交前暴露），再统一 rename 提交；任一步失败逆序回滚——新文件删除、被覆盖文件恢复原内容、临时文件清理。此前中途 IO 失败会留下半套恢复数据，且 merge 目标可能已被改写。
- **结构化错误**：落盘失败返回 `code=io`（HTTP 500，文案不含本机绝对路径，客户端提示「写入失败，未做任何变更」）；另一进程长期持锁返回 `code=busy`（503，可重试）而不是让宿主同步等待 30s。
- **写放大收口**：批量导入只 `ensureMeta` 一次、索引按 cwd 去重后统一刷新（此前每条都读 meta + 加锁读改写 index.json）。
- 客户端 `errorKeyFor` 增加 `io`/`busy` 本地化映射（中英）。

### 新增 Added
- `tests/import-atomic.test.mjs`（3 条）：失败零变更 + 无临时文件残留 + 锁释放后可重试、merge 目标内容不被失败批次改写、成功批次写入并刷新索引；routes 测试新增 io 失败 → 500 `code=io` 且文案脱敏；live-check 增加「导入落盘失败零变更」真机检查（临时阻塞 workspaces/<key> 目录，finally 清理）。

## [0.24.15] - 2026-11-13

### 修复 Fixed（第三轮审计：脚本零污染 + 备份可恢复）
- **备份恢复通道 1MB 上限**：写路由 body 上限 1MB→32MB（1500 条备份约 1.4MB，此前「有备份但恢复不了」）；客户端导入文件预检同步 32MB、导入请求超时单独放宽到 180s。
- **导入落地响应瘦身**：落盘模式不再回传全量 `entries`（客户端只用计数），大导入少一次 MB 级序列化与传输；dryRun 仍返回预览计划。
- **gui-check 不再破坏真实数据**：设置页重置/备份用例运行前快照真实 `settings` overlay 与 `backups/` 文件集，结束原样恢复 overlay 并删除本次新增备份；备份前先把足够大的保留份数落盘，轮转不再删除用户历史备份；新增「慢网络下恢复默认不被防抖保存回滚」回归。
- **live-check 失败安全**：幂等清理改为正常结束 + 异常 + SIGINT/SIGTERM 共用；settings 快照恢复、本次新增备份删除、账本清理改走跨进程锁 + 原子写；版本断言改读 `package.json`；备份前临时抬高保留份数避免裁剪历史备份；新增「>1MB 导入备份可恢复」端到端检查。
- **慢网络重置竞态**：`resetSettings` 清 dirty 并让在途响应失效、`saveDraft` 在 dirty 已清时不再落盘——「恢复默认」不会被防抖中的旧草稿以更新 seq 覆盖。
- **defaultView 权威 cwd**：`loadInitial` 等 `/cwd` 解析（跟随 cd）后再置 ready，避免默认视图锁在会话快照的旧目录、首屏多一轮列表请求。
- 文档纠错：workspaceKey 导入语义、注入命中也入账、detectSecret 已修 tags、备份仅含记忆条目、gui-check 安全说明。

### 新增 Added
- routes 测试：>1MB import body 200 全量落盘、落盘响应不含 entries / dryRun 含；413 上限同步为 32MB。

## [0.24.14] - 2026-11-13

### 修复 Fixed
- **召回预览与列表刷新解耦**：注入徽章只依赖「已保存设置／条目／当前工作目录」，此前每次筛选/翻页/输入搜索都会重取 `/recall-preview`（一次额外全量扫描），且失败即清空徽章。现在只在初始化、设置保存、工作目录变化与写操作结束（busy 落回）时刷新，失败保留旧值。
- **默认视图等待 cwd 解析**：`defaultView='workspace'` 此前在 `/cwd` 晚到时已经标记初始化，默认视图永远不生效；现在 `defaultViewSelection` 纯函数在 cwd 未知时返回未解析状态，等 currentCwd 到达后再应用。
- **解析缓存改为 LRU**：「先全量扫描、再高频访问少量热条目」的工作集不再被插入顺序挤出（热条目命中时提升到队尾）；上限 4096→8192，并支持 `DSH_MEMORY_ENTRY_CACHE_LIMIT` 在测试/压测中调小。
- **设置页召回预览联动**：常驻 tabpanel 后设置页不再随 tab 切换重挂载，召回预览改为随有效设置变化刷新。

### 新增 Added
- 单测：`defaultViewSelection`（等待 cwd / 立即生效 / 无需选择）、LRU 命中提升与淘汰顺序（独立模块实例 + 小上限）；GUI 验收新增 2 项（列表筛选不重复请求 recall-preview、设置保存后召回预览刷新），GUI 51→53 项。

## [0.24.13] - 2026-11-13

### 修复 Fixed（第二轮审计 P3：宿主边界加固）
- **写路由非对象 JSON → 400**：`readJsonBody` 现在只接受 JSON 对象，`null`/数组/标量按 `invalid-json` 400 返回；此前会在 service 解构处抛 TypeError 变成 500，并把 JS 异常文案泄漏给客户端。
- **move 去重对齐 save 语义**：目标作用域里「已被取代」的同内容条目默认不可见，不再阻止移动；活跃同内容仍按 `duplicate` 拒绝。
- **withLock 边界**：显式检测 async 回调（Promise 会提前放锁，等于无互斥）并抛错；批量导入临界区显式放宽为 `timeoutMs=30s / staleMs=120s`，避免大导入时被另一进程判为陈旧抢锁。
- **注入装配只算一次**：系统提示装配路径把 `selectInjection` 结果同时用于命中簿记与 `renderSection`（此前同一批记忆的排序/预算计算做两遍）。

### 新增 Added
- 单测：非对象 body 全部 400（`null/[]/[1,2]/42/"str"/true`，空 body 仍走语义 400）、async 回调被拒且锁已释放、move 忽略被取代同内容条目、`renderSection` 复用外部 selection；live-check 增加非对象 body 的原样请求校验。

## [0.24.12] - 2026-11-13

### 修复 Fixed（第二轮审计 P2：可访问性与导入健壮性）
- **删除后焦点可达撤销**：确认删除后原触发按钮随卡片卸载，键盘焦点会掉到页面容器；现在带操作的撤销吐司出现时自动聚焦「撤销」按钮，键盘用户可直接撤销，不丢失上下文。
- **导入健壮性**：`parseImportText` 先 strip UTF-8 BOM 再解析（Windows 工具保存的导出文件不再被误报无效）；「读文件失败 / JSON 语法错误 / 不是导出文件」三类错误分开提示；读文件与解析窗口也置 busy，避免期间重复触发导入。
- **ARIA 细节**：分类 radiogroup 支持 ←/→/↑/↓/Home/End 循环切换并采用 roving tabIndex；两个 tabpanel 常驻 DOM（非激活 `hidden`），`aria-controls` 始终指向存在的面板并保留列表上下文；吐司关闭按钮 aria-label 从「取消」改为「关闭提示」。

### 新增 Added
- 客户端纯函数 `parseImportText` 单测（BOM、语法错误、格式错误、空输入）；GUI 验收新增 7 项（非激活 tabpanel 存在、分类 radiogroup 方向键与 roving tabIndex、BOM 导入预览、导入后 busy 复位、删除后焦点到撤销按钮、吐司关闭按钮文案），GUI 44→51 项。

## [0.24.11] - 2026-11-13

### 修复 Fixed（第二轮审计 P2：面板正确性批次）
- **复活提示**：以相同内容重新保存一条「已归档/已过期」记忆时，服务端实际把它恢复为活跃；面板此前仍提示「已有相同记忆，未重复写入」。现在按 `revived` 优先提示「已恢复为活跃（原为归档/过期）」（`savedToastKey` 纯函数）。
- **导出范围与视图一致**：视图为「全局＋当前工作区」时，导出不再静默包含**所有**工作区——新增 `export({scope:'all', workspace})` 语义（全局＋指定工作区），面板 `exportParams` 按实际所见传参；cwd 未知时回退仅全局；全量备份仍走「立即备份」。
- **空工作区空态**：切到无记忆的工作区时显示「该工作区暂无记忆」而非「记忆库还是空的」（并保留新建入口）。
- **卡片标签点击 = 精确标签过滤**：此前把标签塞进全文查询（正文命中也会混入）；现在走服务端 `tag=` 精确匹配、清空查询词，tooltip 同步改为「按此标签过滤」。
- **busy 期间卡片操作禁用**：钉选/归档/编辑/删除按钮在写请求期间 `disabled`，列表容器带 `aria-busy`，不再是「可聚焦可点击但静默无响应」的死控件。

### 新增 Added
- 客户端纯函数 `savedToastKey` / `exportParams` 单测；`service.export` 的 all+workspace 语义单测（只含全局＋该工作区）；GUI 验收新增 5 项（标签精确过滤请求与结果、「已恢复为活跃」提示、复活后回到活跃且 id 不变、busy 禁用与 aria-busy），GUI 40→44 项。

## [0.24.10] - 2026-11-13

### 修复 Fixed（第二轮审计 P1）
- **设置写入状态机**：保存/重置/备份共用一套可测状态（`settingsStatusNext` 纯函数：dirty/saving/savedOnce/error）。
  - 重置开始时推进 settingsSeq，让在途自动保存/重载的旧响应失效——「恢复默认」不再可能被旧保存响应回滚。
  - `saving` 用请求 token 管理，仅最后一次请求结束时清除：不会因 seq 被推进而永久卡在「保存中…」。
  - 保存失败不再谎报「已保存」：保留草稿并标记脏、footer 显示「重试保存」按钮（失败原因作 title），点击即重试；成功后才回到「已保存」。
  - footer 按 `保存中 → 失败/重试 → 未保存 → 已保存` 优先级显示；saving 时禁用「恢复默认 / 立即备份」避免与在途写入互相踩踏。

### 新增 Added
- 客户端纯函数 `settingsStatusNext` 单测（保存/失败/重试/重置/未知事件迁移）；GUI 验收新增 4 项（离线保存失败显示重试、重试成功回到已保存、重置不被在途保存回滚、重置后不卡保存中），GUI 35→39 项。

## [0.24.9] - 2026-11-13

### 修复 Fixed
- **导出/导入保真（权威 `workspaceKey`）**：此前导出只带索引里的 `workspace`（cwd），而导入按 cwd 哈希定位——索引损坏/缺失时工作区条目变成 `workspace:null` 被 `no-workspace` 拒绝（备份静默丢条目），索引陈旧（cwd 指错）时条目被恢复到**错误工作区**。现在导出为工作区条目附目录权威 `workspaceKey`（global 为 null）；导入优先按 key 落盘（cwd 可缺失、索引可损坏/陈旧），仅在 cwd 与 key 自洽时登记 index.json；旧导出无 `workspaceKey` 时仍按 cwd 兼容导入，merge 模式也支持按 key 合并。
- 导入拒绝信息与 `workspaceKey` 校验接入现有 per-entry 校验/拒绝路径；`workspaceKey` 与 `workspace` 冲突时以 key 定位、不写误导性索引映射。

### 新增 Added
- `tests/export-key.test.mjs`（6 条）：导出带 key、损坏索引往返零拒绝、陈旧索引不搬错目录、旧导出兼容、仅 key 无 cwd 可导入、merge 按 key 合并；live-check 增加导出含 `workspaceKey` 与按 key 回灌检查。

## [0.24.8] - 2026-11-13

### 修复 Fixed（第二轮双端审计的条目健壮性批次）
- **文件名是 id 权威**：`parseEntry` 此前优先取 frontmatter `id`，复制/改名/手改文件后会出现重复 id，`forget` 删掉另一条记忆、`update` 覆盖另一条正文、残留文件无法删除。现在与「目录是 scope 权威」同一口径，id 以文件名为准，frontmatter id 仅兼容无文件名上下文，写回时自动修正。
- **UTF-8 BOM 条目不再静默消失**：Windows 记事本保存的 BOM/CRLF 文件此前解析失败被跳过（记忆从注入/检索/面板消失且不可删），现在先 strip BOM 再按 CRLF 归一解析，可读、可检索、可删除。
- **损坏文件可按 id 删除**：`forget` 在解析失败时按文件路径兜底删除，坏文件不再永久残留、占用存储统计且不可管理。
- **access.json 余影清理**：删除条目时同步移除其命中账本记录；否则重新导入同 id 的新记忆会继承已删除条目的 `last_access`/`hit_count`（幽灵命中影响排序/统计），账本也只会增不减。
- **解析缓存签名抗 Windows tick 碰撞**：`mtime/ctime/size` 在 Windows ~15.6ms 文件时间粒度下同一 tick 内可能完全相同，热路径会长期返回陈旧内容；签名追加 `ino/birthtimeMs`（stat 已在手，零额外 IO），原子写/删除重建必然可辨。

### 新增 Added
- `tests/entry-robustness.test.mjs`（5 条）：文件名权威、BOM/CRLF、坏文件删除、账本余影清理、tick 碰撞下的缓存失效；live-check 增加 BOM/CRLF 可见性、坏文件删除、账本清理端到端检查。

## [0.24.7] - 2026-11-13

### 变更 Changed
- **命中簿记迁移到独立 `access.json` 账本**：检索命中与系统提示注入命中不再改写条目 Markdown（此前每次检索都要重读+整文件回写，既有写放大，也有读-改-写窗口在并发时覆盖正文的风险）。账本由 `withLock` 保护、原子写、签名缓存读取；节流仍为「每条目 ≤1 次/小时」；账本损坏按空处理并在下次命中时自愈；旧条目文件里的 `last_access`/`hit_count` 继续兼容（首次入库时从旧计数续写）。
- **注入命中恢复入账**：系统提示装配时对「实际被注入」的条目记账（仅一次 selectInjection 计算＋每小时一次账本写），DETAIL 恢复「检索/注入命中簿记」口径。

### 新增 Added
- `tests/access-ledger.test.mjs`（6 条）：命中不改写条目文件、节流、损坏账本自愈、旧文件字段兼容、双进程并发不丢计数、系统提示注入入账；`tests/fixtures/access-worker.mjs` 并发 worker。
- live-check 增加「账本写入且条目 Markdown 未被改写」「再次检索叠加命中计数」端到端检查；清理阶段同时清理测试条目的账本记录。

## [0.24.6] - 2026-11-13

### 修复 Fixed
- **机密检查覆盖标签**：此前硬拒只检查正文，`memory_save`/`memory_update`/导入可把 `ghp_…` 之类的令牌放进 tags 落盘并被检索。现在正文与标签统一检查，标签命中同样返回 `code=secret`；正常标签不受影响。
- **非法作用域返回 400**：`memory_search`/面板 `GET /entries|stats|similar?scope=bogus` 此前由 store 抛无 code 的 Error 变成 500；现在检索类接口统一校验 `scope ∈ {all, global, workspace}`，非法值回 `400 invalid`。
- **工作区条目更新不刷新索引**：`memory_update` 更新工作区条目后 `workspaces/index.json` 的 `lastSeen` 不再停滞（面板工作区排序/最近使用据此）；`firstSeen` 保持不变。
- **workingDirectory 晚就绪**：会话有效目录解析改为每次实时查询 `ctx.get('workingDirectory')`（此前在 apply 时一次性捕获，服务晚于插件就绪时 cd 后仍会用旧目录，导致工作区记忆写错位置）；回退 `session.header.cwd` 的行为不变，新增纯函数 `resolveSessionCwd` 与集成回归（fake ctx 验证晚就绪 + cd 后写入新工作区）。
- **文档口径对齐**：明确命中簿记只在检索命中时写 `last_access`/`hit_count`（注入不落盘，避免每次系统提示装配写文件），修正 DETAIL 中「检索/注入命中簿记」的表述。

### 新增 Added
- `tests/hardening.test.mjs`：标签机密硬拒、非法 scope 400（service＋路由）、update 刷新 lastSeen、`resolveSessionCwd` 与 apply 晚就绪集成回归；live-check 增加标签机密、非法 scope、lastSeen 刷新端到端检查。

## [0.24.5] - 2026-11-13

### 修复 Fixed
- **设置页在保存设置时崩溃（重要）**：`POST /settings` 与 `/settings/reset` 的响应被包在 `{result}` 里，客户端把包裹对象当成设置视图写回状态，任何一次设置自动保存/恢复默认都会让设置页渲染崩溃（面板消失）。新增 `unwrapResult` 统一解包写路由响应。
- **设置保存一致性**：服务端会夹取/规范化取值（如保留份数 0→1），保存成功且无新编辑时把草稿回收为 effective，界面值不再与实际保存值错位；加载设置不再覆盖防抖窗内未保存的草稿（改完立刻点「立即备份」不会回滚改动）；保存失败清除「已保存」状态；保留份数输入即夹取到服务端允许区间。
- **设置加载失败不再永久骨架**：首次加载失败显示「加载失败 + 重试」，而不是无限骨架；召回预览加 seq 守卫，快速切换工作区时旧响应不再覆盖新响应。
- **标签客户端收敛**：编辑器解析标签时去重、单项截 64 字符、最多 12 个（与宿主 `cleanTags` 同口径），并新增「标签 n/12」计数与超限提示，避免「提示已保存、服务端静默截断」。
- **WAI-ARIA Tabs**：记忆/设置标签补全 `tablist`/`tab`/`tabpanel` 关联（`aria-controls`/`aria-labelledby`）、roving `tabIndex` 与 ←/→/Home/End 键盘切换（焦点跟随）。

### 新增 Added
- 客户端纯函数 `parseTags`、`unwrapResult` ＋单测；GUI 验收新增 11 项（Tabs ARIA/方向键、标签计数与上限提示、保留份数夹取、备份触发重载不覆盖草稿），GUI 检查 24→35 项。

## [0.24.4] - 2026-11-13

### 修复 Fixed
- **请求超时/网络失败不再卡死面板**：面板所有回环请求加 15s 超时（`AbortSignal.timeout`，超时中止），超时/网络失败/200 非 JSON 响应统一转成带 code 的错误并本地化（新增「请求超时 / 网络异常 / 响应格式异常」中英文案）。此前请求挂起会让首屏骨架或全局 busy 永久卡住、只能刷新页面。
- **批量删除部分失败**：删除改为逐项结算（`Promise.allSettled`）——单项失败不再让整批「静默无操作」：成功项立即从列表移除、刷新列表/工作区并保留撤销（通过 import 原样恢复 id/时间戳），失败项在吐司里汇报原因；全部失败显示「删除失败」。
- **撤销吐司被后续提示覆盖**：删除后的 6 秒撤销不再被任意普通提示挤掉——撤销吐司未到期时普通提示进入队列（最多 3 条），撤销到期/点击后再依次展示；点撤销先出队再执行恢复。
- **批量选择与列表不同步**：列表刷新后把选中集合与当前页条目求交，条目被归档/删除/过滤掉后不再残留；「删除所选」在选中项已全部不在列表时清除选择并提示，而不是按钮死点。

### 新增 Added
- 客户端纯函数 `shouldQueueToast`（撤销吐司优先级判定）与 `partitionSettled`（批量删除逐项结果归类）＋单测；`errTimeout/errNetwork/errBadResponse` 映射测试。
- GUI 验收脚本新增 4 组真实浏览器场景（删除撤销不被覆盖、撤销恢复 id 不变、离线网络错误可重试、恢复在线重载），GUI 检查 15→24 项。

## [0.24.3] - 2026-11-13

### 变更 Changed
- **读盘性能：解析缓存**。条目解析结果按「路径＋mtime/ctime/size」签名缓存：热路径（系统提示装配、`memory_search`、面板列表/统计/召回预览）只做 `statSync`，命中即零文件读、零重复解析；原子写（临时文件改名）会更新 ctime、手工编辑会更新 mtime，因此「改完立即生效」契约不受影响；删除文件同步清缓存、命中簿记写回后同步缓存，缓存上限 4096 条按插入顺序淘汰。
- **批量导入去重去二次方**：每个作用域只全量读一次建 `normalizeContent → id` 映射，替换逐条 `listScope().find()`（旧实现导入 N 条到已有 N 条约 N×N 次文件读）；批内新增与 merge 合并同步更新映射，去重语义不变。

### 新增 Added
- `tests/cache.test.mjs`：冷读一次/热读零 IO、外部编辑与删除按签名失效、`stats`/`searchDetailed` 共享缓存（读次数断言）、单/双作用域导入读次数线性断言（≤150/≤200，旧实现约 3600/6400）、批内去重语义回归。
- live-check 增加「手工编辑文件后缓存立即失效」端到端检查。

## [0.24.2] - 2026-11-13

### 修复 Fixed
- **取代链完整性**：`save`/`update` 的 `supersedes` 现在统一校验——目标必须存在、不能取代自身、**不能覆盖已有后继**（此前会静默改写 `superseded_by`，让原后继与链脱节）、**不能形成取代环**（此前 A 取代 B 后 B 再取代 A 会让两条记忆互取代、默认检索全部消失）。违反时返回 `code=invalid`；改取代目标时会清理旧目标的反向引用，不留「旧目标仍隐藏但无人指向」的悬垂态。
- **删除时清理取代链悬垂引用**：`memory_forget`/面板删除现在会同步清理同可见范围（global＋当前工作区）内指向该条的两个方向引用——被它取代的旧条目恢复可见（清 `superseded_by`/`superseded_at`），取代它的新条目清掉 `supersedes` 指针。此前删除后继会让旧记忆永久隐藏且引用指向不存在的 id。
- **`memory_update` 同时移动作用域时 `supersedes` 被静默丢弃**：`moveEntry` 现在先校验并建立取代链再落盘；此前工具报「已更新」但链未建立。
- **命中簿记旧快照回写**：`touchAccess` 写前重读磁盘，只合并 `last_access`/`hit_count`，不再用检索时的旧快照整文件回写（此前可覆盖其它进程并发写入的正文）；`memory_search` 因带写副作用改为声明 `isConcurrencySafe: false`，遵守宿主并发契约。
- **frontmatter 的 scope 不再覆盖目录作用域**：`parseEntry` 以所在目录为准（frontmatter 仅作无目录上下文时的兜底）。此前手改/错放文件会导致「forget 报成功但文件仍在」「update 写到另一目录」。
- **导入跨作用域 id 唯一性**：导入前扫描 global＋全部工作区已占用 id，任何作用域已占用就分配新 id（merge 模式也不跨作用域合并）；此前 workspace 与 global 可并存同 id，`findEntry` 全局优先会让按 id 的更新/删除命中错误条目。
- **导出以目录为权威**：`export({scope:'all'})` 始终按工作区目录 key 读取条目，索引 `cwd` 仅作显示字段；此前索引陈旧/损坏会漏条目或重复。

### 新增 Added
- 数据一致性回归测试 `tests/integrity.test.mjs`（取代链防环/防覆盖、forget 双向清理、跨作用域取代、move+supersedes、touchAccess 并发回写、目录作用域权威）；导入 id 唯一性与陈旧索引导出测试；live-check 增加取代链不变量与删除恢复可见往返。

## [0.24.1] - 2026-11-13

### 修复 Fixed
- **面板来源/标签/状态过滤未生效**：0.22/0.24 将三类过滤移到服务端并移除客户端过滤，但列表请求构造器 `buildEntriesQuery` 从未序列化 `origin`/`tag`/`status`——面板筛选时请求实际没带条件（列表、分页口径与隐藏态提示随之失真）。抽出可测纯函数 `entriesParams`（作用域＋过滤条件＋隐藏态放宽＋分页），补全序列化并接入列表刷新；客户端回归测试覆盖全部字段与空值省略。
- **状态视图漏组合隐藏态**：服务端先过隐藏门再做 `status` 后置过滤，查看「被取代/已过期/已归档」时只放宽对应 `include_*`，导致「被取代＋归档」这类组合态条目在对应状态视图里仍被别的隐藏门挡掉。现在查看任一隐藏态均放宽全部 `include_*`。
- **取代链跳转被标签过滤挡住**：`jumpToEntry` 重置状态/来源/分类过滤时漏清标签过滤，已补上（与「清除全部过滤」同口径）。
- **同内容去重命中归档/过期条目后仍隐藏**：再次保存与已归档/已过期条目完全相同的内容时，此前只提示「已有相同记忆」却不恢复可见性（注入与默认检索都看不到）。现在会复活既有条目（清 `archived`/`expires`、刷新 `updated`，按本次保存更新 `origin`），`memory_save` 输出新增可选 `revived: true`，渲染为「已从归档/过期状态恢复为活跃」。被取代条目仍不参与去重，保留「save 新＋supersedes 旧」修正流。
- **工具输出 lossless 契约**：旧 v1 文件/手工编辑/旧导出导入的条目可能没有 `origin`，`memory_save` 去重路径与 `memory_update` 直接返回 `origin: undefined`，宿主 lossless JSON 校验会拒绝整个工具输出（写盘已生效却报工具失败）。新增 `saveResultValue`/`updateResultValue` 纯函数，`origin` 缺省兜底 `manual`，返回对象无 undefined 自有属性。
- **全新数据根首次导入失败**：数据目录尚不存在时 `withLock` 以 `mkdir(recursive:false)` 建锁抛 ENOENT，首次「导入恢复」直接 500。`withLock` 现先递归创建锁的父目录。
- **导入绕过过期日校验**：导入不再直接落盘 `expires` 原值，改用与 save/update 相同的 `normalizeExpires` 校验；非法日期整条计入 `rejected`，避免坏日期（如 `2026-99-99`）被字符串比较永久隐藏。
- **自定义下拉键盘不可用＋Esc 连弹窗一起关**：浮层首帧定位前是 `visibility:hidden`，隐藏元素无法聚焦，打开下拉后焦点仍留在触发器，方向键/Enter/Esc 都不会进入浮层（键盘导航实际失效）；定位完成后补一次延迟聚焦恢复完整键盘导航。Esc 现在只关下拉并阻止冒泡（Modal 的 Esc 处理器识别 `defaultPrevented` 与浮层内事件后不再关弹窗，草稿不再丢失）；Tab 关闭下拉并把焦点归还触发器；`/` 快捷搜索不再从打开的下拉浮层抢焦点。

### 新增 Added
- 客户端纯函数 `entriesParams`（`tests/client.test.mjs` 覆盖过滤/隐藏态放宽/分页）；存档复活回归测试（`tests/service.test.mjs`、`tests/tool-render.test.mjs`）；工具输出 lossless 契约测试（`tests/tool-output.test.mjs`）；锁目录缺失（`tests/lock.test.mjs`）与导入校验/全新根（`tests/import-mode.test.mjs`）；live-check 增加复活往返、导入拒绝坏日期与分发 bundle 新代码断言。
- `scripts/gui-check.mjs`：Edge headless＋CDP 的真实面板端到端验证（登录 cookie 自签、过滤请求参数、下拉键盘导航、弹窗 Esc 草稿保持、截图），本轮 17 项全通过；`docs/ITERATION.md` 记录迭代协议与待办 backlog。

## [0.24.0] - 2026-11-13

### 变更 Changed
- **状态过滤改服务端**：面板状态筛选（活跃/被取代/已过期/已归档/已钉选/全部）由客户端逐页过滤改为服务端 `status` 后置过滤（`GET /entries?status=`），修复状态过滤下分页条数波动；`pinned` 现放宽全部隐藏态，不再漏掉钉选的归档/过期/被取代条目。移除客户端 `matchesFilters`（来源/标签/状态均已服务端）。
- **状态优先级口径统一**：新增 `store.entryStatus`（被取代 > 已过期 > 已归档 > 活跃，pinned 正交），`service.stats` 的 byStatus 改用同一口径（此前 archived 优先于 expired，与面板 statusOf 不一致）。

### 新增 Added
- `store.entryStatus` 纯函数＋状态服务端过滤回归测试（`tests/status-filter.test.mjs`）。

## [0.23.0] - 2026-11-13

### 变更 Changed
- **工具输出渲染纯函数化（质量加固）**：`memory_save`/`memory_search`/`memory_update`/`memory_forget` 的 render 提取为模块级纯函数 `renderSaveResult`/`renderSearchResult`/`renderUpdateResult`/`renderForgetResult`（行为完全不变），可独立单测。

### 新增 Added
- 工具渲染回归测试（`tests/tool-render.test.mjs`）：覆盖保存/去重/相似提示（含 40 字截断）、检索空态/隐藏态/标记、更新/遗忘文案，及所有工具输出的 lossless JSON 往返——防止 v0.13 式输出回归。

## [0.22.0] - 2026-11-13

### 变更 Changed
- **面板来源/标签改服务端过滤**：origin 过滤由客户端逐页过滤改为服务端（`GET /entries?origin=`），修复来源过滤下分页条数波动/hasMore 失准；标签过滤 likewise 走服务端 `tag`。统计条保持分布概览口径。

### 新增 Added
- 工具栏标签过滤输入框（精确匹配、大小写不敏感、300ms 防抖；中英 i18n＋主题化样式）；「清除全部过滤」一并重置标签。

## [0.21.0] - 2026-11-13

### 新增 Added
- **检索精确过滤**：`memory_search` 与 `GET /entries` 新增 `origin`（manual/auto）与 `tag`（大小写不敏感精确匹配）过滤参数，贯穿 `store.filterEntries`/`searchEntries`、`service.search`/`searchDetailed`（隐藏计数同口径）。便于 agent 审阅自动沉淀的记忆（origin=auto）或按标签精准切片。

## [0.20.0] - 2026-11-13

### 新增 Added
- **导入合并模式**：`service.import({mode:'merge'})` 与 `POST /import` 支持按 id 原地更新已存在条目（保留 created 时间，应用导入的内容/分类/标签/v2 字段），计入新增 `updated` 计数；修复「导出→修改→导入」备份恢复因 id 占用而分配新 id 产生平行重复的问题。默认 `mode='skip'` 完全向后兼容（内容去重＋id 占用新分配）。
- 面板导入弹窗新增「按 id 合并」开关（切换即重算 dry-run 预览），预览瓦片增「更新」计数（新增/更新/重复跳过/拒绝四瓦片），确认按钮在新增与更新均为 0 时禁用。

### 变更 Changed
- 导入返回与 `importSummary` 增 `updated` 字段（additive）；导入完成吐司含更新计数。

## [0.19.0] - 2026-11-13

### 新增 Added
- **列表注入徽章**：主列表卡片对「已注入系统提示」的活跃记忆显示「已注入」徽章（按全局＋当前工作区上下文、当前预算/衰减设置实时计算，复用 `GET /recall-preview`，失败降级不阻断列表）；自动注入关闭时不显示。注入效果在主视图可见，便于 tuning 记忆集与预算，与设置页召回预览互补。

## [0.18.0] - 2026-11-13

### 新增 Added
- **面板检索隐藏态提示**：`GET /entries` 改用 `service.searchDetailed`，响应增 `hidden` 计数（被取代/过期/归档，与 0.13.0 工具同口径）；面板搜索时若存在隐藏匹配，列表上方提示「另有 N 条匹配被隐藏…」并可一键切「全部状态」查看。面板与工具的检索完整性对齐。

### 变更 Changed
- `/entries` 响应由 `{entries}` 扩展为 `{entries, hidden}`（additive，面板读取 entries 不变）。

## [0.17.0] - 2026-11-13

### 新增 Added
- **作用域感知导出**：`service.export({scope,workspace})` 与 `GET /export?scope=&workspace=` 支持按作用域导出——`all` 全量（默认，向后兼容，自动备份/立即备份不受影响）、`global` 仅全局、`workspace` 指定工作区（缺 cwd 报 no-workspace，非法 scope 报 invalid）。便于单独分享/迁移全局偏好或某工作区记忆。
- 面板「导出」跟随当前作用域选择（全部=全量、仅全局=全局、工作区=该工作区），文件名含作用域标签，吐司显示导出条数。

### 变更 Changed
- 导出吐司由「已导出全部记忆」改为「已导出 {n} 条记忆」（中英）。

## [0.16.0] - 2026-11-13

### 新增 Added
- **取代链双向导航**：条目详情中的「取代了 / 被取代」id 现为可点击链接，跳转到对应记忆（此前仅卡片顶部「查看后继」单向按钮）。
- **全部状态筛选**：状态 chips 新增「全部状态」（all），一次放宽 include_superseded/include_expired/include_archived，可一览含隐藏态的全部记忆（此前只能按单一隐藏态筛选）。

### 修复 Fixed
- 跳转到被取代/已归档/已过期的目标不再被「活跃」过滤遮罩成死路：`jumpToEntry` 改用 all 状态，揭示任意状态的目标记忆。

## [0.15.0] - 2026-11-13

### 新增 Added
- **隐私护栏扩充**：新增多种常见独立令牌格式的硬拒写——GitLab `glpat-`、npm `npm_`、Stripe `sk_live_`/`rk_live_`/`sk_test_`/`rk_test_`、SendGrid `SG.…`、PyPI `pypi-`；GitHub token 前缀由 `ghp_` 扩充到 `ghp_/gho_/ghu_/ghs_/ghr_`（含 `github_pat_`）。均为高特异性前缀＋最小长度，避免误伤普通文本（仅提及前缀、无长尾令牌仍放行）。

### 变更 Changed
- 护栏仍为始终启用的硬护栏（服务层 save/update/import 共用 `detectSecret`）；新增格式不影响既有规则与「其他敏感信息先问用户」指引。

## [0.14.0] - 2026-11-13

### 新增 Added
- **注入召回预览**：设置页「注入与召回」组新增「召回预览」块，展示当前设置下实际注入条数、未注入条数、占用字符/预算，以及注入条目清单（分类色标＋内容截断，最多 30 条）；「刷新」按钮按需重算（反映已保存设置），自动注入关闭时标注「开启时预览」。调预算不再凭空想象。
- 新路由 `GET /recall-preview`（workspace 参数）；`service.recallPreview()`。

### 变更 Changed
- `render.js` 提取纯函数 `selectInjection(entries,{budgetChars,decayEnabled,now})→{selected,omitted,usedChars}`，`renderSection` 改为基于它装配（输出完全等价，既有行为测试守护）；渲染与预览共用同一选择逻辑，杜绝口径漂移。

## [0.13.0] - 2026-11-13

### 变更 Changed
- **`memory_search` 输出形状（契约变更）**：由条目数组改为 `{entries, hidden}`。`entries` 为分页可见结果（条目形状不变）；`hidden={superseded,expired,archived,total}` 统计当前查询下被默认过滤隐藏的匹配数（按首个排除原因归类、不重复计数），会话渲染附「另有 N 条匹配被隐藏…可用 include_* 找回」提示，避免 agent 误判「无记忆」。面板 `/entries` 路由不受影响（仍用 `service.search` 数组）。

### 新增 Added
- `memory_search` 新增 `offset` 分页参数（服务层早已支持，工具面补齐）；记忆增多后可翻页检索。
- `service.searchDetailed()`：检索＋隐藏态匹配计数（entries 分页可见＋hidden 全量统计）。

### 修复 Fixed
- `memory_search` 输出稀疏字段（origin/pinned/expires/archived/superseded_by）仅在存在时附加，避免 `undefined` 被 JSON.stringify 丢弃而触发宿主「value is not lossless JSON」校验失败（提取 `searchResultEntry` 纯函数＋回归测试）。

## [0.12.0] - 2026-11-13

### 新增 Added
- **相似记忆查重（duplicate audit）**：面板工具栏新增「查重」按钮，扫描当前作用域活跃记忆两两 Jaccard 相似度（≥0.5），弹出相似对列表（旧/新内容对照＋相似度百分比）。每对可「新取代旧」（较新条目 supersedes 较旧，保留历史、旧条目默认隐藏）或「忽略」（仅本次移除，保留两条）。治理存量近似重复，与 0.11.0 写入时提示形成「防新增＋清存量」闭环。
- 新路由 `GET /similar`（scope/workspace 参数，返回 `{pairs:[{score,older,newer}]}`，按分数倒序、上限 50）；`service.similarPairs()`、`store.findSimilarPairs()`（特征集预计算，O(n²) 仅按需调用）。
- `store.contentSimilarity` 重构为共享 `jaccardFeatures`（行为不变），查重与写入提示共用同一相似度语义。

### 变更 Changed
- 查重排除被取代/已归档/已过期条目，跨作用域不配对；中英文案与主题化弹窗（复用 Modal/图标/按钮体系）。

## [0.11.0] - 2026-11-13

### 新增 Added
- **写入时相似记忆提示**：`memory_save` 写入后若同作用域存在近似内容（Jaccard 相似度 ≥0.5，特征＝拉丁/数字词＋CJK bigram），返回 `similar`（最多 3 条，含 id/content/score，按分数倒序）；会话渲染附提示「若为信息更新请取代/更新旧条目，避免并存矛盾」。advisory 不阻断写入；排除被取代/已归档/已过期条目与显式取代目标；过短内容（特征 <3）不参与，避免巧合噪音。补上取代链的最后一环：写入时即告知旧条目 id，无需先检索。
- 面板新建成功后若检测到相似记忆，吐司提示条数与首条 id、建议核对是否重复（zh/en）。
- `store.contentSimilarity(a, b)` 纯函数（Jaccard，可独立单测）。

### 变更 Changed
- `memory_save` 输出 schema 新增可选 `similar` 数组；工具描述补充相似提示说明。
- 去重判定不变（仍为完全相同内容）；相似度仅用于提示，不影响去重与检索过滤。

## [0.10.0] - 2026-11-13

### 变更 Changed
- **`memory_save` origin 必填**：schema `required` 加入 `origin`，描述明示 manual=用户显式要求 / auto=主动沉淀，杜绝漏传静默落默认；服务层 `saveEntry` 缺省仍兜底 manual（导入/直接调用语义不变）。
- **来源徽章文案**：zh「手动/自动」→「显式要求/主动沉淀」，en「Manual」→「Requested」（Auto 不变）；仅显示层，存储与工具枚举值仍为 manual/auto，零迁移；徽章/筛选/详情统一生效。
- `memory_save` 会话渲染常显 origin（原先仅 auto 加后缀）。
- 注入指引与自动提取动态提示措辞对齐 origin 必填。

### 新增 Added
- `memory_update` 可选 `origin` 参数：修正来源标记（服务层早已支持，工具面补齐）。
- 面板编辑弹窗来源选择（显式要求/主动沉淀，默认当前值，附语义提示）；新建弹窗固定「显式要求」（面板新建即用户手动操作）。

### 修复 Fixed
- 旧版（v1）写入的条目缺 origin，被懒缺省一律显示「手动」，agent 主动沉淀的旧记忆因此误标（用户 asleep 时不可能手动操作）；存量数据已显式补写 origin 纠正（数据侧），文案与工具面补齐防止再犯。

## [0.9.0] - 2026-11-13

### 新增 Added
- **取代链（supersede）**：`memory_save`/`memory_update` 可声明 `supersedes=旧id`；旧记忆标记 `superseded_by`/`superseded_at`，默认隐藏、历史保留可查（`include_superseded` 找回）。信息变化不再产生并存矛盾。
- **可选过期日（expires）**：`YYYY-MM-DD`（UTC、当日含），到期默认隐藏不删除、可恢复（`include_expired`）；坏日期 fail-open。
- **钉选常驻（pinned）**：钉选记忆在注入预算内最先注入、免衰减。
- **归档（archived）**：`memory_update` `archived=true` 归档（默认隐藏）/`false` 恢复（`include_archived`）。
- **软衰减排序＋命中反馈**：检索/注入命中簿记 `last_access`/`hit_count`（节流 ≤1 次/小时）；相关度×衰减乘子 `clamp(1.5−0.15×闲置周数, 0.3, 1.5)`，永不过滤、pinned 豁免、`decayEnabled` 可关回退现状。
- **自动提取动态提示**：`ctx.systemPrompt.context()` 按会话活动量周期性提醒主 agent 沉淀记忆（`origin=auto` 标记），写入后清除；特性检测缺失则静默跳过；零额外模型调用；`autoExtractHint` 可关。
- **中文检索增强**：CJK bigram 模糊匹配（覆盖率 ≥0.6），提升中文召回；保留 AND 语义与精确子串命中。
- **来源标记（origin）**：manual/auto；面板徽章＋筛选，自动记忆可审阅撤销。
- 面板：状态筛选（活跃/被取代/已过期/已归档/已钉选）＋`byStatus` 计数、钉选/归档快捷操作、编辑弹窗钉选开关与过期日输入、详情展开 origin/last_access/hit_count/取代链。
- 设置新增 `autoExtractHint`、`decayEnabled` 开关（注入与召回组）。
- live 验证脚本 `scripts/live-check.mjs`（回环 API 端到端＋客户端分发 rev 实证）。

### 变更 Changed
- **schemaVersion 1→2**：新字段全部可选、稀疏存储，旧文件无需改写（懒缺省）；加载时旧 v1 数据强制备份一次再升级 meta 锚点，旧记忆零丢失。
- **检索/注入默认语义**：默认隐藏被取代/已过期/已归档条目（`include_*` 可找回）；工具描述与面板明示。
- 注入排序：钉选最先→分类优先→类内衰减乘子倒序（同分按更新时间）。
- 去重只针对未取代条目（允许「save 新＋supersedes 旧」修正流）。
- guard 机密模式扩充：Bearer 令牌、带口令连接串。
- 导出/导入保留 v2 可选字段（无损往返）。

### 修复 Fixed
- 面板「当前工作区」与会话有效目录口径对齐：新增只读 `/cwd` 路由（workingDirectory 服务，跟随 cd），面板初始目录基础上异步刷新，cd 后不再与 agent 工具错位；服务不可用时回退初始目录。

## [0.8.1] - 2026-11-13

### 修复 Fixed
- 下拉弹出层与触发按钮宽度不一致、左右不对齐，看起来像「两块板」而非一个整体。现弹出层宽度严格等于触发按钮的渲染宽度，左右边缘完全对齐。
- 触发按钮按场景带稳定最小宽度（工具栏 220 / 默认视图 200 / 每页条数 120），切换选中值时宽度不跳动、常见长选项不截断；超长选项省略号＋悬停显示全文。

### 变更 Changed
- 弹出层与按钮间隙由 6px 收紧到 4px；打开时弹出层描边染主色（35%）与触发按钮的主色描边呼应，视觉上连成一件。

## [0.8.0] - 2026-11-13

### 变更 Changed
- 全部 4 处原生 `<select>`（工具栏作用域、编辑器作用域、设置默认视图、设置每页条数）替换为统一的自定义无障碍下拉 `Select`，弹出层彻底主题化，消除系统默认白底/蓝高亮与页面风格的割裂。

### 新增 Added
- `Select` 组件：button + portal 浮层 listbox（`react-dom.createPortal` 到 body，避开工具栏/弹窗 backdrop-filter 包含块与 overflow 裁剪），主题表面/描边/阴影、开合动画、长列表主题滚动条。
- 选项带图标（全局🌐/工作区📁/视图）、选中项打勾＋主色高亮、悬停反馈、计数 hint、禁用项（未知工作区）置灰。
- 完整键盘导航：↑↓/Home/End/Enter/Space/Esc/Tab、字母定位（type-ahead）、`aria-haspopup/listbox/option/activedescendant`、焦点归还触发按钮、点击外部关闭、滚动/缩放自动重定位、近底自动向上翻转。
- 浮层继承主题变量（含深色分支）；「关闭动效」与 `prefers-reduced-motion` 同样作用于 portal 浮层（body 级类同步）。

## [0.7.0] - 2026-11-13

### 新增 Added
- 面板「记忆 / 设置」双标签。设置页四组（沿用记忆星丛视觉）：
  - **注入与召回**：autoInject 开关、注入字符预算滑杆（0–20000）；固定分类优先说明；总开关 enabled 仍由 profile 管理（关闭会卸载整个插件，故不入面板）。
  - **隐私护栏**：机密拦截展示为「始终启用」的安全护栏，不可关闭（密码/密钥/token 永不写入）。
  - **存储与备份**：数据目录（可复制）、存储占用（条目数＋字节）、自动备份开关、备份保留份数（1–30）、上次备份时间与份数、「立即备份」。
  - **面板偏好**：默认视图（全部/全局/工作区）、每页条数（20/50/100）、界面动效开关、相对时间开关。
- 设置持久化为数据目录 `settings.json` 覆盖层：profile 配置为基线、settings.json 覆盖其上，服务实时读取、改完即生效（防抖自动保存）、可手工编辑；「恢复默认」一键删除覆盖层。新增 `lib/settings.js`（集中校验/夹取）。
- 自动备份：开启后启动 5 秒首检、此后每小时检查，距上次备份超 24h 才导出全量到 `backups/` 并按保留份数裁剪最旧（仅删备份，不删记忆）。
- 新路由 `GET/POST /settings`、`POST /settings/reset`、`POST /backup`；`service.settings()/updateSettings()/resetSettings()/backup()/maybeAutoBackup()/recallConfig()`；系统提示装配改为实时读取 `recallConfig()`。
- 面板偏好实时生效：每页条数驱动分页、默认视图初始化作用域、动效开关（`dm_no_anim`）、相对时间开关切换卡片时间显示。`formatBytes` 纯函数单测。

## [0.6.0] - 2026-11-13

### 新增 Added
- 「记忆星丛 Memory Atlas」视觉 overhaul：靛紫渐变主色＋分类三色（偏好琥珀/事实湛蓝/决策翡翠）＋玫红警示；环境光晕背景、品牌徽章脉冲环、分类色轨卡片＋图标勋章、悬停浮起与分类色描边、卡片入场级联动画。
- 统计条：总数（衬线大数字）＋分类分布条＋分类计数筛选 chips（替代原下拉）＋全局/工作区计数；新增 `GET /stats` 路由与 `service.stats()`（全量过滤统计，不分页），`store.filterEntries` 与检索共用同一语义。
- 删除撤销：单条/批量删除后 6 秒内可在吐司中一键撤销（经 import 原样恢复 id/时间戳/来源）；吐司带图标、动作按钮与倒计时进度条。
- 批量选择：卡片悬停显示复选框，选中后浮出操作栏（已选 N 条 · 删除所选 · 取消选择），Esc 清除选择。
- 标签直达：卡片标签成为可点击 chips，点击即按该标签搜索。
- 相对时间（刚刚/N 分钟前/N 小时前/N 天前，超出 7 天回退日期），绝对时间悬停可见；`relativeTime` 纯函数单测覆盖。
- 骨架屏加载态、星座插画空态/无结果态（含清除筛选/新建 CTA）、吸顶毛玻璃工具栏、搜索图标与一键清空、`/` 快捷聚焦搜索、编辑器 Ctrl/⌘+Enter 保存与字数统计、分类单选卡片、自定义滚动条（页面与弹窗）。
- 深色主题分支跟随宿主 `body[data-ds-dark-theme]`；动效尊重 `prefers-reduced-motion`；窄屏响应式。

### 变更 Changed
- 编辑器分类由下拉改为三色单选卡片；删除确认文案改为「6 秒内可撤销」；导入预览改为三枚统计瓦片。

## [0.5.1] - 2026-11-13

### 修复 Fixed（UX 评审后的实证问题）
- 陈旧闭包覆盖列表：写入完成回调一律经 ref 调用最新的 `refreshEntries`，busy 期间修改搜索/过滤不再被旧结果覆盖。
- 删空末页自动回退一页，不再显示误导性空态；新建/导入成功后回到第一页，新条目立即可见。
- 焦点陷阱：busy（控件全禁用）时 Tab 不再逃逸到背景页；关闭弹窗时触发按钮已卸载则把焦点归还面板容器。
- 超大导入（>1 MB）返回 413 `body-too-large` 并有专门文案，不再误报「请求数据无效」；客户端选择文件时预检大小。
- 导入不再复用已被 global 占用的 id（`findEntry` 先查 global，避免后续按 id 更新/删除命中错误条目）。
- store 更新/移动的校验错误带 `invalid`/`no-workspace` code，路由正确映射 400 而非 500。

### 改进 Changed
- 未知路径工作区在工具栏下方给出说明（导出可达、如何手工修复索引），不再是无提示的死路。
- 导入预览全部重复时给出「无需导入」说明。

## [0.5.0] - 2026-11-13

### 新增 Added
- 存储元数据 `meta.json`（`schemaVersion: 1`、`createdAt`），首次写入时落盘、损坏时重建，为未来存储迁移提供锚点；`status` 路由与面板数据面随之上报 `schemaVersion`。
- 跨进程写锁 `lib/lock.js`（原子 mkdir 互斥、陈旧锁按 mtime 自愈、获取超时抛错）：`workspaces/index.json` 的读-改-写与批量导入的落盘阶段在多 profile/多进程并发下不再丢键、不再互相穿插。
- 面板条目详情：点击正文展开/收起（键盘可达），展开后显示创建/更新时间与来源会话，并可一键复制记忆 id（Clipboard API＋回退）。
- 双进程并发集成测试（保存与导入两个工作进程 fixture）。

### 变更 Changed
- `service.workspaces()` 仅识别 16 位十六进制目录键，锁目录与杂项目录不再混入工作区列表。

## [0.4.0] - 2026-11-13

### 新增 Added
- 检索相关度排序：内容命中×3、标签×2、分类/id×1；紧凑短语（CJK 相邻）+4、空格短语 +2；同分按更新时间倒序。空查询仍按更新时间列出。
- 注入分类优先：偏好→决策→事实，同级新者优先；紧预算下稳定用户指令（如语言偏好）不再被最新事实挤出。
- 面板分类过滤（全部/偏好/事实/决策）与分页（每页 50 条，多取一条探测下一页；过滤/切换作用域自动回第一页）。
- `offset` 分页参数贯通 store/service/entries 路由。

## [0.3.0] - 2026-11-13

### 新增 Added
- 跨作用域移动：`memory_update` 新增可选 `scope`，面板编辑弹窗可选作用域；global ↔ 当前工作区移动，目标已有相同内容时拒绝（`duplicate` / HTTP 409）；同作用域为纯 no-op。
- 导出/导入：面板一键导出全部记忆为 `dsh-memory-export` v1 JSON；导入先 dry-run 预览（新增/重复跳过/拒绝计数与原因），确认后落盘。逐条校验、机密硬拒、同内容去重（含批内）、保留原 id 与时间戳（id 被占用时自动新分配）。
- 新路由 `GET /export`、`POST /import`；新错误码 `duplicate`。

## [0.2.0] - 2026-11-13

### 新增 Added
- Web 管理面板：侧边栏「记忆」入口，浏览/搜索（300ms 防抖）/新建/编辑/删除（二次确认），全局与工作区切换；与 agent 工具共用同一服务层。
- 宿主命名路由 `/plugins/dsh-memory/{status,entries,workspaces,save,update,forget}`：仅回环可达，进程级 token，写操作校验 `X-RPC-Key`。
- TDD 四缝架构（service/store/routes/client 纯逻辑），36 项测试。

## [0.1.0] - 2026-11-13

### 新增 Added
- 首个版本：四个记忆工具（`memory_save`/`memory_search`/`memory_update`/`memory_forget`）。
- Markdown＋frontmatter 一事一文件存储（`~/.dsh/.dsh-memory/`），原子写，手工编辑立即生效。
- 系统提示注入：指引＋字符预算内召回（`interpolate: false` 保护用户内容）。
- 隐私护栏：密码/密钥/token 规则检测硬拒写。

[0.24.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/PinBoDHua/dsh-memory/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/PinBoDHua/dsh-memory/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PinBoDHua/dsh-memory/releases/tag/v0.1.0
