# 编码类 AI Agent「记忆」功能调研 · Part 2

- **调研日期**：2026-11-13（所有「现状」均以该日抓取的官方页面为准）
- **调研对象**：Cursor Memories、Windsurf Cascade Memories、Cline Memory Bank、Claude Code memory、GitHub Copilot（custom instructions + Copilot Memory + Copilot Dreaming）
- **来源纪律**：仅使用各平台真实官方一手来源（官方文档站、官方博客、官方 GitHub 仓库）。`web_search` 结果仅作线索，全部结论均经 `web_fetch` 官方原文核实；无法核实处明确标注「未能核实」，不做推断填充。未使用任何临时代理/镜像地址。

## 0. 官方域名迁移说明（影响来源 URL 的有效性）

调研期间观察到以下**官方重定向**（非第三方代理），本报告引用重定向后的官方现址：

| 原 URL | 官方现址 | 说明 |
| --- | --- | --- |
| `docs.cursor.com/context/memories` | 重定向至 [cursor.com/docs/rules](https://cursor.com/docs/rules) | Cursor 文档迁至 cursor.com/docs；**Memories 专页已不存在**（见 §1） |
| `docs.windsurf.com/windsurf/cascade/memories` | [docs.devin.ai/windsurf/plugins/cascade/memories](https://docs.devin.ai/windsurf/plugins/cascade/memories) | Windsurf 已并入 Cognition，编辑器更名 Devin Desktop，文档迁至 docs.devin.ai；旧路径 404，Memories 文档现位于 Windsurf Plugins（JetBrains）章节 |
| `windsurf.com/blog` | [devin.ai/blog](https://devin.ai/blog) | 官方博客迁移，Wave 1/2 等历史文章保留 |
| `docs.github.com` 各页 | 同站；另经官方开源仓库 [github/docs](https://github.com/github/docs) 的 raw 文件核对全文 | raw.githubusercontent.com/github/docs 属 GitHub 官方 GitHub |
| `anthropic.com/engineering/claude-code-best-practices` | 官方重定向链 → code.claude.com → www.claude.com → claude.com，最终抓取失败 | 该博客**未能核实**；Claude Code 全部所需事实已由 [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) 核实 |

---

## 1. Cursor Memories

### 1.0 现状与时间线（重要前提）

- **2025-06-04，Cursor 1.0**：Memories 以 beta 形式发布。官方 changelog 原文：「With Memories, Cursor can remember facts from conversations and reference them in the future. Memories are stored per project on an individual level, and can be managed from Settings. We're rolling out Memories as a beta feature. To get started, enable from Settings → Rules.」（[cursor.com/changelog/1-0](https://cursor.com/changelog/1-0)）
- **2026-11-13 核实**：官方文档索引 [cursor.com/llms.txt](https://cursor.com/llms.txt) 中**已无任何 Memories 页面**；原 memories 文档路径重定向到 [Rules](https://cursor.com/docs/rules)；[Rules 文档](https://cursor.com/docs/rules)与[帮助中心 Rules 页](https://cursor.com/help/customization/rules)全文均不再提及 Memories。即：**原生 Memories 的官方文档已下线，Rules 成为官方文档中唯一的持久化指令机制**。
- [2.0 changelog（2025-10-29）](https://cursor.com/changelog/2-0)与 [2.1 changelog（2025-11-21）](https://cursor.com/changelog/2-1)均未提及 Memories 的下线或迁移；**官方下线公告未能核实**（第三方社区有移除说法，按来源纪律不予采信）。
- **2026-10-20**：[Agent SDK GA](https://cursor.com/changelog)，其中包含全新的 journal 式 memory hook（[官方参考文档](https://cursor.com/docs/agent-sdk/reference/memory)），这是当前 Cursor 官方文档中唯一名为 memory 的机制。
- 背景：Cursor 于 2026-08-14 被 SpaceX 收购（[官方博客](https://cursor.com/blog/joining-spacex)，博客索引页核实）。

### 1.1 记忆模型与存储

- **1.0 时代 Memories**：从对话中提取的「事实」，**按项目、按个人**存储，Settings 中管理（[1.0 changelog](https://cursor.com/changelog/1-0)）。存储介质与文件格式官方未公开，**未能核实**。
- **当前 Rules**：`.cursor/rules/*.mdc`（项目，版本控制）、User Rules（账户级）、Team Rules（服务端）、`AGENTS.md`（纯 markdown，支持嵌套子目录）（[Rules 文档](https://cursor.com/docs/rules)）。
- **Agent SDK memory**：`memory/journal.jsonl` 追加式日志，每轮一条 JSON 记录（字段：`at`/`sessionId`/`channelId`/`status`/`title`/`userMessage`/`result`/`usage`）；增长后旧记录轮转为 `journal-*.jsonl`（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.2 写入路径（自动 vs 手动、触发时机、审批）

- **Memories（历史）**：官方仅说明「remember facts from conversations」，即对话中自动生成（[1.0 changelog](https://cursor.com/changelog/1-0)）。任务所问的 **sidecar 模型观察机制、用户审批流程、记忆生成提示词：未能核实**——原官方文档页已下线，现存官方文档/博客/changelog 均无此内容。
- **Rules**：手动创建（`/create-rule` 命令或 Customize → Rules → Add Rule）；也可让 Agent 代写、在 GitHub issue/PR 上 @cursor 更新规则（[Rules 文档](https://cursor.com/docs/rules)）。
- **Agent SDK**：`agent-sdk init` 默认脚手架 `bot/hooks/memory.ts`（`memoryHook()`），**每轮结束后自动追加一条记录**；关闭需同时删除 hook 与 instructions.md 中的 `## Memory` 段（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。无审批环节。

### 1.3 检索与注入方式

- **Rules**：应用时注入到模型上下文开头；四种触发模式由 frontmatter 决定——`alwaysApply:true` 每次注入；`globs` 匹配文件在上下文时自动附加；`description` 由 Agent 判断相关性拉取；均无则仅 @-mention 手动引用。规则中 `@file` 引用**不内联**，由 Agent 按需读取（[Rules 文档](https://cursor.com/docs/rules)）。
- **Agent SDK**：**没有 recall 工具**；instructions.md 的 `## Memory` 段告诉模型何时用文件工具读 `memory/` 目录，并把记录视为**不可信历史**（untrusted history）；Cursor 托管环境在会话开始时告知 journal 位置（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。
- **Memories（历史）**的检索方式：官方现存来源无描述，**未能核实**。

### 1.4 用户控制

- Memories：Settings 管理、Settings → Rules 启用（[1.0 changelog](https://cursor.com/changelog/1-0)）；更细粒度控制**未能核实**。
- Rules：Customize 面板可见全部规则及状态；Team Rules 可被管理员设为 Enforce（成员不可关闭）；User Rules 随账户同步，`~/.cursor/rules` 本机不同步（[帮助中心 Rules](https://cursor.com/help/customization/rules)）。
- Agent SDK：删除 hook+指令段即关闭；本地删除项目状态目录中的 `memory/` 清空记录；托管环境适用 Privacy Mode（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.5 作用域

- Memories：**项目级 + 个人级**（[1.0 changelog](https://cursor.com/changelog/1-0)）。
- Rules：项目 / 用户（全局）/ 团队（跨仓库）；`AGENTS.md` 支持子目录嵌套、就近优先（[Rules 文档](https://cursor.com/docs/rules)）；Rules 只作用于 Agent (Chat)，不影响 Tab 补全与 Bugbot（[帮助中心 Rules](https://cursor.com/help/customization/rules)）。
- Agent SDK journal：**所有会话与用户共享一个 journal**（官方明确列为 caveat）（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.6 冲突与更新策略

- Rules 优先级：**Team Rules → Project Rules → User Rules**，全部合并、靠前来源在冲突时优先（[Rules 文档](https://cursor.com/docs/rules)、[帮助中心](https://cursor.com/help/customization/rules)）。
- 同名规则按完整路径识别，不构成覆盖（[帮助中心](https://cursor.com/help/customization/rules)）。
- Memories 的冲突/更新策略：**未能核实**。
- Agent SDK：记录只追加不修改；官方提示记录可能丢失或迟到，关键状态应放 `ctx.host.kv`/`ctx.host.files`（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.7 遗忘与衰减

- 官方现存来源均未描述 Memories 或 Rules 的自动遗忘/衰减，**未能核实**。
- Agent SDK journal 仅轮转归档、不自动删除；关闭 memory 也不删除已有记录（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.8 特色亮点

- 历史上较早把「对话自动沉淀事实」做成产品功能，且**项目级 + 个人级**双隔离（[1.0 changelog](https://cursor.com/changelog/1-0)）。
- Rules 的四触发模式（always/glob/description/manual）是精细的上下文预算控制（[Rules 文档](https://cursor.com/docs/rules)）。
- 跨工具兼容：`AGENTS.md` 嵌套支持；`CLAUDE.md` 按 AGENTS.md 同等读取且恒为 always-apply（[帮助中心](https://cursor.com/help/customization/rules)）。
- Agent SDK 的 journal 设计极简：一个 hook + 一个 JSONL + 一段指令，模型用通用文件工具自取，无专用检索基础设施（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

### 1.9 明显短板

- **原生 Memories 文档静默消失**：截至 2026-11-13，官方文档索引无 Memories、原路径重定向至 Rules，且已核实的 2.0/2.1 changelog 无下线/迁移说明——用户沉淀的知识资产缺乏官方出口（[llms.txt](https://cursor.com/llms.txt)、[2.0](https://cursor.com/changelog/2-0)、[2.1](https://cursor.com/changelog/2-1)）。
- Agent SDK journal **跨用户共享**：官方自认「one person's messages can surface in another's session」，多人场景有隐私与注入风险（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。
- 无检索工具、无衰减、无审批：journal 只增不减，依赖模型自觉读取与「不可信历史」指令兜底（[memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)）。

---

## 2. Windsurf Cascade Memories

### 2.0 现状与时间线

- **2024-12-11，Wave 1**：显式 Memories 首发——全局 rules（Cascade UI 内设置）+ workspace 级 `.windsurfrules`。官方定位：memories 教 Cascade「how to do work」而不仅是产出长什么样（[Windsurf Wave 1 博客](https://devin.ai/blog/windsurf-wave-1)）。
- **2025-01-17，Wave 2**：**Automated Memories** 发布——Cascade 自动从使用模式中学习并存入「bank of Memories」，用户可随时 inspect 和 edit；逐步灰度 rollout（[Windsurf Wave 2 博客](https://devin.ai/blog/windsurf-wave-2)）。
- **2026-11-13 核实**：Windsurf 已并入 Cognition（官方博客署名 Cognition），编辑器更名 Devin Desktop；**Cascade 成为 legacy agent**——Devin Desktop 不再新建 Cascade 会话、也不再打开旧会话，新会话使用 Devin Local（[Cascade (legacy) 文档](https://docs.devin.ai/desktop/cascade)）。Memories & Rules 的官方文档现位于 Windsurf Plugins（JetBrains）章节（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 新 agent **Devin Local 的自定义机制为 Rules/Skills/Plugins/MCP/Hooks，不含 memories**；legacy `.windsurf/rules`、`.windsurf/global_rules.md`、`.windsurfrules` 会被默认导入（[Devin Local Customizations](https://docs.devin.ai/desktop/devin-local/customizations)）。

### 2.1 记忆模型与存储

- 官方定义：「Memories is the system for sharing and persisting context across conversations」，两种机制：**Cascade 自动生成的 Memories** + **用户手动定义的 rules**（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- Rules 存储：`global_rules.md`（全局）；`.windsurf/rules` 目录（workspace 级，规则可绑定 globs 或自然语言描述）；单文件上限 **12000 字符**（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 自动 memories 的存储位置/文件格式：官方文档未公开，**未能核实**。

### 2.2 写入路径（自动 vs 手动、触发时机、审批）

- **自动**：对话过程中，Cascade 遇到它认为值得记住的上下文时自动生成并存储（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- **手动**：随时提示「create a memory of ...」创建记忆；rules 通过 Customizations → Rules 面板 `+ Global` / `+ Workspace` 创建（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- **审批**：文档未描述生成前审批环节——自动记忆直接生成，用户**事后**查看/编辑（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)；[Wave 2 博客](https://devin.ai/blog/windsurf-wave-2)）。
- 官方 TIP：**创建与使用自动 memories 不消耗 credits**（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。

### 2.3 检索与注入方式

- 自动 memories 与生成它的 workspace 绑定，Cascade **在它认为相关时检索**（relevance-based，非全量注入）（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- Rules 发现：当前 workspace 及所有子目录的 `.windsurf/rules`；git 仓库向上搜索至 git root；多文件夹 workspace 去重、按最短相对路径展示（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- Cascade 的后台 planning agent 会在对话中拾取新信息（官方举例「such as a Memory」）时自动更新长期计划（[Cascade (legacy)](https://docs.devin.ai/desktop/cascade)）。

### 2.4 用户控制

- Cascade 右上角滑出菜单 **Customizations** 图标：随时访问/配置 Memories 与 Rules；点击记忆 → **Edit** 按钮编辑（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 企业 **System-Level Rules**：OS 级目录部署（macOS `/Library/Application Support/Windsurf/rules/*.md`；Linux/WSL `/etc/windsurf/rules/*.md`；Windows `C:\ProgramData\Windsurf\rules\*.md`），UI 带「System」标签，终端用户**不可删除**，建议 IT/安全团队经 MDM 管理（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。

### 2.5 作用域

- **自动 memories：workspace 级**——一个 workspace 生成的记忆在另一个 workspace 不可用（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- Rules：global（跨 workspace）/ workspace / system（企业全局）三级（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。

### 2.6 冲突与更新策略

- System rules 与 workspace/global rules **合并不覆盖**（merged without overriding），组织定基线、团队可叠加（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 记忆间的冲突消解策略：官方未描述，**未能核实**。

### 2.7 遗忘与衰减

- 官方文档未描述自动遗忘/衰减机制，**未能核实**；用户可手动编辑（Edit）记忆（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。

### 2.8 特色亮点

- **显式 + 隐式双轨**演进清晰：Wave 1 先做规则式显式记忆，Wave 2 补自动学习，官方明言「 telling Cascade how you want work to be done is good, Cascade learning how you do work would be even better」（[Wave 1](https://devin.ai/blog/windsurf-wave-1)、[Wave 2](https://devin.ai/blog/windsurf-wave-2)）。
- 自动记忆**免费**（不耗 credits），降低使用门槛（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 企业 system-level rules 的 MDM 部署路径完整，且「合并不覆盖」避免组织规则碾碎项目定制（[同上](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。

### 2.9 明显短板

- **机制随 agent 换代而断档**：Cascade 已 legacy，Devin Local 的自定义体系中没有 memories，自动记忆积累无法迁入新 agent（[Cascade (legacy)](https://docs.devin.ai/desktop/cascade)、[Devin Local Customizations](https://docs.devin.ai/desktop/devin-local/customizations)）。
- 记忆 workspace 隔离、不进版本控制、不随团队共享——跨项目/跨成员知识无法流动（[Memories & Rules](https://docs.devin.ai/windsurf/plugins/cascade/memories)）。
- 存储格式、生成提示词、衰减与冲突策略均不透明（官方文档未公开）。

---

## 3. Cline Memory Bank

### 3.0 定位与时间线

- 官方定义：Memory Bank 是一套 **documentation methodology**（文档方法论），通过结构化 markdown 文件把 Cline 从 stateless assistant 变成 persistent development partner；**不是内置产品功能**，而是「自定义指令 + 项目内文件组」的实现（[Memory Bank 文档](https://docs.cline.bot/best-practices/memory-bank)，原路径 `/prompting/cline-memory-bank` 官方重定向至此）。
- 文档未标注发布日期；以 2026-11-13 抓取为准。官方 FAQ 明确该方法论**工具无关**：「works with any AI that can read docs」（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.1 记忆模型与存储

- 项目内 `memory-bank/` 目录，六个核心文件构成层级（projectbrief 为地基，塑造其余文件）：

| 文件 | 职责 |
| --- | --- |
| `projectbrief.md` | 基础文档：核心需求与目标，项目范围的 source of truth |
| `productContext.md` | 项目为何存在、解决什么问题、UX 目标 |
| `activeContext.md` | 当前焦点、最近变更、下一步（**更新最频繁**） |
| `systemPatterns.md` | 架构、设计模式、组件关系、关键实现路径 |
| `techContext.md` | 技术栈、开发环境、约束、依赖 |
| `progress.md` | 已完成/待建、当前状态、已知问题 |

（[Memory Bank 文档](https://docs.cline.bot/best-practices/memory-bank)）
- 可按需在 `memory-bank/` 内增设文件/子目录（复杂特性文档、集成规格、API 文档、测试策略、部署流程等）（[同上](https://docs.cline.bot/best-practices/memory-bank)）。
- 全部为普通 markdown，人与 Cline 均可直接读写，可随仓库 git 共享（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.2 写入路径（自动 vs 手动、触发时机、审批）

- **完全显式、指令驱动**，无自动生成、无审批 UI。官方提示词规定更新触发时机：(1) 发现新项目模式；(2) 实现重大变更后；(3) 用户发出 **update memory bank**（必须 review 全部文件）；(4) 上下文需要澄清时（[Memory Bank 自定义指令原文](https://docs.cline.bot/best-practices/memory-bank)）。
- 三个关键口令：`initialize memory bank`（新项目建结构）、`update memory bank`(全量文档审查更新)、`follow your custom instructions`（读取 Memory Bank 接续上次工作）（[同上](https://docs.cline.bot/best-practices/memory-bank)）。
- 落地方式：把官方自定义指令复制到 Cline Rules 文件（如 `.clinerules/memory-bank.md`）或全局 custom instructions（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.3 检索与注入方式

- **全量读取，非选择性检索**：官方指令原文「I MUST read ALL memory bank files at the start of EVERY task - this is not optional」——每个任务开始读全部记忆文件（[Memory Bank 自定义指令](https://docs.cline.bot/best-practices/memory-bank)）。
- 上下文窗口管理流程（手动）：窗口将满 → `update memory bank` 落盘 → 新开会话 → `follow your custom instructions` 恢复；配合内置 `/newtask`、`/smol` 命令；FAQ 建议日常交给 Auto Compact，重要检查点才手动 update（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.4 用户控制

- 文件即界面：纯 markdown，用户随时直接编辑；指令放全局 custom instructions（跨项目）或项目 Cline Rules（随仓库共享）；可用 **conditional rules** 让 Memory Bank 指令仅在操作 `memory-bank/` 文件时激活（[Memory Bank FAQ](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.5 作用域

- **项目级**（文件在仓库内，可 git 共享给协作者）；承载指令的 rules 可选全局或项目级（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.6 冲突与更新策略

- `update memory bank` 触发**全量审查**（MUST review ALL files）；`activeContext.md` 每会话后更新、`progress.md` 恢复工作时复查；重大里程碑或方向变化后更新（[Memory Bank 文档](https://docs.cline.bot/best-practices/memory-bank)）。
- 无自动冲突消解；一致性靠指令与人工维护。

### 3.7 遗忘与衰减

- 无自动遗忘/衰减；过期内容靠全量审查时人工/指令驱动清理（[同上](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.8 「记忆重置」问题的解法（核心设计）

官方提示词开宗明义：「I am Cline, an expert software engineer with a unique characteristic: **my memory resets completely between sessions**. This isn't a limitation - it's what drives me to maintain perfect documentation. After each reset, I rely ENTIRELY on my Memory Bank...」——把「会话间记忆完全重置」重构为**维护完美文档的驱动力**，Memory Bank 是重置后与既往工作的唯一纽带，因此强制每任务全读、精确保鲜（[Memory Bank 自定义指令原文](https://docs.cline.bot/best-practices/memory-bank)）。

### 3.9 特色亮点 / 明显短板

- **亮点**：零基础设施成本（一段提示词 + markdown 文件）；人类完全可读可审计；git 版本化、团队共享；工具无关可移植；官方给出完整可复制的提示词文本（[Memory Bank 文档](https://docs.cline.bot/best-practices/memory-bank)）。
- **短板**：每任务全读所有文件，上下文成本随项目文档量线性增长，无选择性检索/排序；依赖模型遵从指令，无强制执行；无自动沉淀——用户不喊 update 就不更新；无衰减机制，文档膨胀后全读更贵（均由[官方文档](https://docs.cline.bot/best-practices/memory-bank)机制直接推出）。

---

## 4. Claude Code memory

> 来源：[code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)（2026-11-13 抓取全文，含 AGENTS.md 章节）。任务点名的 anthropic.com 工程博客经官方重定向链（→ code.claude.com → www.claude.com → claude.com）最终抓取失败，**未能核实**；本节全部事实以官方文档页为准。文档以版本号而非日期标注功能时间点，下文照录。

### 4.1 记忆模型与存储

双轨制，官方对比表（[memory 文档](https://code.claude.com/docs/en/memory)）：

| | CLAUDE.md 文件 | Auto memory |
| --- | --- | --- |
| 谁写 | 用户 | Claude 自己 |
| 内容 | 指令与规则 | 学到的经验与模式 |
| 作用域 | 项目 / 用户 / 组织 | 按 git 仓库，worktrees 共享 |
| 注入 | 每个会话全量 | 每个会话注入 MEMORY.md 前 200 行或 25KB |
| 用途 | 编码标准、工作流、架构 | 用户偏好、纠正、代码中推不出的项目上下文 |

- 两者都在每次会话开始加载；**是 context 而非强制配置**——硬性阻断要用 PreToolUse hook（[同上](https://code.claude.com/docs/en/memory)）。
- **CLAUDE.md 层级**（加载顺序从宽到窄，拼接而非覆盖）：
  1. **Managed policy（企业）**：macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux/WSL `/etc/claude-code/CLAUDE.md`；Windows `C:\Program Files\ClaudeCode\CLAUDE.md`；也可用 managed-settings.json 的 `claudeMd` 键内联；`claudeMdExcludes` 不能排除它。
  2. **User**：`~/.claude/CLAUDE.md`（个人全局）。
  3. **Project**：`./CLAUDE.md` 或 `./.claude/CLAUDE.md`（团队经 git 共享）。
  4. **Local**：`./CLAUDE.local.md`（个人项目级，建议 gitignore）。
  （[同上](https://code.claude.com/docs/en/memory)）
- **Auto memory 存储**：`~/.claude/projects/<project>/memory/`，`<project>` 由 git 仓库派生 → 同仓库所有 worktree/子目录共享一个目录；非 git 环境用项目根。目录含 **`MEMORY.md` 索引**（每条记忆一行）+ **每条记忆一个 topic 文件**（如 `user_role.md`、`feedback_testing.md`）。机器本地，不跨机器/云共享；**不被 `cleanupPeriodDays` 会话转录清理波及**，持久保留直到人或 Claude 编辑/删除（[同上](https://code.claude.com/docs/en/memory)）。

### 4.2 写入路径（自动 vs 手动、触发时机、审批）

- **CLAUDE.md**：人工编写；`/init` 分析代码库自动生成初版（已有文件则建议改进不覆盖）；`CLAUDE_CODE_NEW_INIT=1` 时 `/init` 变为多阶段交互（子代理探索 + 追问 + 可审查提案后才写文件）（[memory 文档](https://code.claude.com/docs/en/memory)）。
- **Auto memory**：Claude 工作中自动沉淀四类笔记（frontmatter `type` 字段）：`user`（角色/专长/偏好）、`feedback`（用户纠正与确认的做法）、`project`（代码/git 历史推不出的进行中工作、期限、决策）、`reference`（外部信息位置如 issue tracker）。**跳过可从代码库推导的内容，跳过 CLAUDE.md 已写的内容**；不是每会话都写，按「未来会话是否有用」判断。用户说「remember ...」→ 存入 auto memory；说「add this to CLAUDE.md」→ 显式写入指令文件（[同上](https://code.claude.com/docs/en/memory)）。
- **审批**：auto memory 无逐条审批；但**项目级记忆文件的外部 import**（路径解析到工作目录之外，如 `@~/.claude/...`）首次遇到时弹审批对话框列出文件，拒绝则永久禁用；用户级文件的 import 默认信任（Cowork 桌面会话例外，跳过越界 import 与符号链接）（[同上](https://code.claude.com/docs/en/memory)）。
- 开关：本地会话默认开；self-hosted 默认关（Claude Tag 除外）；`/memory` 面板 toggle 写入 `~/.claude/settings.json` 的 `autoMemoryEnabled`；项目级 `autoMemoryEnabled:false`；环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`；后台会话/嵌套会话中关闭后无法就地重开（[同上](https://code.claude.com/docs/en/memory)）。

### 4.3 检索与注入方式

- **CLAUDE.md**：启动时加载 cwd 及其所有祖先目录的 CLAUDE.md/CLAUDE.local.md，从文件系统根向 cwd 排序拼接，每层 local 追加在 CLAUDE.md 之后；**子目录文件按需加载**（Claude 读/写/编辑该子目录文件时，含 `cat`/`head` 等视为读的 Bash 命令）；HTML 块注释注入前剥离；`--add-dir` 目录默认不加载，需 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`（[memory 文档](https://code.claude.com/docs/en/memory)）。
- **imports 语法**：`@path/to/import`，相对路径相对**包含 import 的文件**解析；支持绝对路径；递归 import 最深 **4 跳**；路径含空格用反斜杠转义（引号包裹反而不 import）；代码 span/围栏内的 `@` 不解析；import 与宿主文件一起加载，**不省上下文**（[同上](https://code.claude.com/docs/en/memory)）。
- **Auto memory**：每会话开始只注入 `MEMORY.md` **前 200 行或前 25KB（先到为准）**；topic 文件**不**在启动时加载，Claude 用标准文件工具按需读取；界面出现「Saved 2 memories」「Recalled 2 memories」即在读寫 memory 目录；带 YAML frontmatter 的记忆文件写入时记录 `modified` ISO 8601 时间戳供判断新鲜度（[同上](https://code.claude.com/docs/en/memory)）。
- **AGENTS.md 兼容**（v2.1.277+）：默认 `claude-md-or-agents-md`——cwd 及以上无 CLAUDE.md/CLAUDE.local.md 时读 AGENTS.md；`/config` 可切 `claude-md-and-agents-md` / `claude-md` / `managed-only`；`~/.claude/CLAUDE.md`、managed CLAUDE.md、`.claude/rules/` 不参与该判定；子目录 AGENTS.md 按需加载；直接加载的 AGENTS.md 不触发 InstructionsLoaded hook（[同上](https://code.claude.com/docs/en/memory)）。
- **path-scoped rules**：`.claude/rules/*.md` 用 frontmatter `paths` glob 限定，仅在操作匹配文件时加载；用户级 `~/.claude/rules/` 先于项目级加载，两者不互相覆盖（[同上](https://code.claude.com/docs/en/memory)）。
- `/compact` 后项目根 CLAUDE.md 从磁盘重读重注入；嵌套/路径规则按需再加载（[同上](https://code.claude.com/docs/en/memory)）。

### 4.4 用户控制

- `/memory`：列出用户/项目各作用域的 CLAUDE.md、CLAUDE.local.md 及其他记忆文件位置（含尚不存在的条目，选中即创建）、auto memory 开关、打开 auto memory 目录；选中文件在编辑器打开（[memory 文档](https://code.claude.com/docs/en/memory)）。
- `/context all` 查看 Memory files 验证加载；`/doctor prompt-audit`（v2.1.283+）审计过时/冲突指令（含 rules/skills/commands/subagents/output styles），出报告与修改建议，**用户同意前不改文件**；`/doctor` 还会为过长的 CLAUDE.md 提议裁剪（删可从代码推导的内容，留 pitfalls/rationale/约定）（[同上](https://code.claude.com/docs/en/memory)）。
- auto memory 文件是纯 markdown，随时可读可改可删；`autoMemoryDirectory` 可自定义存储位置（受 workspace trust 与 `blockReadsOutsideWorkingDirectories` 约束）（[同上](https://code.claude.com/docs/en/memory)）。
- 子代理：主会话 auto memory 不加载进子代理（fork 例外）；子代理可用 `memory` 字段启用**独立目录**的自有记忆（[同上](https://code.claude.com/docs/en/memory)）。

### 4.5 作用域

- CLAUDE.md：组织（managed）/ 用户 / 项目 / 本地个人四级 + 目录树层级；auto memory：**按 git 仓库**（worktrees 共享）、机器本地；子代理记忆独立（[memory 文档](https://code.claude.com/docs/en/memory)）。

### 4.6 冲突与更新策略

- 所有发现的文件**拼接而非覆盖**；官方明言：两条指令冲突时「Claude may pick one arbitrarily」，用户级与项目级规则互不覆盖——靠保持一致 + `/doctor prompt-audit` 治理（[同上](https://code.claude.com/docs/en/memory)）。
- MEMORY.md 接近 200 行/25KB 上限时系统提醒 Claude 精简（一行一条、细节移入 topic 文件、合并/丢弃陈旧条目）；超限时写入仍成功但返回错误要求重写索引（超出部分下次加载即丢弃）（[同上](https://code.claude.com/docs/en/memory)）。

### 4.7 遗忘与衰减

- 无自动时间衰减；记忆文件保留至人或 Claude 编辑/删除；`modified` 时间戳辅助判断时效；索引限额机制间接强制合并/丢弃陈旧条目；CLAUDE.md 超 4MiB 整文件跳过，按需加载文件有更小的每文件字符上限（200K 上下文：40,000 字符；1M 上下文：Opus 4.6/Sonnet 4.6 为 200,000、后续模型 150,000；v2.1.309 前无此限制）（[memory 文档](https://code.claude.com/docs/en/memory)）。

### 4.8 特色亮点

- **索引 + topic 文件两层结构**：注入成本有硬上限（200 行/25KB），细节按需取——兼顾「常驻记忆」与上下文预算（[同上](https://code.claude.com/docs/en/memory)）。
- **写入去重原则**：跳过代码可推导内容与 CLAUDE.md 已有内容，四类 type 分类清晰，从源头抑制记忆膨胀（[同上](https://code.claude.com/docs/en/memory)）。
- **外部 import 审批**：防他人经共享仓库注入指令，一次审批、拒绝永久生效（[同上](https://code.claude.com/docs/en/memory)）。
- 治理工具化：prompt-audit、/context、InstructionsLoaded hook、超限提醒/报错形成闭环（[同上](https://code.claude.com/docs/en/memory)）。
- AGENTS.md 原生兼容 + `/import` 迁移其他工具配置，降低跨工具记忆迁移成本（[同上](https://code.claude.com/docs/en/memory)）。

### 4.9 明显短板

- **无确定性冲突优先级**：官方承认冲突时模型可能任选其一（[同上](https://code.claude.com/docs/en/memory)）。
- 指令非强制：CLAUDE.md 以 system prompt 之后的 user message 注入，不保证严格遵从（[同上](https://code.claude.com/docs/en/memory)）。
- auto memory 机器本地、不随团队共享，团队级知识只能走 CLAUDE.md/rules（[同上](https://code.claude.com/docs/en/memory)）。
- 静默截断风险：索引超限写入仍成功、按需文件超限只注入开头（附提示让模型自读剩余），信息可能实际未进上下文（[同上](https://code.claude.com/docs/en/memory)）。

---

## 5. GitHub Copilot

### 5.0 现状与时间线

- **Custom instructions**：长期存在的用户手写指令机制（见 §5.1–5.2）。
- **2025-12-19**：Copilot memory **public preview**，面向 Pro/Pro+，支持 Copilot coding agent 与 Copilot code review；Settings > Copilot 开启（[官方 changelog](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro/)）。
- **2026-01-15**：官方工程博客《Building an agentic memory system for GitHub Copilot》发表（作者 Tiferet Gazit，principal ML engineer；2026-11-12 更新为 GA 措辞），阐述 cross-agent memory 与 just-in-time verification 设计（[博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)，全文经同域官方 WP REST API 核实）。
- **2026-10-28**：「GitHub intelligence」发布——**Copilot Memory GA**（全部付费计划，跨 app/CLI/VS Code/cloud agent/code review/Slack/Teams/Mobile）；**Copilot Dreaming public preview**（[官方 changelog](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)）。
- 任务所问「coding agent 是否已有官方 memory」：**已有**，且 coding agent（现文档称 cloud agent）是记忆的首发与核心 surface 之一（[2025-12-19 changelog](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro/)、[Memory 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.1 Custom instructions（手写指令层）

- 三个层级：**Personal**（github.com 个人设置，作用于 Copilot Chat；CLI 用本地文件）、**Repository**、**Organization**（仅 Business/Enterprise，作用于全体成员）（[Custom instructions 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)）。
- Repository 三种文件（[Add repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)）：
  1. **Repository-wide**：`.github/copilot-instructions.md`，自然语言 markdown；
  2. **Path-specific**：`.github/instructions/NAME.instructions.md`，匹配路径时与 repo-wide 叠加使用；github.com 上目前仅 cloud agent 与 code review 支持；
  3. **Agent instructions**：`AGENTS.md`（也接受根部单个 `CLAUDE.md` 或 `GEMINI.md`）；注意与 `.github/agents` 的自定义 agent 定义文件不同。
- **优先级**：多数客户端（CLI/VS Code/VS）合并所有适用文件、无通用优先级；github.com Chat 明确为 Personal > path-specific > repository-wide > agent instructions > Organization（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)）。
- **自动生成**：可让 cloud agent 生成 `copilot-instructions.md`——官方给出完整 onboarding 提示词（Goals：减少 CI 失败/命令失败/探索成本；Limitations：≤2 页、非任务特定；WhatToAdd：高层信息、**逐条运行验证过的** build/test/lint 命令与顺序、项目布局；StepsToFollow：全库清点），产出 draft PR 并加你为 reviewer；仓库首个 cloud agent PR 会留自动生成链接评论（[Add repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)）。
- Code review 默认启用 custom instructions，可在仓库 Settings → Copilot → Code review 关闭（[同上](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)）。
- 官方明确：custom instructions **不保证**生成内容合规（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)）。

### 5.2 Copilot Memory：记忆模型与存储

- 两种记忆类型（[Memory 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）：
  - **Repository-level facts**：代码库事实（约定、架构决策、build/test 命令、项目规则），**与协作者共享**，属于单个仓库，仓库设置中查看/删除；fork 不继承；不跨组织仓库池化。
  - **User-level preferences**：个人工作方式（呈现偏好、需审批的动作、跨项目工作流），**跟人走、跨仓库**，存于用户设置；Business/Enterprise 下归 **billing entity**（发放许可证的组织/企业）所有，按当前活跃 billing entity 检索，管理员可查看/导出/删除；多许可证用户须先选默认 billing entity 才能新建记忆。
- 每条记忆的数据字段：memory text、subject area、agent、model、billing entity（设置页可见）；citations、reason for storing、类型、**voting data**、**expiry datetime**（内部使用，不展示、不入审计日志）（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- 服务端存储（非本地文件）；记忆计入上下文 token，消耗 AI credits（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.3 写入路径（自动 vs 手动、触发时机、审批）

- **自动为主**：Copilot 工作中作为副产品自行创建——注意到值得保留的持久事实/偏好即存储；实现为 **agent 可调用的工具**（博客示例 `store_memory`，记录 `{subject, fact, citations:[文件:行号...], reason}`）（[Memory 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)、[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- **手动影响**：明确陈述偏好/事实或显式要求「remember ...」大概率被捕获（你的原话成为 citation）；**不能在 github.com 设置中直接创建/编辑单条记忆**；CLI 支持批量导入预备记忆（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- **类型判定**：按「适用于谁」而非「谁说的」分类；意图模糊时**反问用户澄清作用域**；repo facts 仅当在你有 write 权限的仓库中工作时创建；user prefs 仅当能识别你身份时创建（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- **审批**：Copilot app 与 CLI 交互会话**可能请求存储批准**；**cloud agent 与 code review 不请求批准**（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- CLI 权限：仅 root agent 可用 `store_memory`/`vote_memory`；子代理有 `read_memories` 时只读（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.4 检索与注入方式

- 会话开始时检索目标仓库**最近的记忆**注入 prompt（博客；未来计划 search 工具与加权排序）（[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- **Just-in-time verification**：每条记忆带 **citations**（支撑代码位置）；使用前 agent 实时核对 citations 与当前分支——代码矛盾或 citation 失效则存修正版；验证通过且有用则再存一次刷新时间戳。官方称验证只是少量读操作、测试中无显著延迟（[同上](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- **并非全部记忆都注入**：upvote 的记忆更可能被发送；repo facts 的 citation 核对是模型判断而非系统保证（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- **跨 surface/跨 agent 共享**：一个 surface 捕获的事实/偏好可被另一个使用（cloud agent 学到数据库连接方式 → code review 用于发现不一致；code review 学到两文件需同步 → cloud agent 改一处时同改另一处）（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)、[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。

### 5.5 用户控制

- 个人设置查看/删除 user-level preferences；仓库设置查看/删除 repo facts（需 write 权限且账户启用 user prefs）；**不能编辑单条**，不想再用就显式删除（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- 四层开关：个人设置（仅管 user prefs）→ 组织/企业策略（多许可证取最严）→ 仓库访问与设置（org 可选 all/selected/none，仓库管理员可单独关）→ 客户端本地设置（CLI `/memory off` 本机双关、`/memory on` 清除但不能越权、`/memory show` 查看；CLI 非交互需 `--enable-memory`；VS Code 本地默认关）（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- 默认值：Pro/Pro+/Max 的 user prefs **默认启用**（可 opt-out）；Business/Enterprise 默认禁用待管理员开策略；**repo facts 独立默认允许**（org Repository access 默认 All repositories）；关 prefs 不影响 facts，反之亦然（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- 管理员可批量/按用户导出或删除成员 user prefs（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- SDK：可在创建/恢复会话时启用 memory，但**无 list/edit/delete API**（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.6 作用域

- Repo facts：单仓库内，read 权限可用、write 权限可创建；隐私模型与源代码一致——「memories about a repository stay within that repository」（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)、[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- User prefs：跨仓库跟人走，但受 billing entity 隔离；**code review 与 agentic autofix 从不应用 user prefs**（个人偏好不改变 PR 审查/安全修复行为）（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.7 冲突与更新策略

- **内部投票系统**：agent 自动 upvote 可验证的记忆、downvote 错误/过时的记忆；downvote 过阈值 → 不再使用 → 闲置一段时间后删除；用户可通过会话中的正/负评价影响投票；**票数故意不展示**，但设置页按有用性排序（upvote 上浮、downvote 下沉），已学会不用的记忆从列表隐藏（隐藏≠删除）（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- **JIT 验证自愈**：对抗性测试中故意注入与代码矛盾、citation 指向不存在位置的记忆，agent 均验证发现矛盾并存修正版，记忆池自愈（[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- 已知风险：repo facts 可能来自**未合并即关闭的 PR**，官方要求核对当前代码但不保证识别所有过时事实（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- 与 custom instructions 的分工：重要规则（安全要求、强制审查步骤）写 custom instructions；积累性细节交给 memory；两者都不保证每次遵从（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.8 遗忘与衰减

- **过期机制**：无强化即过期，默认 **90 天**；org/enterprise 可为 repo facts 配置 **7–180 天**（user prefs 恒用默认值）；upvote 重置过期计时，**单纯检索不重置**，downvote 不缩短剩余时间；org 与 enterprise 配置不一致取**较小值**；改配置不追溯已存记忆（下次强化时采用新值）（[概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。
- **写入过滤**：检测到 secrets（token/key/credential）的记忆**拒存**；含已识别 model-control tokens 的记忆可被拒存（防 prompt injection）；指令层面不存敏感个人/机密/受托信息、不存短期或任务特定指令（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)）。

### 5.9 Copilot Dreaming（离线整理，2026-10-28 public preview）

- 后台分析合格会话与 PR 审查反馈，**更新记忆、纠正过时指导、去除重复记忆**；无需保持会话打开；更新的是 context 而非模型（[Dreaming 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)）。
- 三种能力：**Personal memory curation**（更新个人记忆，不动个人指令/skill 文件）、**Repository customization**（更新仓库记忆 + 提议指令/skill 变更；可审查 `.github/copilot-instructions.md`、`.github/instructions/**`、`.github/agents/**`、`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`REVIEW.md`、`.github/skills/**`）、**Code review customization**（把反复被接受的审查反馈变成未来审查指导）（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)、[GA changelog](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)）。
- **变更落地分级**：记忆自动增删改、**无需逐条审批**；已入库的 instructions/skills 变更**走 PR**、合并前不动文件；code review 内部指导直接更新不走 PR（[Dreaming 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)）。
- 前提与成本：初始预览需 GPT-6.1 Sol 访问、Pro 不可用、不支持 GHEC 数据驻留；前两种能力需 session syncing（本地会话同步上云）；**每次运行都消耗 AI credits，包括无变更运行与不活跃仓库**；无按 app 的独立预算；opt-in（个人/仓库/组织策略分级开启）；关闭不回滚已做变更、不恢复已删记忆（[同上](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)）。

### 5.10 效果数据（官方自述）

- 工程博客 A/B：coding agent **PR 合并率 90% vs 83%**（+7pp）；code review 评论**正面反馈 77% vs 75%**（+2pp）；p<0.00001。离线评估（含大量废弃分支噪声记忆）：code review **precision +3%、recall +4%**（[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)）。
- GA changelog：预览期使用记忆的 CLI 会话中 **93% 表现出更好的开发者偏好遵从、42% 工作流更高效**（[changelog](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)）。

### 5.11 特色亮点 / 明显短板

- **亮点**：citations + JIT 验证（利用「检索难、验证易」的不对称性，避免离线整理的工程复杂度与 LLM 成本）；投票 + 过期双衰减；跨 agent 共享知识库（经验从资深成员 PR 自动传递给新人）；repo facts / user prefs 双类型所有权与 billing entity 隔离；secrets/model-control token 写入过滤；Dreaming 把离线整理与在线读取分离、仓库文件变更走 PR 人审（[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)、[Memory 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)、[Dreaming 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)）。
- **短板**：单条记忆不可手动创建/编辑，只能影响或删除；投票数不透明（故意隐藏），用户难解释「为何用/不用某条记忆」；cloud agent/code review 静默写入共享 repo facts 且可能捕获未合并 PR 的过时事实；Dreaming 成本黑洞（无变更/不活跃仓库也计费、无按 app 预算、alerts 不停用量）；记忆不保证被遵从（官方自认）（[Memory 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)、[Dreaming 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)）。

---

## 6. 精华：值得借鉴的机制

| # | 机制（来源） | 为什么好 | 实现代价直觉 |
| --- | --- | --- | --- |
| 1 | **Citations + just-in-time verification**（[Copilot 工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)） | 把「记忆是否仍有效」从离线整理难题变成读时少量读操作；对抗注入可自愈；官方测试无显著延迟 | **低–中**：记忆结构加 citations 字段 + 一段验证提示词；无需后台服务 |
| 2 | **投票 + 过期双衰减**（[Copilot Memory 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)） | 有用性排序决定注入概率，90 天无强化过期兜底；upvote 续期鼓励复用，检索不续期防「僵尸记忆」 | **中**：投票计数、阈值退役、过期调度；字段已内建于记忆模型 |
| 3 | **MEMORY.md 索引 + topic 文件两层注入**（[Claude Code 文档](https://code.claude.com/docs/en/memory)） | 常驻注入有硬上限（200 行/25KB），细节按需读；超限提醒/报错强制索引保鲜 | **低**：纯文件约定 + 提示词 + 一个大小检查 |
| 4 | **写入去重原则 + 四类 type 分类**（[Claude Code 文档](https://code.claude.com/docs/en/memory)） | 「代码可推导的不存、CLAUDE.md 已有的不存」从源头抑制膨胀；user/feedback/project/reference 分类便于治理 | **低**：提示词原则，无额外基础设施 |
| 5 | **结构化 markdown + 显式读写仪式**（[Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank)） | 零基础设施、人类可审计、git 共享、工具无关；把「记忆重置」重构为文档纪律 | **极低**：一段官方提示词 + 六个文件模板 |
| 6 | **repo facts / user prefs 双类型所有权 + billing entity 隔离**（[Copilot Memory 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)） | 团队共享知识与个人隐私分离；企业可治理（导出/删除/策略）；作用域模糊时反问而非猜测 | **中**：权限模型 + 设置 UI + 策略层 |
| 7 | **外部 import 审批对话框**（[Claude Code 文档](https://code.claude.com/docs/en/memory)） | 阻断经共享仓库提交的指令注入；一次审批、拒绝永久生效，信任边界清晰 | **低**：路径解析 + 一次性确认 UI |
| 8 | **Dreaming 离线整理 + 仓库文件变更走 PR**（[Copilot Dreaming 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)） | 在线读取与离线整理分离；记忆自动维护但**入库文件变更保留人审闸门**，分级落地 | **高**：后台作业、会话同步、计费与预算体系 |
| 9 | **规则四触发模式（always/glob/description/manual）**（[Cursor Rules](https://cursor.com/docs/rules)） | 上下文预算精细控制：恒注入/文件匹配/模型判断/手动，避免全量常驻 | **低–中**：frontmatter 解析 + 匹配逻辑 |
| 10 | **自动记忆免费 + modified 时间戳 + prompt-audit**（[Windsurf](https://docs.devin.ai/windsurf/plugins/cascade/memories)、[Claude Code](https://code.claude.com/docs/en/memory)） | 免费降低使用门槛；时间戳让新鲜度可见；审计工具把「记忆治理」产品化 | **低**：产品决策 + 元数据字段 + 一个审计命令 |

## 7. 糟粕：应避免的设计

| # | 设计（来源） | 为什么差 |
| --- | --- | --- |
| 1 | **原生记忆功能静默消失、无官方迁移出口**（Cursor：[文档索引无 Memories](https://cursor.com/llms.txt)、[原路径重定向至 Rules](https://cursor.com/docs/rules)、[2.0](https://cursor.com/changelog/2-0)/[2.1](https://cursor.com/changelog/2-1) changelog 无说明） | 用户沉淀的项目知识资产被锁死/丢失，信任受损。记忆功能下线必须提供导出与迁移路径（对比：Claude Code `/import`、Devin Local 默认导入 legacy windsurf rules） |
| 2 | **所有会话/用户共享一个 journal**（[Cursor Agent SDK memory](https://cursor.com/docs/agent-sdk/reference/memory)，官方自认 caveat） | 一人消息可浮现于另一人会话：隐私泄漏 + 跨用户注入面。记忆默认应按用户/会话隔离 |
| 3 | **每任务全读所有记忆文件**（[Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank)） | 上下文成本随文档量线性增长，无选择性检索；项目越大越贵越慢。应配索引 + 按需读取（对照 Claude Code 两层结构） |
| 4 | **投票不透明 + 单条记忆不可编辑**（[Copilot Memory 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)） | 用户无法解释「为何用/不用某条记忆」，纠错只能删除重来；黑箱排序削弱可控感。至少应展示理由与状态 |
| 5 | **共享作用域静默写入、无审批**（[Copilot：cloud agent/code review 不请求批准](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)，且[可能捕获未合并 PR 的事实](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)） | 错误事实进入团队共享知识库并跨 agent 传播，影响面大于个人记忆。共享写入至少应可通知/可策略禁用 |
| 6 | **离线整理按运行计费、无变更/不活跃仓库也扣费、无按 app 预算**（[Copilot Dreaming 文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)） | 成本黑洞：alerts 不停用量、个人预算覆盖不了仓库级用量。后台记忆维护必须有粒度化计量与硬预算 |
| 7 | **冲突指令无确定性优先级**（[Claude Code 文档](https://code.claude.com/docs/en/memory)：冲突时模型可能任选其一） | 行为不可预测，团队规则与个人规则打架时结果随机。应文档化优先级或提供冲突检测（其 prompt-audit 是补救而非根治） |
| 8 | **记忆 workspace 隔离且不随 agent 换代迁移**（[Windsurf Memories](https://docs.devin.ai/windsurf/plugins/cascade/memories) workspace 绑定；[Devin Local 无 memories](https://docs.devin.ai/desktop/devin-local/customizations)） | 知识困在单个 workspace，换 agent 即归零；自动学习积累无法复用。记忆应可导出/可移植 |
| 9 | **把记忆/指令当强制配置**（各平台官方均否认：[Claude Code](https://code.claude.com/docs/en/memory)「context, not enforced configuration」、[Copilot](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)「不保证每次遵从」） | 用记忆承载安全/合规硬约束必然漏执行。硬约束应走 hooks/权限/策略层，记忆只承载偏好与事实 |

## 8. 未能核实清单（不编造、不采信第三方）

1. **Cursor Memories 的 sidecar 模型观察机制、用户审批流程、记忆生成提示词**：原官方文档页（docs.cursor.com/context/memories）已下线并重定向至 Rules；现存官方文档、博客、changelog 均无此内容。
2. **Cursor Memories 的具体下线版本/时间与官方迁移指引**：已核实的 [2.0](https://cursor.com/changelog/2-0)、[2.1](https://cursor.com/changelog/2-1) changelog 未提及；未找到官方公告（第三方社区说法按来源纪律不予采信）。
3. **Windsurf 自动 memories 的存储位置/文件格式、生成提示词、衰减与冲突策略**：官方文档未公开。
4. **Copilot「2026-03 对 Pro/Pro+ 默认开启」的 changelog 条目**：未抓取核实；当前默认状态以 [Memory 概念文档](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)的 Default settings 表为准。
5. **Anthropic 工程博客《Claude Code: Best practices for agentic coding》**：官方重定向链 anthropic.com → code.claude.com → www.claude.com → claude.com，最终抓取网络失败；Claude Code 所需事实已全部由 [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) 核实。

## 9. 来源索引（全部为官方一手来源，2026-11-13 抓取核实）

**Cursor（cursor.com）**
- [Cursor 1.0 changelog（2025-06-04，Memories beta）](https://cursor.com/changelog/1-0)
- [Cursor 2.0 changelog（2025-10-29）](https://cursor.com/changelog/2-0) · [2.1 changelog（2025-11-21）](https://cursor.com/changelog/2-1)
- [Changelog 首页（Agent SDK GA 2026-10-20 等）](https://cursor.com/changelog)
- [Rules 文档](https://cursor.com/docs/rules) · [帮助中心 Rules](https://cursor.com/help/customization/rules) · [帮助中心 @ mentions and context](https://cursor.com/help/customization/context)
- [Agent SDK Memory 参考](https://cursor.com/docs/agent-sdk/reference/memory)
- [官方文档索引 llms.txt](https://cursor.com/llms.txt) · [博客索引（含 SpaceX 收购公告）](https://cursor.com/blog)

**Windsurf / Cognition（docs.devin.ai、devin.ai；docs.windsurf.com 与 windsurf.com/blog 官方重定向至此）**
- [Memories & Rules（Windsurf Plugins / Cascade）](https://docs.devin.ai/windsurf/plugins/cascade/memories)
- [Cascade (legacy)](https://docs.devin.ai/desktop/cascade) · [Devin Local Customizations](https://docs.devin.ai/desktop/devin-local/customizations)
- [Windsurf Wave 1 博客（2024-12-11）](https://devin.ai/blog/windsurf-wave-1) · [Windsurf Wave 2 博客（2025-01-17）](https://devin.ai/blog/windsurf-wave-2)

**Cline（docs.cline.bot）**
- [Memory Bank（原 prompting/cline-memory-bank 重定向至此）](https://docs.cline.bot/best-practices/memory-bank)

**Claude Code（code.claude.com）**
- [How Claude remembers your project（memory 文档全文）](https://code.claude.com/docs/en/memory)

**GitHub Copilot（docs.github.com、github.blog、github/docs 官方仓库）**
- [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory)（全文经 [github/docs 官方仓库 raw 文件](https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/prompting-and-context/copilot-memory.md)核对）
- [About GitHub Copilot Dreaming](https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming)（全文经 [官方仓库 raw 文件](https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/prompting-and-context/copilot-dreaming.md)核对）
- [Custom instructions 概念](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)（[官方仓库 raw 文件](https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/prompting-and-context/custom-instructions.md)）
- [Adding repository custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)（[官方仓库 raw 文件](https://raw.githubusercontent.com/github/docs/main/content/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions.md)）
- [Building an agentic memory system for GitHub Copilot（2026-01-15，2026-11-12 更新）](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)（全文经同域官方 WP REST API 核实）
- [Copilot memory early access changelog（2025-12-19）](https://github.blog/changelog/2025-12-19-copilot-memory-early-access-for-pro-and-pro/)
- [GitHub intelligence changelog（2026-10-28，Memory GA + Dreaming preview）](https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/)
