# Changelog — dsh-memory

本项目的所有重要变更都记录在此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here. Format follows Keep a Changelog; versions follow SemVer.

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

[0.5.1]: https://github.com/PinBoDHua/dsh-memory/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PinBoDHua/dsh-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PinBoDHua/dsh-memory/releases/tag/v0.1.0
