# Agent 平台记忆功能调研 · 汇总报告
## ——dsh-memory 升级「去其糟粕，取其精华」对照与候选特性包

日期：2026-11-13 · 对象：dsh-memory v0.8.1 · 状态：第 1–4 轮已定案（B1–B4 采纳、C1/C2 缓行，见 decisions.md），第 5 轮进行中

---

## 0. 方法与核实状态

- **范围**（Q4 确认）：消费级助手 4（ChatGPT/Claude/Gemini/Microsoft Copilot）＋编码 Agent 5（Cursor/Windsurf/Cline/Claude Code/GitHub Copilot）＋记忆框架 6（Mem0/Letta/Zep-Graphiti/LangMem/Memobase/Supermemory），共 15 个对象。
- **来源纪律**：仅官方一手来源（官方帮助中心/博客/文档仓库/arXiv）；严禁 routify 等代理替换；官方重定向跟随至现址并记录。三份分部报告引用域名审计全部通过：part1 53 条、part2 191 条、part3 155 条，无代理域名。
- **lead 复核记录**（关键论断原文重验）：
  - ✅ Mem0 v3 single-pass ADD-only＋MD5 去重＋图记忆移出 OSS：[官方迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)证实（自报 LoCoMo 71.4→91.6、LongMemEval 67.8→93.4；part3 引 README 为 92.5/94.4，属厂商口径差异，均不作设计依据）。
  - ✅ Letta V1 server 退役、活跃开发转 letta-code：[官方 README](https://raw.githubusercontent.com/letta-ai/letta/main/README.md)证实。
  - ✅ Copilot Memory 投票/过期语义（upvote 续期、检索不续期、默认 90 天、repo facts 可配 7–180 天、downvote 过阈值停用、secrets/模型控制 token 拒存、JIT citation 验证、票数不展示）：[github/docs 官方仓库 raw](https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/prompting-and-context/copilot-memory.md)证实。
  - ❌ Gemini：support.google.com/gemini.google.com 本环境网络层不可达（子代理 ≥9 次＋lead 用报告所列真实官方 URL 重试均失败），blog.google 正文动态渲染仅标题可核。**维持「未能核实」，不用代理绕行**。
- **未能核实清单**（不编造、不采信第三方）：Gemini 机制细节；Cursor 原生 Memories 的 sidecar/审批/生成提示词（原文档页已下线）及下线公告；Anthropic 工程博客（重定向链失败，Claude Code 事实已由 code.claude.com 官方文档核实）；ChatGPT Dreaming 博客正文（标题/日期已核）；Copilot 2026-03 默认开启 changelog 条目。
- **厂商基准**：全部自报、预算/模型不同不可横比（糟粕 #5），本报告不以其作设计依据。
- 分部详情：[part1 聊天助手](part1-chat-assistants.md) · [part2 编码 Agent](part2-coding-agents.md) · [part3 记忆框架](part3-memory-frameworks.md) · [现状基线](baseline.md) · [宿主能力](host-capabilities.md) · [决策日志](decisions.md)

## 1. 已定决策约束（grilling 第 1–3 轮，11 项）

| 约束 | 内容 |
|---|---|
| Q1 | 对标补齐核心体验缺口 |
| Q2 | 自动提取可控可撤销：来源标记＋UI 审阅＋一键撤销 |
| Q3 | 数据无损兼容＋自动迁移 |
| Q5 | 改动仅限插件仓库 |
| Q6 | 完整交付流程（重载→live 验证→提交推送） |
| Q7 | **零额外模型调用**（无 sidecar/后台 LLM） |
| Q8 | **纯本地轻量检索**（无 embedding/向量/图库） |
| Q9 | **衰减＋归档，不自动物理删除** |
| Q10 | 保持 home 级共享（全局跟人、工作区按 cwd） |
| Q11 | 只修 cwd 口径＋沉淀 live 脚本，其余短板保持现状 |

## 2. 平台景观速览（一句话现状）

| 平台 | 2026-11 现状要点 |
|---|---|
| ChatGPT | saved memories＋reference chat history 双轨；Sources 可溯源可纠正；敏感信息可能被静默记忆（官方自认） |
| Claude | 项目级记忆＋可编辑 topic summary 即时生效；敏感话题默认排除；Pause/Reset 二分；记忆导入导出（实验性） |
| Gemini | 仅标题级可证：Temporary Chats、历史聊天个性化、Saved info；细节未能核实 |
| Copilot（消费/M365） | 自动合并/更新/移除＋检测即询问；工作版记忆存 Exchange 隐藏文件夹；关闭≠删除语义跨版本不一致 |
| Cursor | 原生 Memories 文档已静默下线（Rules 成唯一持久化指令机制）；现行 memory=Agent SDK journal hook（全体用户共享一个 journal，官方自认隐私风险） |
| Windsurf | Cascade 已 legacy（Devin Local 无 memories）；自动 memories 免费、workspace 隔离、事后编辑无审批；知识无法迁入新 agent |
| Cline | Memory Bank=提示词方法论（6 个结构化 md＋显式读写仪式）；每任务全读，上下文成本线性增长 |
| Claude Code | CLAUDE.md 四级层级＋auto memory（MEMORY.md 索引前 200 行/25KB 常驻＋topic 文件按需读）；跳过代码可推导内容；冲突无确定性优先级（官方自认） |
| GitHub Copilot | Memory GA（2026-10-28）：repo facts/user prefs 双类型；citations＋JIT 验证；投票＋90 天过期；Dreaming 离线整理（preview，按运行计费） |
| Mem0 | v3 转向 ADD-only＋哈希去重＋检索端消歧；Decay 0.3–1.5× 软偏置；Expiration 到期隐藏不删；Dream Supersede/Merge 非破坏性；图记忆收归 Platform |
| Letta | V1 归档；MemFS=agent 自有 git 仓库投影 Markdown 记忆块；根文件常驻＋MEMORY.md 路标按需读；dreaming=sleep-time 后台整理（额外 LLM） |
| Zep/Graphiti | bi-temporal 四时间戳＋边失效不删除（最严谨时间语义）；必须图库＋嵌入＋多次结构化 LLM；参考服务器无鉴权、遥测默认开 |
| LangMem | semantic/episodic/procedural 三分＋collection/profile 二分；存储无关纯函数；strength=recency+frequency 设计指导；无内建衰减 |
| Memobase | 画像 slots＋事件时间线；buffer 批处理固定 3 次 LLM 调用；blob 处理完即删；维护放缓 |
| Supermemory | static/dynamic 双层画像；显式自动遗忘过期事实；本地单二进制＋本地嵌入；v3/v4 API 2026-12-31 关停（churn 风险） |

## 3. 精华对照表（已按第 1 节约束过滤）

「本轮」列：✅=已定决策的实现项（不再重问）；🔲=第 4 轮候选（Q12）；⏭=明确本轮不做。

| # | 机制 | 来源 | dsh-memory 现状 | 动作 | 代价 | 本轮 |
|---|---|---|---|---|---|---|
| 1 | 自动提取＋来源标记＋可审阅可撤销 | ChatGPT/Claude/Copilot/Windsurf（事后编辑路线） | 仅 GUIDANCE 约定，无 origin 标记 | origin=auto/manual 字段＋来源会话＋触发机制（Q13）＋审阅 UI（Q14）＋一键撤销 | 低 | ✅ |
| 2 | 写入纪律：代码可推导不存、已有不存、短期任务指令不存、敏感默认排除 | Claude Code/Claude/Copilot | guard.js 仅机密硬拒 | GUIDANCE 升级＋guard 模式扩充（零模型成本） | 低 | 🔲B4 |
| 3 | JIT 验证：依赖记忆前廉价核对，过时即更新 | Copilot（检索难、验证易的不对称性） | 无 | GUIDANCE 增加「依赖前可廉价验证则验证，过时用 memory_update 修正」 | 低 | 🔲B4 |
| 4 | 取代链：失效不删除、默认读最新、历史保留 | Mem0 Dream/Zep 边失效/Copilot 修正版 | update 直接覆盖、无历史 | supersedes/superseded_by 字段＋默认过滤＋UI 历史视图 | 低–中 | 🔲B1 |
| 5 | 可选过期：到期隐藏不删、可逆、坏日期 fail-open | Mem0 Expiration/Copilot expiry | 无 | expires 字段（仅显式设置，**无默认 TTL**）＋读取过滤＋恢复 | 低 | 🔲B2 |
| 6 | 软衰减＋命中反馈：永不过滤、可逆 | Mem0 Decay（0.3–1.5×）/LangMem strength | 排序仅分类＋updated | 访问簿记（last_access/hit_count≤20）＋乘子融入评分＋设置开关 | 低 | ✅ |
| 7 | 归档：手动、可恢复、不物理删 | Q9 决策/Zep non-lossy 哲学 | 无 | archived 状态＋默认隐藏＋UI 恢复 | 低 | ✅ |
| 8 | 钉选常驻：核心记忆预算内必注入 | Letta core blocks/Claude Code MEMORY.md/Cursor alwaysApply | 分类优先＋预算装填 | pinned 标志，预算内最先注入、免衰减 | 低 | 🔲B3 |
| 9 | 两层注入：索引常驻＋细节按需 | Claude Code（200 行/25KB 硬上限）/Letta 路标 | 预算装填＋超限计数提示 search | 已具雏形；超预算条目可注入紧凑索引行（id＋首行）作可选优化 | 低 | ⏭（并入渲染微调） |
| 10 | 检索增强：CJK 分词＋多信号评分＋boost 不扩召回 | Mem0 v3/LangMem（相似度+重要性+强度） | AND 关键词＋简单评分（已有 CJK 短语加分） | 中文 bigram 分词＋recency/hit 强度融合评分 | 低–中 | ✅ |
| 11 | 溯源：来源会话可查 | ChatGPT Sources/Zep episode | source 会话 id 已存、详情已展示 | origin 徽章＋筛选（并入 #1） | 低 | ✅ |
| 12 | 暂停/删除语义清晰 | Claude Pause/Reset（反面：Copilot/ChatGPT） | enabled/autoInject/forget 已较清晰 | 文档与 UI 文案核对「暂停≠删除」 | 低 | ✅（并入 UI） |
| 13 | 导入导出 | Claude 跨 AI 迁移 | JSON 导出/导入 dry-run 已有 | 无缺口 | — | 已有 |
| 14 | 作用域隔离 | 全平台 | global/workspace 已有 | 无缺口（Q10 保持 home 共享） | — | 已有 |
| 15 | cwd 口径对齐 | DETAIL 局限 #7 | 面板取初始目录、工具取有效目录 | 对齐会话有效目录 | 低 | ✅（Q11） |
| 16 | live 验证脚本化 | 仓库缺口（9 项检查全手工） | 无脚本 | 可重复运行脚本 | 低 | ✅（Q11） |
| 17 | 会话级「别记/别用」开关 | ChatGPT/Claude/Copilot temporary | 无 | 每会话状态＋注入隔离 | 中 | 🔲C1（不建议） |
| 18 | 类别扩展 procedural/feedback | LangMem/Claude Code 四类 | preference/fact/decision | 枚举＋UI＋注入优先级变更 | 中 | 🔲C2（不建议） |
| 19 | 显式投票工具 | Copilot vote_memory | 无 | 新工具＋计数（隐式命中已够；Copilot 票数不透明是糟粕） | 中 | ⏭ |
| 20 | git 版本化/画像 slots/实体共现链接/dreaming/路径级 glob 触发 | Letta/Memobase/Mem0/各 | — | 或违 Q7/Q8，或简单优先 | 中–高 | ⏭（记入未来方向） |

**衰减哲学注记**：Mem0 按「访问」强化（检索即续命），Copilot 按「显式 upvote」强化（检索不续期，防僵尸记忆）。本插件采 **Mem0 式隐式命中**（Q9「长期未命中降权」），零 LLM、纯簿记；Copilot 式显式投票本轮不做（#19）。Copilot「downvote 过阈值后闲置即物理删除」与 Q9 冲突，**不采纳**。

## 4. 糟粕 → 本插件设计红线

| # | 糟粕（来源） | 本插件红线 |
|---|---|---|
| 1 | 写入端 LLM diff 两调用管线（Mem0 自己已放弃） | Q7 零额外调用；写入只做规则去重 |
| 2 | 物理删除被矛盾/过时记忆（Zep/Mem0/Letta 均走向失效保留；Copilot downvote 删除是偏离） | 取代/过期/归档全部可逆；forget 仅用户显式 |
| 3 | 重型服务栈：图库/嵌入/后台 LLM（Graphiti/Letta V1） | Q8 纯本地；Markdown 文件路线已被 Letta Code 验证 |
| 4 | 只追加不治理（Mem0 ADD-only 自认 contradiction 35.7） | 追加必须与衰减/取代/过期成对落地 |
| 5 | 静默自动记忆敏感信息（ChatGPT 官方自认） | 敏感默认排除＋origin 标记＋可撤销 |
| 6 | 关闭≠删除语义混乱（Copilot 跨版本/ChatGPT 删聊天≠删记忆） | 暂停（autoInject/enabled）≠删除（forget）；文档明示 |
| 7 | 排序黑箱（Copilot 票数故意不展示、单条不可编辑） | UI 展示 pinned/衰减/过期/取代状态与理由；单条可编辑 |
| 8 | 每任务全读记忆（Cline） | 字符预算＋按需 memory_search |
| 9 | 跨用户/会话共享泄漏（Cursor journal 官方自认） | 作用域隔离＋auto 记忆绑定来源会话 |
| 10 | 押注厂商 OSS 路线图（Mem0 收走图记忆/Supermemory API 关停/Cursor Memories 静默下线/Windsurf 换代断档） | 机制自主可控；数据可导出（已有）；功能下线必须留迁移出口 |
| 11 | 把记忆当强制配置（各平台官方均否认保证遵从） | 硬约束走 guard；记忆只承载偏好/事实 |
| 12 | 默认遥测＋无鉴权参考服务器（Graphiti） | 保持回环＋进程 token；无遥测 |
| 13 | 过度提取（LangMem 明示精度下降） | 写入纪律 GUIDANCE：蒸馏事实而非转录 |
| 14 | 检索=单一向量信号（Mem0/Zep/LangMem 均多信号） | 本地多信号：关键词＋标签＋短语＋新近＋命中强度 |
| 15 | 静默截断不告知（Claude Code 索引超限写入仍成功） | 保持超限跳过计数＋提示 |

## 5. 候选特性包（第 4 轮 Q12–Q14）

**已定实现项**（Q2/Q8/Q9/Q11 的落地，不再重问）：
- A1 自动提取闭环：origin 字段＋来源会话＋GUIDANCE 升级＋触发机制（Q13）＋审阅 UI（Q14）＋一键撤销
- A2 命中反馈＋软衰减（0.3–1.5× 乘子、永不过滤、可逆、可关）
- A3 归档状态（手动、可恢复）
- A4 检索增强（中文 bigram 分词＋多信号评分融合）
- A5 cwd 口径对齐；A6 live 验证脚本

**推荐新增**（Q12 前四项，全部低成本纯本地、与 11 项约束兼容）：
- B1 取代链（supersedes/superseded_by，默认读最新，历史保留可查）
- B2 可选过期日（仅显式设置、无默认 TTL，到期隐藏不删、可逆）
- B3 钉选常驻（pinned 预算内必注入、免衰减）
- B4 隐私＋写入纪律增强（敏感默认排除/可推导不存/JIT 验证提示/guard 模式扩充）

**可选、建议缓行**（Q12 后两项）：C1 会话级别记/别用开关；C2 类别扩展。

**明确本轮不做**：dreaming/后台 LLM、向量/图检索、完整 bi-temporal 四时间戳（取代链覆盖其八成价值）、git 版本化存储、画像 slots、显式投票工具、回收站、默认 TTL 自动过期、路径级 glob 触发。

**版本与迁移预案**（第 5 轮确认）：0.9.0；schemaVersion 1→2；新 frontmatter 字段全部可选→旧文件无需改写即可读（无损兼容 Q3）；meta.json 迁移锚点＋迁移前自动备份。

## 6. 风险与开放项

1. Gemini 细节未核实——不阻塞：其标题级机制与 ChatGPT/Claude 同族，候选包不依赖 Gemini 独有设计。
2. context()/inject() 提醒机制的实际快照行为需 live 验证（host-scan 为文档侦察，未 live 验证）。
3. 中文 bigram 分词的召回/精度平衡需用现有 94 测试＋新增用例守护。
4. 取代链的「默认读最新」改变 memory_search 语义——需在工具描述与 CHANGELOG 明示，并提供 include_superseded 参数兜底。
5. 自动提取依赖主 agent 遵循指引（各平台官方均不保证遵从）——origin 标记＋审阅 UI 是兜底，而非假设模型永远正确。

---

*汇总完。分部报告与基线/宿主/决策文件见 §0 链接；所有官方引用 URL 均经域名审计，关键论断经 lead 原文复核。*
