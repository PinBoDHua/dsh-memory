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
- [x] **命中语义口径对齐**（0.24.6）：明确检索命中写 `last_access`/`hit_count`，注入不写盘；DETAIL 已修正。
- [x] **机密检查只查正文**（0.24.6）：正文＋标签统一硬拒。
- [ ] **命中簿记迁移到独立 `access.json` 账本**（`withLock` 保护），彻底消除单条文件读-改-写窗口与写放大；届时可评估是否让注入命中以每小时节流方式入账。

### 新审计（可选）

P1–P4 清空后做一次新的双端只读审计（宿主 `index.js`＋`lib/*`、客户端 `client/client.js`、DSH 宿主契约）补充 backlog；每轮一个可验证增量。

### 明确不做

dreaming/后台 LLM 提取、向量/图检索、完整 bi-temporal 四时间戳、git 版本化存储、画像 slots、回收站、默认 TTL、跨工作区移动（global↔当前工作区之外的组合）、会话级记忆开关。