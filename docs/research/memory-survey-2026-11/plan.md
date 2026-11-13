# dsh-memory 0.9.0 实施计划（待 Q18 最终确认）

依据：[decisions.md](decisions.md)（17 项定案）· [report.md](report.md)（精华/糟粕对照）· [baseline.md](baseline.md)（v0.8.1 现状）· [host-capabilities.md](host-capabilities.md)（宿主能力）
原则：外科手术式改动、简单优先、测试驱动；新字段全部可选，旧数据零丢失（Q3）；零额外模型调用（Q7）；纯本地（Q8）；不自动物理删除（Q9）。

## 1. 数据层（lib/store.js · schemaVersion 1→2）

新增 frontmatter 字段（全部可选，缺省即旧行为）：
- `origin`: manual|auto（默认 manual；现有条目一律视为 manual）
- `supersedes`（新条目指向旧 id）/ `superseded_by` + `superseded_at`（旧条目被标记）
- `expires`: YYYY-MM-DD（UTC、当日含；坏日期 fail-open 不隐藏）
- `pinned`: bool=false；`archived`: bool=false
- `last_access`: ISO；`hit_count`: int=0（衰减簿记）

迁移：首次加载 meta.schemaVersion<2 → **强制备份一次**（即使 autoBackup 关）→ 写 schemaVersion=2；**不逐文件改写**（读取时懒缺省）；v1 fixture 无损测试守护。
隐藏态定义：superseded_by 非空 ∨ expires<今天 ∨ archived → 默认排除出注入与检索（可 include_* 找回，可逆）。

## 2. 工具面（index.js · 扩展现有 4 工具，Q17）

- memory_save：+origin（默认 manual）、+supersedes（id 必须存在，否则 invalid）、+expires、+pinned
- memory_update：+supersedes、+expires（空串清除）、+pinned、+archived（true 归档/false 恢复）
- memory_search：+include_superseded/include_expired/include_archived（默认 false）；输出追加状态字段（additive 向后兼容）
- memory_forget：不变（永久删除仅用户显式；UI 6 秒撤销照旧）
- 去重规则微调：同内容去重只针对未取代条目（允许「save 新＋supersedes 旧」的修正流）
- GUIDANCE v2（lib/render.js）：写入纪律（代码可推导/已有/短期任务指令不存；敏感话题默认不存）；origin 规则（主动沉淀=auto，用户显式=manual）；JIT 验证（依赖前可廉价核对则核对，过时用 update/supersedes 修正）；信息变化走取代链而非并存矛盾
- guard.js：机密模式扩充（私钥块/带口令连接串/bearer token 等），控误报，新增测试

## 3. 衰减与命中（Q9/Q16 · 参数首次明示）

- 命中=被 search 返回或被注入；回写 last_access/hit_count，**同条目节流 ≤1 次/小时**（避免每步装配高频写盘）
- 乘子 = clamp(1.5 − 0.15×weeks_idle, 0.3, 1.5)；weeks_idle=floor(距 last_access 天数/7)，从未访问回退 updated
- 作用于检索排序与注入分类内排序；**永不过滤**；pinned 免衰减；decayEnabled=false 回退现状（updated 倒序）
- 注入顺序：pinned 最先（分类优先＋updated 倒序）→ 非 pinned 按分类优先、类内乘子倒序（同分 updated 倒序）；字符预算与超限跳过计数语义不变

## 4. 检索增强（Q8 · store.js）

- 保留空格词 AND 语义；CJK 词支持 bigram 模糊匹配（覆盖率 ≥0.6 算命中；精确子串仍命中）
- 评分=现有权重（内容×3/标签×2/分类·id×1/短语加分）×衰减乘子＋pinned 小幅 boost；**boost 不扩召回集合**
- 新增中文用例：精确/模糊/中英混合/空查询/隐藏态过滤

## 5. 自动提取提示（Q2/Q7/Q13 · index.js）

