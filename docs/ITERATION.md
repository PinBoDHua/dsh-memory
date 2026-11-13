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
| `scripts/gui-check.mjs` | 真实浏览器面板：过滤请求参数、下拉键盘、弹窗 Esc 草稿 | `--url=`；Edge headless + CDP；cookie 由 `<DSH_HOME>/.credentials.yaml` 自签；只读＋可逆操作 |

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
- [ ] **`detectSecret` 只查 content**：tags 可绕过机密硬拒。

### P2 性能

- [ ] **批量导入 O(N×M) 读放大**：每条仍 `listScope` 全量重读做内容去重（id 占用已改为一次扫描）；预读一次建 `normalizeContent → id` Map。
- [ ] **热路径重复全量读盘**：`searchDetailed`/`stats` 各读两遍、每次系统提示装配全量读；按 `路径+mtime+size` 缓存解析结果（保留手工编辑即时生效），面板两个查询各读一遍。

### P3 客户端健壮性

- [ ] **fetch 无超时/无取消**：请求挂起时首屏骨架或全局 busy 永久卡死；`AbortSignal.timeout` + 超时文案 + `finally` 清理。
- [ ] **删除失败路径**：批量删除部分失败后不刷新列表、不给撤销（`writeFailure` 吞错）；`allSettled` 后仍刷新并对成功项给撤销。
- [ ] **设置保存一致性**：服务端夹取值不回收（输入 0 实际存 1）、`backupNow` 触发的 `loadSettings` 会覆盖防抖窗内草稿、保存失败仍显示「已保存」。
- [ ] **批量选择与列表刷新同步**：选中的条目被归档/过滤消失后浮栏仍显示，点「删除所选」静默无操作。
- [ ] **撤销 toast 被后续 toast 覆盖**：6 秒删除撤销可能被任意其它操作挤掉。
- [ ] **标签数量/长度**：客户端无 12 个上限/64 字符提示与去重，服务端静默截断。
- [ ] **设置页加载失败永久骨架**：`loadSettings` catch 为空、无重试；召回预览旧响应可覆盖新响应。
- [ ] **WAI-ARIA Tabs 模式**：`role=tablist/tab` 无 `aria-controls`/roving tabIndex/方向键，面板无 `role=tabpanel`。

### P4 边角

- [ ] `GET /entries?scope=bogus`、`/stats?scope=bogus` 返回 500 而非 400（store 抛无 code 的 Error）。
- [ ] `update` 不刷新 workspaces/index.json 的 `lastSeen`。
- [ ] `workingDirectory` 在 `apply` 时一次性捕获；若服务晚于插件就绪则永久回退 header cwd（待运行时验证，修法为 `cwdOf` 内每次 `ctx.get`）。
- [ ] 详情里 `last_access`/`hit_count` 等展示与检索命中语义核对（注入命中是否也应簿记，文档与实现口径对齐）。
- [ ] 命中簿记迁移到独立 `access.json` 账本（`withLock` 保护），彻底消除单条文件读-改-写窗口与写放大。

### 明确不做

dreaming/后台 LLM 提取、向量/图检索、完整 bi-temporal 四时间戳、git 版本化存储、画像 slots、回收站、默认 TTL、跨工作区移动（global↔当前工作区之外的组合）、会话级记忆开关。