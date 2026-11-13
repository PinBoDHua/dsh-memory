# Agent 记忆框架核心机制调研（Part 3）

- **调研日期**：2026-11-13（所有官方页面均于当日实际抓取核实）
- **调研方法**：仅使用真实官方一手来源（官方文档站、官方 GitHub 仓库及其 raw 内容、arXiv 官方论文页、GitHub 官方 API）。未使用任何临时代理/镜像地址；未依赖二手转述。每条结论附来源链接。
- **核实状态说明**：
  - 下文所有机制描述均来自当日成功抓取的官方原文。
  - 各厂商自报的 benchmark 数字（Mem0、Supermemory、Memobase、Zep 论文）按「厂商声明」记录，未独立复现；跨厂商数字因检索预算/模型不同不可直接比较（Mem0 官方评估文档自己也强调这一点，见 [Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）。
  - Letta V1 时代的具体记忆工具函数名未在本次抓取的官方页面中逐一列出，故只描述机制、不臆造函数名。
- **重要时效发现**：Mem0 与 Letta 在 2025→2026 年间都发生了架构级变化（Mem0 放弃论文中的两阶段 UPDATE/DELETE 管线；Letta V1 服务器归档、转向 git 化的 MemFS）。引用旧论文结论时必须注意与当前产品状态的差异，下文分别标注。

---

## 0. 总览速览

| 框架 | 记忆模型 | 写入决策 | 检索 | 时间语义 | 重型依赖 |
|---|---|---|---|---|---|
| Mem0（2026 现状） | 事实条目 + 实体链接（SQL/向量/实体三存储） | 单次 LLM 调用、ADD-only | 语义+BM25+实体+时间 多信号融合 | 写入时抽取时间元数据，检索时软加分 | OSS 需向量库+嵌入；图记忆仅 Platform |
| Letta（现 Letta Code） | git 版本化 Markdown 记忆文件系统（MemFS）+ memory blocks | agent 用普通文件工具自编辑；dreaming 后台整理 | 默认文件树+按需读取，无向量索引 | git 历史 + 会话压缩 | 几乎无（本地 git 即可）；语义搜索为可选 mod |
| Zep / Graphiti | 时序知识图谱：episode/entity/community 三层 | 多次 LLM 结构化抽取+消解+边失效 | 语义+BM25+图遍历，多种 reranker | bi-temporal 四时间戳，边失效不删除 | 图数据库（Neo4j/FalkorDB/Neptune）+嵌入+多次 LLM 调用 |
| LangMem | 语义/情景/程序三类记忆；collection 或 profile | hot path 工具 或 background manager（LLM 决定增删并） | LangGraph BaseStore：语义+元数据过滤 | 无内建 bi-temporal；强调 recency/frequency「强度」 | 核心零存储依赖；持久化需 LangGraph store+嵌入 |
| Memobase | 用户画像 slots（topic/sub_topic）+ 事件时间线 | 缓冲区批处理，固定 3 次 LLM 调用 | 画像直读（SQL，<100ms）+事件搜索 | 事件时间线 | Postgres+Redis+LLM |
| Supermemory | 自研 temporal vector-graph 引擎 + 用户画像 | 「learning model」+ dreaming（dynamic/instant） | 混合 RAG+记忆单查询 | 事实过期自动遗忘、矛盾消解 | 云为主；本地单二进制（内嵌引擎+本地嵌入） |

---

## 1. Mem0

> 来源：[arXiv 2504.19413](https://arxiv.org/abs/2504.19413)（论文，2025-04-28 提交）、[论文 HTML 全文](https://arxiv.org/html/2504.19413v1)、[官方 README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)、[docs.mem0.ai](https://docs.mem0.ai/core-concepts/how-it-works.md)。
> **版本警示**：论文描述的是 v2 两阶段管线；2026-04 起官方推出「New Memory Algorithm」（v3）， extraction 改为 **ADD-only 单次调用**，图记忆从 OSS 移除、改为 Platform 内建。两者差异极大，分别记录。

### 1.1 记忆模型与存储
- 记忆 = 从对话中蒸馏出的**事实条目**（非逐字转录）；`infer=False` 可存原始内容。按 `user_id`/`agent_id`/`run_id`（Platform 另有 `app_id`）+ metadata 划分作用域。（[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works.md)）
- 三层存储：**SQL 数据库**（事实+元数据，source of truth；Platform 上还存 ADD 事件历史日志与滚动消息窗口）、**向量数据库**（嵌入）、**实体存储**（实体+嵌入+关联记忆 ID）。OSS 自选自运维后端；Platform 全托管。（[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works.md)、[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
- 论文版 Mem0^g：有向带标图 G=(V,E,L)，节点=实体（类型+嵌入+创建时间戳），边=关系三元组；实现用 **Neo4j**。（[论文 §2.2](https://arxiv.org/html/2504.19413v1)）
- 现状：OSS v3 **不再有图记忆**（`enable_graph`/`graph_store` 及 Neo4j/Memgraph/Kuzu/Apache AGE/Neptune 驱动约 4000 行代码被移除）；Platform 的 Graph Memory 为内建、常开、无需外部图库，实体为节点、**共享实体的记忆互连**（共现推断，**无类型化关系边**，不记录 "manages" 之类标签）。（[OSS v2→v3 迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[Graph Memory](https://docs.mem0.ai/platform/features/graph-memory.md)）

### 1.2 写入与更新决策管线
- **论文版（v2，两阶段）**：
  1. **Extraction**：新消息对 (m_{t-1}, m_t) + 上下文（异步刷新的会话摘要 S + 最近 m=10 条消息）→ LLM 抽取候选事实集 Ω。
  2. **Update**：对每条候选事实，向量检索 top-s=10 相似既有记忆，连同候选事实交给 LLM 通过 **tool call 决策 ADD / UPDATE / DELETE / NOOP**（无独立分类器，直接用 LLM 推理选择操作）。实验用 GPT-4o-mini。（[论文 §2.1](https://arxiv.org/html/2504.19413v1)）
- **现行版（v3，2026-04 起）**：**single-pass ADD-only**——取 top-10 相关既有记忆作去重上下文 → **一次 LLM 调用**抽取全部新事实 → 批量嵌入 → **MD5 哈希去重** → 批量写入 → 实体抽取。不再产生 UPDATE/DELETE 事件；信息变化时新旧事实并存，靠检索排序让「当前正确」的浮出。官方理由：把模型容量用于理解输入而非与既有状态做 diff；抽取延迟约减半。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)）
- Platform 另有 **Dream** 后台层补一致性：**Supersede**（矛盾时标记旧事实为 superseded 并链接新事实）与 **Merge**（重复折叠为 canonical）随 add 自动运行、全套餐常开；**Synthesis**（蒸馏高阶 pattern memories）为 Pro+ 可选、定时后台跑。三者均**非破坏性**。（[Dream](https://docs.mem0.ai/platform/features/dream.md)）
- 写入侧还有独立的 **temporal reasoning pass**：对照源对话与日期抽取时间元数据（事件发生时间、进行中/已完成、时间精度、记忆类型 event/state/plan/preference/relationship/absence），可异步执行不阻塞写入。（[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）

### 1.3 检索与排序
- v3 多信号混合：查询预处理（词形还原、实体抽取）→ **语义向量、BM25 关键词、实体匹配**并行打分 → 归一化融合为单一 `score` → top-K。Platform 再叠加时间信号。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works.md)）
- 关键设计：**BM25 是 boost 信号而非召回扩展器**——候选只来自语义检索，BM25/实体分只改排序。融合按运行时可用信号自适应降级（无 spaCy→纯语义；Qdrant 无 fastembed→无 BM25）。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)）
- 时间检索：查询时间意图分类**不额外调用 LLM**；时间分是**加性软偏置**，语义相关性始终主导，不过滤候选。（[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
- 论文版 Mem0^g 双路检索：实体中心（查询实体→锚点节点→出入边子图）+ 语义三元组（整查询嵌入 vs 三元组文本编码，阈值过滤按相似度排序）。（[论文 §2.2](https://arxiv.org/html/2504.19413v1)）
- 默认参数变化（v3）：`top_k` 100→20，`threshold` None→0.1，`rerank` True→False；OSS 可选 reranker。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)）

### 1.4 冲突解决与时间语义
- v2：LLM 判定 DELETE 被矛盾记忆（破坏性）；Mem0^g 用 LLM update resolver 将冲突关系**标记 invalid 而非物理删除**，以支持时间推理。（[论文 §2.1–2.2](https://arxiv.org/html/2504.19413v1)）
- v3：写入端不做冲突消解（ADD-only 保留新旧）；Platform 由 Dream Supersede 标记取代关系（保留历史、默认仍可见、`latest_only=true` 只取当前）。官方承认 ADD-only 的代价：LongMemEval 的 knowledge-update（93.6）是最难类别，BEAM 的 contradiction_resolution 仅 35.7（1M）/32.5（10M）。（[Dream](https://docs.mem0.ai/platform/features/dream.md)、[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
- 时间语义：写入时抽取事件时间元数据 + 读取时按查询时间意图（当前状态/过去事件/未来计划）对候选打分排序。（[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)、[README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)）

### 1.5 遗忘与衰减
- **Memory Decay**（Platform，按项目 opt-in、默认关）：每条记忆维护访问历史（最多最近 20 次触达），检索时乘以 **0.3×–1.5×** 缩放因子——刚访问≈1.5×，闲置数月≈0.3× 下限；**纯软排序偏置、永不过滤**；候选池扩到 top_k×3（下限 50）再重排；每次返回后 fire-and-forget 记录强化；可逆，关闭即恢复。（[Memory Decay](https://docs.mem0.ai/platform/features/memory-decay.md)）
- **Memory Expiration**（Platform+OSS）：`expiration_date`（YYYY-MM-DD，UTC，当日含）到期后 search/get_all 不再返回，但**不删除**、按 ID 仍可取、`show_expired=true` 可恢复可见、置 None 撤销；坏日期 fail-open。（[Memory Expiration](https://docs.mem0.ai/platform/features/memory-expiration.md)）
- 官方明确区分三者：expiration=到期隐藏（可逆）、decay=按使用新近度重排（可逆）、delete=永久删除。（[Memory Expiration 对比表](https://docs.mem0.ai/platform/features/memory-expiration.md)）

### 1.6 用户控制与可解释性
- 显式 CRUD：`update`/`delete`/`delete_all`、批量操作、memory history 变更日志（Platform API）。（[llms.txt 索引](https://docs.mem0.ai/llms.txt)、[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works.md)）
- Dream 全程可审计：superseded/merged 记录保留、dashboard 可查每次合成运行及其源记忆链接；pattern memory 可溯源到证据。（[Dream](https://docs.mem0.ai/platform/features/dream.md)）
- `custom_instructions` 定制抽取内容；metadata/categories 过滤；Memory Export（Pydantic schema 导出）、Feedback 机制、webhooks。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[llms.txt 索引](https://docs.mem0.ai/llms.txt)）
- 官方提醒：勿存密钥/凭据/未脱敏敏感数据。（[How Mem0 Works](https://docs.mem0.ai/core-concepts/how-it-works.md)）

### 1.7 特色亮点
- **ADD-only + 检索端消歧**的范式转向：用一次 LLM 调用替代两次，把一致性负担从写入端移到排序端（decay/temporal/supersede），官方报告 LoCoMo 71.4→92.5、LongMemEval 67.8→94.4，平均每次检索 <7K tokens（top_200 预算；Platform 含 OSS 没有的专有优化）。（[README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)、[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
- 论文版相对 OpenAI 记忆 LLM-as-Judge +26%，p95 延迟比 full-context 低 91%、token 成本省 90%+（厂商论文数字）。（[arXiv 摘要](https://arxiv.org/abs/2504.19413)）
- 评估框架开源（[mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)，见 [Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)），并提出 BEAM 1M/10M token 级基准；公开承认 10M 下 temporal_reasoning 16.3、event_ordering 20.2 是全行业未解难题。
- 优雅降级设计：可选依赖缺失时逐层退回纯语义检索，不硬失败。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)）
- Hosted 平台能力：托管向量库/reranker、内建图记忆、Profiles（结构化用户画像一次读取）、多模态、custom categories、BYOK、审计日志、MCP server、CLI、agent 自助注册 API key。（[Platform Overview](https://docs.mem0.ai/platform/overview.md)、[llms.txt 索引](https://docs.mem0.ai/llms.txt)）

### 1.8 明显短板（复杂度、依赖、成本）
- **OSS 与 Platform 能力割裂**：图记忆、Decay、Dream Synthesis、Profiles 等关键能力仅 Platform；OSS 图集成被整段移除——开源自托管路线的功能被商业版「收走」，存在路线图风险。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[Memory Decay](https://docs.mem0.ai/platform/features/memory-decay.md)、[Dream](https://docs.mem0.ai/platform/features/dream.md)）
- ADD-only 的固有代价：矛盾事实共存，knowledge-update/contradiction 类任务偏弱（官方自认）；无 Dream 的 OSS 用户需自行处理一致性。（[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
- 依赖面：默认 OpenAI LLM（gpt-5-mini）+ OpenAI 嵌入（text-embedding-3-small）；混合检索需 spaCy（Python 3.10–3.12 限制）+ Qdrant 场景的 fastembed；自托管服务器需 Docker 栈（向量库+SQL）。（[README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)、[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)）
- v3 破坏性变更多（参数改名/默认值变化/score 语义变化），升级需重调阈值。（[迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)）

### 1.9 对轻量本地插件的启示
- **可直接借鉴（低成本）**：ADD-only+哈希去重、expiration 隐藏不删除、decay 软偏置（0.3–1.5×+访问历史上限）、supersede/merge 链接+`latest_only` 读模式、命名空间作用域。全部只需本地 SQLite/JSON+少量簿记，无外部服务。
- **中等成本**：BM25+语义+实体三信号融合（本地 FTS5+可选本地嵌入模型；实体抽取需 NLP/LLM）；实体共现链接可用关系表模拟，无需图数据库。
- **必须重型/外部**：Platform 图记忆与 Dream Synthesis（托管后台 LLM）、大规模向量检索服务、reranker 服务。

---

## 2. Letta（前 MemGPT）

> 来源：[MemGPT 论文 arXiv 2310.08560](https://arxiv.org/abs/2310.08560)（v2，2024-02-12）、[论文 HTML 全文](https://arxiv.org/html/2310.08560v2)、[Sleep-time Compute 论文 arXiv 2504.13171](https://arxiv.org/abs/2504.13171)、[letta 主仓库 README](https://raw.githubusercontent.com/letta-ai/letta/main/README.md)、[letta-code README](https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md)、[docs.letta.com](https://docs.letta.com/concepts/memfs/index.md)。
> **版本警示**：`letta-ai/letta` 仓库现为**已归档的 V1 API server**（archive 分支），活跃开发全部转移到 `letta-ai/letta-code`（agent harness）。论文中的 core/recall/archival 分层属于 V1/MemGPT 时代；当前产品形态是 **MemFS（git 版本化记忆文件系统）+ dreaming**。（[letta README](https://raw.githubusercontent.com/letta-ai/letta/main/README.md)、[archive 分支 README](https://raw.githubusercontent.com/letta-ai/letta/archive/README.md)）

### 2.1 记忆模型与存储
- **MemGPT 论文分层（OS 类比）**：
  - **Main context**（≈RAM，prompt tokens）三段：只读 system instructions；**working context**（固定大小读写文本块，只能经函数调用写入，存用户/人设关键事实）；**FIFO queue**（滚动消息历史，队首是被逐出消息的**递归摘要**）。
  - **External context**（≈磁盘）：**recall storage**（完整消息数据库）+ **archival storage**（任意长度文本对象的读写库，实验用 PostgreSQL+pgvector+HNSW 做向量检索）。
  - 数据经 LLM 函数调用在两层间「分页」移动。（[论文 §2](https://arxiv.org/html/2310.08560v2)）
- **当前 Letta Code（MemFS）**：记忆是 agent 状态的一部分，存放在 **agent 自有的 git 仓库**中，MemFS 把它投影为运行机器上的真实 checkout；每条 memory block 以 label→路径映射为带 YAML frontmatter 的 Markdown 文件（`persona`→`persona.md`）。**根目录文件（旧版 `system/` 目录）每回合注入 system prompt**；带 `MEMORY.md` 索引的子目录默认不进上下文，agent 顺着文件树「路标」按需读取。创建时 `memory=[{label,value}]` 落在 `system/` 下。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)、[Agent SDK Memory](https://docs.letta.com/agent-sdk/memory/index.md)）
- **默认无语义/向量索引**：agent 用普通文件搜索/读取工具找记忆；可选安装 memfs-search mod（关键词搜索零依赖；语义/混合搜索需外部 QMD 索引）。会话历史搜索独立于 MemFS：Cloud 支持全文+向量+混合，本地后端目前仅全文。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）

### 2.2 写入与更新决策管线
- **论文**：记忆编辑与检索**完全自主**（self-directed）——LLM 通过函数调用自行决定何时把信息写入 working context/archival、何时检索；解析器校验函数参数，运行错误回喂给模型形成反馈循环；检索分页防止撑爆上下文。（[论文 §2.3](https://arxiv.org/html/2310.08560v2)）
- **Queue manager 溢出策略**：prompt 超过 warning 阈值（如 70%）→ 插入「memory pressure」系统警告，让 LLM 主动把重要信息转存；超过 flush 阈值（100%）→ 逐出约 50% 消息并生成新的递归摘要；被逐出消息永久留在 recall storage 可检索。（[论文 §2.2](https://arxiv.org/html/2310.08560v2)）
- **当前**：agent 用普通文件工具编辑 MemFS，**commit+push 后才成为记忆**；`/remember` 显式教学（agent 自行决定放哪个文件并提交）；`/init` 引导初始化；`/doctor` 审计放置/重复/system prompt token 占用；大型重组前自动备份仓库。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)、[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)）
- **Dreaming（sleep-time compute 的产品化）**：后台 subagent 回顾近期对话、 consolidated 经验、更新记忆，不打断主工作。触发器 `off | step-count | compaction-event`（按步数或上下文压缩时），行为 `reminder | auto-launch`（提醒主 agent 自己更新 vs 自动启动后台 dreaming subagent）；可开启「Agent reviews before applying」让主 agent 在第二个后台会话中复审拟议修改（更耗 token、不需用户批准）。dreaming/memory doctor 用 **git worktree** 并发更新记忆而不阻塞主 agent。（[Agent SDK Memory](https://docs.letta.com/agent-sdk/memory/index.md)、[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)、[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
- Sleep-time compute 论文依据：离线「预思考」上下文、预判可能查询并预计算，可在 Stateful GSM-Symbolic/AIME 上把达到同等准确率所需 test-time 计算降约 5×，加大 sleep-time 计算可再提准确率 13%/18%，多查询摊销使单查询成本降 2.5×；查询可预测性与收益正相关。（[arXiv 2504.13171 摘要](https://arxiv.org/abs/2504.13171)）

### 2.3 检索与排序
- 论文：archival/recall 检索经函数调用分页拉回 main context；`request_heartbeat=true` 实现**函数链**（多步检索/多跳查找，如 nested KV 任务）；事件驱动控制流（用户消息、系统警报、定时事件均可触发推理，支持无用户干预的主动行为）。（[论文 §2.3–2.4](https://arxiv.org/html/2310.08560v2)）
- 当前：检索=**上下文内核心块（每回合自动在 prompt）+ 上下文外文件树按需读取**；无内建向量排序，语义检索为可选 mod。这是与 Mem0/Zep 的根本差异：把「检索」变成 agent 的文件导航行为。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）

### 2.4 冲突解决与时间语义
- 无专门 bi-temporal 机制；时间语义由 **git 提交历史**承载（版本历史、冲突解决、已保存记忆与未提交变更的清晰边界）。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
- 矛盾/过时信息靠 agent 自编辑与 dreaming 整理（合并重复、拆分大文件、重组层级），重组前备份。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)）
- 论文中 working context 的更新即「用新理解覆盖旧文本」（图 4 示例），属破坏性编辑，但外部存储保留全量历史。（[论文 §2.3](https://arxiv.org/html/2310.08560v2)）

### 2.5 遗忘与衰减
- 论文：FIFO 逐出+递归摘要=有损「遗忘」，但 recall storage 永久保留原文可找回（遗忘的是上下文占用而非数据）。（[论文 §2.2](https://arxiv.org/html/2310.08560v2)）
- 当前：无自动衰减/过期机制；靠 `/doctor` 审计与 agent 主动重组控制记忆体积；Cloud 有仓库配额（Free 5 MiB / Pro 50 MiB，按最新快照计），官方建议大文件外置、记忆只留摘要+检索链接。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)）

### 2.6 用户控制与可解释性
- 记忆即**人类可读 Markdown + git 历史**：`/memory` 查看、直接检查 `$MEMORY_DIR`、git diff 审计每次变更；可把记忆仓库指向自己的 GitHub remote（`/memory-repository set`）。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)、[letta-code README](https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md)）
- dreaming 可选「先复审再应用」；权限系统控制工具执行；本地后端全部状态留在本机、无需 Letta 账号。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)、[llms.txt 索引](https://docs.letta.com/llms.txt)）
- 注意：Windows 上客户端自动 dreaming 默认禁用（需 `LETTA_ENABLE_WINDOWS_AUTO_REFLECTION=1` 显式开启），手动 `/dream`、`/reflect` 仍可用——后台行为按平台显式受控。（[letta-code README](https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md)）

### 2.7 特色亮点
- **OS 式虚拟上下文管理**的开创性设计：固定上下文模型获得「无限上下文」幻觉；DMR 任务 GPT-4 Turbo 35.3%→93.4%（论文数字）。（[论文](https://arxiv.org/html/2310.08560v2)）
- **记忆=git 仓库**：版本化、可 diff、可回滚、可跨机器同步、可共享（shared memory repositories），agent 用已有文件技能管理记忆，无需新查询语言。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
- **in-context/out-of-context 的显式分层**（根文件常驻 vs MEMORY.md 路标按需读）是对「什么值得每回合花 token」的工程化回答。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
- sleep-time compute 有正式论文与量化收益支撑，dreaming 触发/行为可配置。（[arXiv 2504.13171](https://arxiv.org/abs/2504.13171)、[Agent SDK Memory](https://docs.letta.com/agent-sdk/memory/index.md)）
- 本地优先可行：local backend 无账号、无外部服务即可运行完整 agent+记忆。（[llms.txt 索引](https://docs.letta.com/llms.txt)）

### 2.8 明显短板（复杂度、依赖、成本）
- 记忆质量**高度依赖底层模型的自律与文件操作能力**：无结构化校验、无自动去重/矛盾检测，过度提取或乱放文件需 `/doctor` 事后补救。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)）
- 默认无语义检索：记忆规模增大后纯文件导航的召回率存疑；补语义需额外 mod+QMD 依赖。（[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
- dreaming/复审是**额外后台 LLM 开销**（官方明言 more model tokens）；auto-launch 不需用户批准，需权限与审计兜底。（[Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)）
- 产品形态剧烈变迁（V1 server 归档、AgentFile 废弃、文档大量链接仍指向旧路径），生态与 API 稳定性风险高。（[letta README](https://raw.githubusercontent.com/letta-ai/letta/main/README.md)、[letta-code README](https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md)）
- 论文机制（recall/archival+pgvector）与当前产品（MemFS）已脱节，按论文实现≠使用当前 Letta。

### 2.9 对轻量本地插件的启示
- **最适合轻量本地插件借鉴的对象**：Markdown+frontmatter 记忆块、核心块常驻/其余按需读、MEMORY.md 路标索引、git 版本化与备份、/remember 式显式教学、dreaming 的「触发器+复审」设计——全部零外部服务。
- **中等成本**：git worktree 并发后台整理；本地全文检索（会话历史）。
- **可选重型**：语义/混合检索（QMD 或本地嵌入）、后台 LLM 整理调用（可复用宿主 agent 的空闲算力，但仍是 LLM 成本）。

---

## 3. Zep / Graphiti

> 来源：[Zep 论文 arXiv 2501.13956](https://arxiv.org/abs/2501.13956)（2025-01-20）、[论文 HTML 全文](https://arxiv.org/html/2501.13956v1)、[Graphiti 官方 README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)、[help.getzep.com v4 文档](https://help.getzep.com/v4/facts.md)、[GitHub API 仓库状态](https://api.github.com/repos/getzep/graphiti)。
> 定位区分（官方口径）：**Graphiti** 是开源自托管的时序知识图谱**框架**（自备图库/LLM/embedder）；**Zep** 是企业级托管「unified context layer」（内建 users/threads/ingestion/治理，图数据库为自研 Konig 服务）。「两者都不是 agent memory 产品本身」——Graphiti 建图、Zep 治理与供给上下文。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）

### 3.1 记忆模型与存储
- **三层子图**（论文）：
  1. **Episode 子图**：原始输入（message/text/JSON）的**无损存储**，episode↔实体双向索引，支持从派生事实溯源到原文（引用/引证）。
  2. **Semantic entity 子图**：实体节点（名称+演化摘要）+ 事实边（三元组）。
  3. **Community 子图**：强连通实体聚类的高层摘要节点。
  （[论文 §2](https://arxiv.org/html/2501.13956v1)）
- 当前 Graphiti 表述为 **context graph**：每个事实带**有效性窗口**（何时成立、何时被取代），一切实体/关系可回溯到 episodes；支持 **prescribed ontology（Pydantic 自定义实体/边类型）与 learned ontology** 并存。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 存储后端：Neo4j 5.26 / FalkorDB（含嵌入式 FalkorDB Lite，Python 3.12+）/ Amazon Neptune（+OpenSearch 全文）/ Kuzu（**已弃用**，上游停止维护）。Zep 托管版用自研 Konig，宣称百万级图、sub-200ms 检索。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）

### 3.2 写入与更新决策管线
- 论文管线（每条 episode 多次 LLM 调用）：
  1. **实体抽取**：当前消息+最近 n=4 条消息为上下文；说话人自动成为实体；用 reflexion 式反思减少幻觉、提高覆盖；同时抽取实体摘要。
  2. **实体消解**：实体名嵌入（1024 维）余弦相似+全文搜索找候选 → LLM 判定是否重复，重复则更新名称/摘要。
  3. **事实抽取**：带谓词的事实；同一事实可在不同实体对间多次抽取，实现**超边**语义。
  4. **边去重/消解**：混合搜索**限定在同一实体对之间的边**（防错误合并、降复杂度）。
  5. **时间抽取+边失效**（见 3.4）。
  6. **社区构建**：label propagation（非 Leiden，便于动态增量）；新节点按邻居多数社区归入并更新摘要；周期性全量刷新仍必要；社区摘要 map-reduce 生成、社区名嵌入供检索。
  - 落库用**预定义 Cypher**而非 LLM 生成查询（保证 schema 一致、减少幻觉）。（[论文 §2](https://arxiv.org/html/2501.13956v1)）
- 增量构建：新数据即时整合，**无需全图重算**（对比 GraphRAG 的批处理）。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 工程现实：摄入管线高并发设计，默认 `SEMAPHORE_LIMIT=10` 防 LLM 429；**强依赖结构化输出**（小模型/本地模型易 schema 失败，提供 json_schema/json_object 两种模式）；支持按 prompt 路由不同模型（LLMRuntime），去重/消解可路由到专用「决策模型」（Jev、OpenAI Decisions）。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）

### 3.3 检索与排序
- 论文：f(查询)=**Constructor(Reranker(Search))** 三段：
  - **Search**：余弦语义、BM25 全文（Neo4j/Lucene）、**BFS 图遍历**（n-hop 扩展，可用最近 episodes 作种子）三路并行，分别覆盖语义/词面/上下文相似。
  - **Reranker**：RRF、MMR、**episode-mentions**（按对话中被提及频率）、**node distance**（距指定中心节点的图距离）、cross-encoder（最贵）。
  - **Constructor**：输出事实+有效日期区间、实体名+摘要、社区摘要，拼成 prompt-ready 上下文串。
  （[论文 §3](https://arxiv.org/html/2501.13956v1)）
- 当前 Graphiti：混合检索=语义嵌入+BM25+图遍历，**查询时不依赖 LLM 摘要**（对比 GraphRAG），宣称亚秒延迟；预置 search recipes。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- Zep v4 检索产物为 **Context Block**（Smart Context Assembly 自动选材），可用 context templates 定制；facts 默认搜索目标。（[v4 facts](https://help.getzep.com/v4/facts.md)、[v4 文档索引](https://help.getzep.com/v4/llms.txt)）

### 3.4 冲突解决与时间语义（本框架的招牌）
- **Bi-temporal 模型**：事件时间线 T（事实何时在现实中成立：`t_valid`/`t_invalid`）与事务时间线 T'（系统何时写入/失效：`t'_created`/`t'_expired`）分离。v4 API 对应边上四时间戳 `created_at / valid_at / invalid_at / expired_at`。（[论文 §2.1–2.2.3](https://arxiv.org/html/2501.13956v1)、[v4 Facts](https://help.getzep.com/v4/facts.md)）
- **边失效而非删除**：新边与语义相关旧边由 LLM 比对，发现时间重叠的矛盾时，把旧边 `t_invalid` 设为新边 `t_valid`；按 T' **新信息优先**。历史关系完整保留，可回答「现在什么是真的」与「过去某时刻什么是真的」。（[论文 §2.2.3](https://arxiv.org/html/2501.13956v1)、[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 相对时间解析：episode 带 `reference_time`，「两周前开始新工作」等相对表述被解析为绝对 datetime；无时刻的日期按午夜 UTC。（[论文 §2.1](https://arxiv.org/html/2501.13956v1)、[v4 Facts](https://help.getzep.com/v4/facts.md)）
- 官方澄清：valid_at/invalid_at 是**推断**，不保证源内容或事实为真。（[v4 Facts](https://help.getzep.com/v4/facts.md)）
- 2026 新增 **Observations**（Flex Plus/Enterprise）：从图结构自动检测的**跨实体、证据支撑的持久模式**（偏好、承诺、循环、状态迁移），自动去重合并、被取代即 retire、**只读**（跟随证据），可 steering 定制措辞/类型——相当于在 facts 之上再做一层「模式记忆」。（[v4 Observations](https://help.getzep.com/v4/observations.md)）

### 3.5 遗忘与衰减
- 核心哲学是**不遗忘**：失效边保留全部历史（non-lossy），episode 原文永久可溯。（[论文 §1–2](https://arxiv.org/html/2501.13956v1)、[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 真正的删除是显式管理操作（v4 提供删除 edges/nodes/episodes/threads/users/graphs 的 API）；托管版有 context retention 策略管理保留期。（[v4 文档索引](https://help.getzep.com/v4/llms.txt)）
- 无内建使用频率衰减；「常提及的信息更易获取」由 episode-mentions reranker 在检索端实现。（[论文 §3.2](https://arxiv.org/html/2501.13956v1)）

### 3.6 用户控制与可解释性
- **全链路溯源**：每个派生事实→源 episodes（双向索引），v4 有 source traceability 与 episode metadata projection；dashboard 图可视化、debug logs、ingestion traces。（[论文 §2.1](https://arxiv.org/html/2501.13956v1)、[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)、[v4 文档索引](https://help.getzep.com/v4/llms.txt)）
- 自定义 ontology（Pydantic 实体/边类型）、custom instructions、user summary instructions、observation steering；手动增改 fact triplets。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)、[v4 文档索引](https://help.getzep.com/v4/llms.txt)）
- 企业治理：RBAC/ABAC、审计日志、API 日志、SOC 2/HIPAA/BYOK/BYOM、BYOC。（[v4 文档索引](https://help.getzep.com/v4/llms.txt)）
- 安全警示（官方自述）：参考 MCP/REST server **无认证、无授权、无 prompt-injection 防护**（有意为之，安全报告不在受理范围），严禁暴露到不可信网络；遥测默认开启（PostHog 匿名统计，可 `GRAPHITI_TELEMETRY_ENABLED=false` 关闭）。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）

### 3.7 特色亮点
- **bi-temporal + 边失效**是被调研对象中最严谨的时间语义方案：同时支持当前态查询、历史点查询、审计，且矛盾消解不丢信息。（[论文 §2.2.3](https://arxiv.org/html/2501.13956v1)）
- 论文数字（厂商自报）：DMR 94.8%（gpt-4-turbo，vs MemGPT 93.4%）；LongMemEval_s（约 115K token 对话）gpt-4o 71.2% vs full-context 60.2%，延迟 2.58s vs 28.9s（约 -90%），上下文 1.6K vs 115K tokens。论文同时**自我批评 DMR 基准不足**（full-context 已能拿 94.4/98.0%）。（[论文 §4](https://arxiv.org/html/2501.13956v1)）
- 查询路径无 LLM（混合检索+reranker），延迟可控；摄入端才花 LLM 成本。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 社区层提供全局/主题级理解（label propagation 动态增量是务实工程选择）。（[论文 §2.3](https://arxiv.org/html/2501.13956v1)）
- 仓库活跃（2026-11-11 仍有推送，约 32.8k stars，Apache-2.0）。（[GitHub API](https://api.github.com/repos/getzep/graphiti)）

### 3.8 明显短板（复杂度、依赖、成本）
- **重型基础设施**：必须自备图数据库（Neo4j/FalkorDB/Neptune）+ embedder + 支持结构化输出的 LLM；每条 episode 触发多次 LLM 调用（抽取/消解/时间/失效），摄入成本与延迟高，小模型易失败。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)、[论文 §2](https://arxiv.org/html/2501.13956v1)）
- 运维复杂度：并发调优（SEMAPHORE_LIMIT）、社区周期刷新、索引/约束初始化、多后端差异；Kuzu 后端已弃用显示依赖链风险。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- 论文承认部分类别回退（如 single-session-assistant、gpt-4o-mini 的 knowledge-update），弱模型理解时间数据的能力不足。（[论文 §4.3.2](https://arxiv.org/html/2501.13956v1)）
- 参考服务器无安全防护、遥测默认开；生产需自建认证/租户隔离/输入控制，或直接买 Zep 托管。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
- Zep 托管高级能力（Observations、Konig、治理）与开源 Graphiti 差距拉大；v4 有「February 2026 deprecation wave」，API 演进快。（[v4 文档索引](https://help.getzep.com/v4/llms.txt)、[v4 Observations](https://help.getzep.com/v4/observations.md)）

### 3.9 对轻量本地插件的启示
- **可借鉴（低/中成本）**：四时间戳 schema（created/valid/invalid/expired）与「失效不删除」原则——纯本地字段+读取过滤即可实现 80% 收益；episode→fact 溯源链接；reference_time 相对日期解析（规则+LLM 均可）。
- **中等成本**：LLM 矛盾检测触发失效（可退化为「同主题新事实取代旧事实」启发式）；提及频率 reranker（本地计数）。
- **必须重型**：完整 Graphiti 管线（图数据库+多次结构化 LLM 调用+嵌入）、社区检测与 map-reduce 摘要、cross-encoder 重排、Zep 托管治理层。轻量插件不应引入图数据库。

---

## 4. LangMem（LangChain）

> 来源：[官方文档站](https://langchain-ai.github.io/langmem/)、[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[官方 README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)、[GitHub API 仓库状态](https://api.github.com/repos/langchain-ai/langmem)（MIT，2026-11-03 仍有推送）。
> 定位：**函数式记忆原语库**而非服务——核心 API 与存储无关，上层才集成 LangGraph Store。

### 4.1 记忆模型与存储
- **三类记忆**（对齐人类记忆分类）：
  - **Semantic**（事实与知识）：两种表示——**Collection**（无界记录集，运行时搜索）与 **Profile**（单一结构化文档，Pydantic schema，只保留最新状态，`enable_inserts=False`）。
  - **Episodic**（过去经验）：成功交互的完整上下文，作 few-shot 范例；示例 schema 为 `observation/thoughts/action/result` 四元组。
  - **Procedural**（系统行为）：system prompt 本身，随反馈与经验演化。
  （[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 存储可选：核心函数无副作用、不依赖任何数据库；有状态集成层用 LangGraph **BaseStore**（demo 用 InMemoryStore，生产建议 AsyncPostgresStore），索引配置嵌入模型（如 openai:text-embedding-3-small）。（[ README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)、[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- **命名空间**：多级元组（org→user→app），支持 `{user_id}` 模板变量运行时填充；记忆=命名空间+key+结构化 content+metadata。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

### 4.2 写入与更新决策管线
- 统一模式：**接收对话+当前记忆状态 → LLM 决定如何扩展/合并 → 返回更新后的记忆状态**。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 两种形成时机：
  - **Hot path（conscious formation）**：agent 在对话中用 `create_manage_memory_tool`/`create_search_memory_tool` 自主决定存什么、何时存；即时但增加响应延迟与工具选择负担。
  - **Background（subconscious formation）**：`create_memory_manager`/`create_memory_store_manager` 在对话后/空闲期反思提取，零在线延迟、更高召回，适合模式分析与摘要；支持延迟批处理（delayed processing guide）。
  （[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)）
- Collection 更新需**调和**新旧：删除/失效或更新/合并；官方称之为 memory enrichment，可用 instructions 调节创建 vs 合并的强度；明确警告**过度提取→精度下降、提取不足→召回下降**。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- **Prompt 优化**（procedural 写入）：`create_prompt_optimizer`（kind="metaprompt"，max_reflection_steps 等）基于轨迹+可选反馈（如 user_score）重写 system prompt；支持单 prompt 与复合系统多 prompt 优化。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

### 4.3 检索与排序
- BaseStore 三种方式：按 key 直取、语义相似搜索、metadata 过滤。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 官方观点：**相关性 ≠ 仅语义相似**，应组合 similarity + importance + **strength**（最近/频繁使用程度的函数）——但这是设计指导，库本身未提供内建衰减实现。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- Profile 类记忆不走搜索：按 user/agent key 直接 lookup 注入 prompt。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

### 4.4 冲突解决与时间语义
- Collection 模式由 LLM 在 enrichment 中决定 delete/invalidate/update/consolidate（可配置强度）；Profile 模式天然「新状态覆盖旧状态」。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 无 bi-temporal/事件时间机制；时间维度仅体现为 strength 的 recency/frequency 建议。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

### 4.5 遗忘与衰减
- 无内建过期/衰减/TTL；遗忘=LLM 调和时的删除/失效决策，或开发者自行实现（strength 概念留白）。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 短期记忆侧提供消息历史摘要工具（summarization guide）控制上下文增长。（[文档站目录](https://langchain-ai.github.io/langmem/)）

### 4.6 用户控制与可解释性
- Profile 用 Pydantic schema 强约束，**易于呈现给用户手工编辑**；Collection 的 instructions 可定制提取倾向；命名空间模板让隔离策略显式化。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 核心是纯函数：输入输出可单测、可审计，无黑盒服务。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

### 4.7 特色亮点
- **semantic/episodic/procedural 三分法 + collection/profile 二分表示**是被调研对象中最清晰的记忆类型学，直接可抄作插件的数据分类。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- hot path vs background 的权衡表（延迟/更新速度/处理负载/适用场景）是工程决策的好框架。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- **把 system prompt 本身当作可学习记忆**（prompt optimization）独树一帜。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 存储无关的 functional core：可配任意后端（包括本地 SQLite/文件），与 LangGraph 生态原生集成。（[README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)）

### 4.8 明显短板（复杂度、依赖、成本）
- **只是原语不是系统**：无内建时间语义、衰减、去重保证、冲突检测保证——一切质量取决于开发者组装与 LLM 表现。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 每次记忆操作都是 LLM 调用（提取/调和/优化），background 模式成本随对话量线性增长；hot path 增加在线延迟。（[Core Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）
- 有状态路径绑定 LangGraph BaseStore 与嵌入配置；生产持久化需 Postgres 等。（[README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)）
- 文档示例模型较旧（claude-3-5-sonnet），仓库规模小（约 1.8k stars、80 open issues），社区动能弱于 Mem0/Graphiti。（[README](https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md)、[GitHub API](https://api.github.com/repos/langchain-ai/langmem)）
- 在 Mem0 论文的 LOCOMO 对比中 LangMem（Hot Path）被列为开源基线之一，未夺魁（厂商论文口径，仅供参考）。（[Mem0 论文 §3.3](https://arxiv.org/html/2504.19413v1)）

### 4.9 对轻量本地插件的启示
- **低成本直接借鉴**：三类记忆分类、profile（单文档覆盖）vs collection（追加+调和）的选择准则、episodic 四元组 schema、命名空间模板、hot path/background 双通道设计。
- **中等成本**：memory manager 式 LLM 调和（可批处理降频）、strength=recency+frequency 的排序公式（本地计数即可）。
- **较高成本**：prompt optimization 闭环（需轨迹+反馈+多步反思 LLM）。
- 核心 API 无存储依赖的特性与「轻量本地插件」目标天然契合。

---

## 5. Memobase（概览）

> 来源：[官方 README](https://raw.githubusercontent.com/memodb-io/memobase/main/readme.md)、[docs.memobase.io](https://docs.memobase.io/features/profile/profile.md)、[GitHub API](https://api.github.com/repos/memodb-io/memobase)。

- 定位：**用户画像式（user profile-based）长期记忆后端**，「记忆为用户而非 agent」；Apache-2.0，FastAPI+Postgres+Redis，全 Docker 化。
- 记忆模型：结构化 **profile slots**（topic/sub_topic，如 basic_info/name、interest/games），`config.yaml` 的 `additional_user_profiles`/`overwrite_user_profiles` 完全自定义 schema；另有**事件时间线**（user events + 细粒度 event gist）回答时间相关问题。
- 写入：**不在 hot path 做记忆**——每用户一个 buffer，攒到约 1024 tokens 或闲置约 1 小时自动 flush（也可手动 `flush()`）；v0.0.40 起单次运行**固定 3 次 LLM 调用**（原 3–10 次），token 成本降约 40–50%；系统内无「agent」避免失控成本。
- 读取：profile+事件时间线常驻可用，在线读取仅少量 SQL 操作、**<100ms**；`context()` API 直接把画像+近期事件打包成 prompt 字符串（可限 token、偏好 topic、自定义模板）。
- 数据最小化：blob 默认**处理完即删**（可配置保留）；内置 en/zh/ja 多语言提示词。
- 冲突/时间：画像槽位覆盖更新+事件时间线（无 bi-temporal 图谱）；自报 LOCOMO SOTA（厂商声明，未独立核实）。
- 短板：自托管需 Postgres+Redis 服务栈；仓库最近推送 2026-01-11（此前十余个月活跃），维护节奏放缓迹象；画像 schema 固定，不适合非用户中心的知识记忆。
- **可借鉴**：buffer 批处理+固定 LLM 调用次数（成本可控的后台整理范式）、profile slots 的显式 schema 控制、context() 一键打包、「处理完即删原始数据」的隐私默认。

## 6. Supermemory（概览）

> 来源：[官方 README](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md)、[supermemory.ai/docs](https://supermemory.ai/docs)、[How it works](https://supermemory.ai/docs/concepts/how-it-works.md)。

- 定位：记忆+上下文引擎（memory ≠ RAG：RAG 取文档块，memory 跟踪**关于用户的事实**随时间变化）；云 API + 开源本地版 + 编码工具插件/MCP。
- 引擎：自研 **learning model**（决定学什么/多重要/何时忘/建关系）+ **temporal vector-graph engine**（Vector+FTS+graph 一体）；摄入管线 queued→extracting→chunking→embedding→indexing→done。
- **Dreaming 双模式**：`dynamic`（默认，相关文档分组批处理成连贯记忆单元，done 后仍可能继续提取）vs `instant`（单文档立即入图，多计一次操作费）。
- 输出三件套：document chunks（RAG 溯源）+ memories（活图中的事实）+ **profile（static 长期事实 + dynamic 近期活动，一次调用约 50ms）**。
- 时间/冲突：自动处理知识更新与矛盾（"moved to SF" 取代 "live in NYC"）；**自动遗忘过期信息**（"明天有考试"过期即失效）——被调研对象中少见的显式 auto-forget 声明。
- 本地版：单二进制零配置，内嵌图引擎+**本地嵌入（Xenova/bge-base-en-v1.5，无需 API key）**，可接 Ollama 全离线（URL 抓取仍用托管 reader），数据都在 `~/.supermemory`，遥测可关。
- 隔离：namespace 硬隔离 + scoped API keys + metadata 软过滤。
- 厂商声明：LongMemEval/LoCoMo/ConvoMem 均 #1，95% Recall@15 仅约 720 tokens（99.4% 上下文缩减）；开源 MemoryBench 对比框架。均未独立核实。
- 短板：**v3/v4 API 已弃用、2026-12-31 关停**，须迁 v5（API  churn 风险）；核心 learning model 闭源，本地版能力边界文档未完全展开；基准为自报。
- **可借鉴**：static/dynamic 双层画像、过期自动遗忘、dynamic 批处理入图、本地嵌入+单目录数据的本地化形态。

---

## 7. 精华：值得借鉴的机制（面向「轻量、本地、无外部服务依赖」插件）

> 实现代价标注：**低**=纯本地数据结构/簿记，无 LLM 或仅复用宿主既有调用；**中**=需本地检索组件（FTS/嵌入）或偶发 LLM 调用；**高**=需后台 LLM 管线/专用模型/重型存储。

| # | 机制 | 来源 | 代价 | 说明 |
|---|---|---|---|---|
| 1 | **ADD-only 追加 + 哈希去重**，修正走显式操作或取代链接 | [Mem0 v3](https://docs.mem0.ai/migration/oss-v2-to-v3.md) | 低 | 一次抽取调用甚至规则化；避免写入端 diff 的延迟与误删 |
| 2 | **失效/取代不删除**（superseded 标记+新旧链接，`latest_only` 读模式） | [Mem0 Dream](https://docs.mem0.ai/platform/features/dream.md)、[Zep 边失效](https://arxiv.org/html/2501.13956v1) | 低–中 | 链接与标记是纯字段；矛盾检测可先用「同主题新事实」启发式，LLM 判定为升级项 |
| 3 | **bi-temporal 四时间戳**（created/valid/invalid/expired）+ reference_time 相对日期解析 | [Zep v4 Facts](https://help.getzep.com/v4/facts.md) | 低（schema）/中（自动推断） | 本地即可支持「当前态/历史态」两种读取；推断可退化为写入时间 |
| 4 | **expiration_date 到期隐藏不删除**（UTC、可逆、show_expired、坏日期 fail-open） | [Mem0 Expiration](https://docs.mem0.ai/platform/features/memory-expiration.md) | 低 | 纯元数据+读取过滤；临时性事实（考试/试用/季节偏好）必备 |
| 5 | **软衰减排序**：访问历史（上限 20 次）→ 0.3×–1.5× 乘子，永不过滤、可逆 | [Mem0 Decay](https://docs.mem0.ai/platform/features/memory-decay.md) | 低 | 只需 last_access+计数簿记；候选池适度扩大再重排 |
| 6 | **核心块常驻上下文 + 其余按需读取**（in-context/out-of-context 显式分层） | [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md)、[MemGPT 论文](https://arxiv.org/html/2310.08560v2) | 低 | 控制每回合 token 成本的根本手段 |
| 7 | **MEMORY.md 路标索引**：目录/文件名即检索入口，agent 顺藤摸瓜 | [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md) | 低 | 无向量库也能规模化的关键 |
| 8 | **人类可读 Markdown + git 版本化**（diff/回滚/备份/同步） | [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md) | 低–中 | 本地 git 即可；重组前自动备份值得照抄 |
| 9 | **profile slots 显式 schema**（topic/sub_topic，可自定义/覆盖） | [Memobase](https://docs.memobase.io/features/profile/profile.md)、[LangMem Profiles](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 低 | 单文档覆盖更新，天然避免 collection 的调和难题；易给用户手工编辑 |
| 10 | **buffer 批处理 + 固定 LLM 调用次数**（token 阈值/闲置超时/手动 flush） | [Memobase](https://raw.githubusercontent.com/memodb-io/memobase/main/readme.md) | 低 | 后台整理成本可预算；不在 hot path 花 LLM |
| 11 | **hot path vs background 双通道**（即时关键更新 vs 空闲深度整理） | [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 低（设计）/中（后台 LLM） | 与 #10 组合即完整写入策略 |
| 12 | **三类记忆分类 + episodic 四元组**（observation/thoughts/action/result） | [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 低 | 数据模型直接可抄；成功经验作 few-shot |
| 13 | **命名空间作用域**（user/agent/run/app + 模板变量） | [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[Mem0](https://docs.mem0.ai/core-concepts/how-it-works.md) | 低 | 防串扰的第一道闸 |
| 14 | **混合检索：语义+BM25+实体 boost，boost 不扩召回**，缺依赖逐层降级 | [Mem0 v3](https://docs.mem0.ai/migration/oss-v2-to-v3.md) | 中 | 本地 FTS5 即可做 BM25；嵌入可用本地小模型；实体重叠可纯字符串匹配起步 |
| 15 | **实体共现链接**（无类型边、无图数据库）+ 查询实体 boost | [Mem0 Platform Graph](https://docs.mem0.ai/platform/features/graph-memory.md) | 中 | 关系表/倒排即可模拟「共享实体的记忆互连」，拿到多跳收益的八成 |
| 16 | **溯源链接**：派生记忆→源对话/episode；合成记忆→证据记忆 | [Zep 论文](https://arxiv.org/html/2501.13956v1)、[Mem0 Dream](https://docs.mem0.ai/platform/features/dream.md) | 低–中 | 可解释性与审计的地基 |
| 17 | **写入时时间元数据 + 读取时意图软加分**（语义主导、不过滤） | [Mem0 Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md) | 中–高 | 完整版需 LLM pass；可先做日期解析+recency 规则 |
| 18 | **dreaming 触发器+复审**（step-count/compaction 触发；reminder/auto-launch；先复审再应用；worktree 并发） | [Letta](https://docs.letta.com/agent-sdk/memory/index.md)、[Sleep-time 论文](https://arxiv.org/abs/2504.13171) | 中–高 | 后台 LLM 成本真实存在；复用宿主空闲时段+用户可关是底线 |
| 19 | **static/dynamic 双层用户画像**（长期事实+近期活动，一次读取） | [Supermemory](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md)、[Memobase context()](https://raw.githubusercontent.com/memodb-io/memobase/main/readme.md) | 低 | 画像直读免搜索，在线延迟极低 |
| 20 | **相关性=相似度+重要性+强度（recency/frequency）** | [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 低–中 | 与 #5 合并实现 |

**必须依赖重型基础设施、轻量插件不应引入的**：图数据库（Neo4j/FalkorDB/Neptune）及 Graphiti 全摄入管线（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）；社区检测+map-reduce 摘要（[Zep 论文 §2.3](https://arxiv.org/html/2501.13956v1)）；cross-encoder 重排服务；托管专属能力（Mem0 Platform 图/Dream Synthesis、Zep Observations/Konig）；大规模向量服务与嵌入 API（可用本地 ONNX/Ollama 替代但仍属模型依赖）。

## 8. 糟粕：应避免的设计

1. **每次写入都让 LLM 对既有记忆做 ADD/UPDATE/DELETE diff（两调用管线）**——Mem0 自己已在 v3 放弃：延迟高、成本翻倍、过早合并造成信息丢失；官方转向 ADD-only+检索端消歧。轻量插件更不应在写入热路径做多次 LLM 调用。（[Mem0 迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[README](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md)）
2. **物理删除被矛盾/过时的记忆**——丢失时间历史与审计能力；Zep/Mem0/Letta 全部走向「失效/取代/隐藏但保留」。删除只能是用户显式操作。（[Zep 论文 §2.2.3](https://arxiv.org/html/2501.13956v1)、[Mem0 Dream](https://docs.mem0.ai/platform/features/dream.md)、[Mem0 Expiration](https://docs.mem0.ai/platform/features/memory-expiration.md)）
3. **为本地单用户记忆引入重型服务栈**——Letta V1（Postgres+pgvector+API server）已整体归档；Graphiti 必须图库+嵌入+结构化 LLM。轻量插件选「文件/SQLite+git」路线已被 Letta Code 验证可行。（[letta README](https://raw.githubusercontent.com/letta-ai/letta/main/README.md)、[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)、[MemFS](https://docs.letta.com/concepts/memfs/index.md)）
4. **只追加不治理**——ADD-only 若无 decay/supersede/expiration 配套，矛盾事实共存、检索被陈旧信息污染（Mem0 自报 BEAM contradiction_resolution 35.7/32.5、10M temporal_reasoning 16.3）。追加必须与 #2/#4/#5 机制成对出现。（[Mem0 Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
5. **迷信厂商 benchmark**——DMR 已被 full-context 打穿（Zep 论文自述）；小基准可被大检索预算/前沿模型刷分（Mem0 官方警告）；各家 top-k/模型/预算不同不可横比；Supermemory/Memobase 的 SOTA 均为自报。评估应固定预算、报告 token 成本、用大规模基准。（[Zep 论文 §4.2](https://arxiv.org/html/2501.13956v1)、[Mem0 Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation.md)）
6. **把核心能力押注在厂商 OSS 路线图上**——Mem0 将图记忆从 OSS 整段移除（约 4000 行）转为 Platform 专属；Supermemory v3/v4 API 2026-12-31 关停；Zep 有 February 2026 deprecation wave；Graphiti 的 Kuzu 后端因上游死亡被弃用。本地插件的核心机制必须自主可控。（[Mem0 迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[Supermemory docs](https://supermemory.ai/docs)、[Zep v4 索引](https://help.getzep.com/v4/llms.txt)、[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
7. **默认开启的遥测与无防护的参考服务器**——Graphiti 遥测 opt-out（PostHog）、参考 MCP/REST 无认证无注入防护且官方拒绝受理相关安全报告。本地插件应遥测 opt-in、任何本地服务默认鉴权。（[Graphiti README](https://raw.githubusercontent.com/getzep/graphiti/main/README.md)）
8. **无复审、无备份的 agent 自编辑记忆**——Letta 提供「先复审再应用」、重组前备份、git 历史与 Windows 自动 dreaming 默认关闭等护栏；缺少这些的自编辑等于把记忆完整性交给模型运气。（[Letta Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)、[letta-code README](https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md)）
9. **过度提取与存原始敏感数据**——LangMem 明示过度提取降低检索精度；Mem0 明示勿存密钥/凭据/未脱敏数据；Memobase 默认处理完即删原始 blob。记忆应是蒸馏后的事实，不是转录垃圾场。（[LangMem Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[Mem0 How it works](https://docs.mem0.ai/core-concepts/how-it-works.md)、[Memobase README](https://raw.githubusercontent.com/memodb-io/memobase/main/readme.md)）
10. **把「检索」等同于「向量相似」**——Mem0 v3 的 BM25/实体/时间信号、Zep 的图遍历与提及频率、LangMem 的 importance+strength 都证明单一语义信号不够；但也要避免 Mem0 警示的反面：boost 信号不应擅自扩大召回集合。（[Mem0 迁移指南](https://docs.mem0.ai/migration/oss-v2-to-v3.md)、[Zep 论文 §3](https://arxiv.org/html/2501.13956v1)、[LangMem Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)）

---

*报告完。所有引用 URL 均为 2026-11-13 实际抓取成功的官方一手来源；未使用任何代理/镜像地址。厂商自报数字已逐处标注。*
