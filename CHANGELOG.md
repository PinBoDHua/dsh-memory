# Changelog — dsh-memory

本项目的所有重要变更都记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here. Format follows Keep a Changelog; versions follow SemVer.

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
