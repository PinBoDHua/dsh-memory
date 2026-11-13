# Changelog — dsh-memory

本项目的所有重要变更都记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here. Format follows Keep a Changelog; versions follow SemVer.

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

[0.7.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/PinBoDHua/dsh-memory/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PinBoDHua/dsh-memory/releases/tag/v0.1.0