- 注册 ctx.systemPrompt.context()；**特性检测**：宿主无此 API 则静默跳过（GUIDANCE 仍生效，engines 声明不变）
- 状态：内存 Map 按 session.id（回合计数、距上次记忆写入回合数）；监听 turn/end 计数、tools/result 观察 memory_save/update 清零；session/disposed 清理
- 条件：autoExtractHint 开 ∧ 距上次写入 ≥3 回合 → 静态提示文本（不含回合数，避免快照频繁变化）；写入后清空快照
- 零额外模型调用；提示进入下一个被准入步骤
- **API 已经宿主源码文档核实**（dsh/docs/subsystems/system-prompt.md）：`ctx.systemPrompt.context({name, order, text, interpolate?, required?})`；text 可为 provider 函数，装配与准入刷新（refreshContext）时重读；**空文本=无贡献**（以此清空快照）；重名注册抛错；agent.ctx 作用域注册影子全局；interpolate:false 保留字面量；快照仅在变化时落盘。运行时行为仍以交付时 live 验证为准

## 6. 设置（lib/settings.js＋客户端设置页）

- 新增 overlay 键：autoExtractHint=true、decayEnabled=true（热更新沿用现有机制；恢复默认覆盖新键）
- 设置页「注入与召回」组加两个开关，文案 zh/en

## 7. UI（client/client.js · 扩展记忆星丛，Q14）

- origin 徽章（auto/manual）＋来源筛选；状态筛选（活跃/被取代/已过期/已归档/已钉选）
- 条目行：钉选快捷操作、归档/恢复；被取代显示后继链接、已过期显示日期
- 编辑弹窗：pinned 开关、expires 日期输入（可清除）
- 详情展开：origin/last_access/hit_count/取代链；统计条加状态计数
- 一键撤销复用现有删除＋6 秒撤销；zh/en 内联文案、--dsw-alias-* 令牌、无障碍与现有一致

## 8. cwd 口径对齐（Q11 · DETAIL 局限 #7）

- 面板「当前工作区」改用会话**有效**目录（与工具一致）；实施时读 client.js 现状确定最小改法（宿主侧经现有会话接口/路由字段提供有效 cwd），回退初始目录

## 9. live 验证脚本（Q11 · scripts/live-check.mjs）

- 端口参数化（--port/env）；回环＋GET status 取 token＋写操作 X-RPC-Key
- 覆盖：status（断言 version=0.9.0、schemaVersion=2）/entries CRUD 往返/search 新过滤/settings get·post·reset/backup/export/import dry-run/workspaces/stats
- 客户端分发 rev：属主包已定位为 dsh-client-modules；subsystem 文档证实 rev 输入＝entry 的 mtimeMs/ctimeMs/size（ClientArtifactBaseline，不做内容哈希），路由契约＝过期/篡改 rev 答 404；精确 framing 沿用既往 live 验证过的 framedHash('plugin-artifact', …) sha1 前 12 位，交付时由 live 脚本实证（计算 rev → GET /plugins/??dsh-memory/client.js&rev=<rev> 断言 200 且含新代码），如需可从其 src/index.ts 复核
- 输出通过/失败摘要，失败非零退出

## 10. 测试与交付（Q6/Q15）

- node --test tests/*.test.mjs 全绿：现有 94＋新增（迁移无损/取代链/过期含坏日期/衰减乘子/访问节流/CJK 检索/guard 新模式/settings 新键/client 纯逻辑）
- package.json 0.9.0；CHANGELOG 0.9.0（**明示 search/注入默认语义变化**）；README/DETAIL 同步（局限清单更新：#2 衰减、#3 自动记录已系统化）
- 交付：remove_bundle(dsh-memory) → install_bundle(D:\Questions\dsh-memory) → live-check → rev 验证 → git 提交（仓库身份 PinBoDHua）→ 经 127.0.0.1:7897 代理推送
- 风险守护：context() API 契约已经源码文档核实（§5），运行时行为仍随交付 live 验证；rev 输入已经宿主文档证实、framing 交付时 live 脚本实证（§9）；取代链默认隐藏语义在工具描述/CHANGELOG 明示并提供 include_* 兜底

## 11. 明确不做（本轮）

dreaming/后台 LLM、向量/图检索、完整 bi-temporal 四时间戳、git 版本化存储、画像 slots、显式投票工具、回收站、默认 TTL 自动过期、会话级别记/别用开关、类别扩展、路径级 glob 触发、跨工作区移动/导入登记/未知工作区修复入口（Q11 保持现状）。
