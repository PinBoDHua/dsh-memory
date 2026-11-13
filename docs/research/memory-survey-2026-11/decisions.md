# dsh-memory 升级决策日志（grilling）

日期：2026-11-13 · 状态：第 1–5 轮已定案（17 项）；Q18 最终确认被跳过（按规则不视为许可、不再重问），等待用户明确下达实施指令

## 第 1 轮（已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 升级主轴 | 对标竞品补齐核心体验缺口；具体特性清单以调研结论为准，逐条确认 |
| Q2 | 自动化立场 | 引入系统化自动提取，但可控可撤销：自动记忆带来源标记，UI 可审阅、可一键撤销 |
| Q3 | 数据兼容 | 必须无损兼容＋自动迁移，旧记忆零丢失 |
| Q4 | 调研范围 | 全清单：消费级助手（ChatGPT/Claude/Gemini/Microsoft Copilot）＋编码 Agent（Cursor/Windsurf/Cline/Claude Code/GitHub Copilot）＋记忆框架（Mem0/Letta/Zep-Graphiti/LangMem，概览 Memobase/Supermemory） |
| Q5 | 改动边界 | 仅限 dsh-memory 插件仓库；确需宿主新能力的记录为后续提议，不在本次动 DSH 核心 |
| Q6 | 交付流程 | 代码＋测试 → remove→install 重载 → 回环 API live 验证 → 客户端分发 rev 验证 → git 提交并经 127.0.0.1:7897 代理推送 |

## 第 2 轮（已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q7 | 提取成本 | 零额外模型调用：靠主 agent 提示词约定＋插件侧捕获实现自动沉淀；不做 sidecar/后台提取 |
| Q8 | 检索依赖 | 纯本地轻量检索：不引入 embedding/向量库；强化分词（尤其中文）、评分、时间衰减、命中反馈 |
| Q9 | 遗忘策略 | 衰减＋归档，不自动物理删除；长期未命中降权并可归档，用户在 UI 清理 |

## 第 3 轮（已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q10 | profile 共享 | 保持 home 级共享：全局偏好跨 profile 跟随用户，工作区记忆按 cwd 隔离；不做按 profile 隔离 |
| Q11 | 短板修复包 | 仅两项：①面板/工具 cwd 口径对齐（DETAIL 局限 #7，对齐会话有效目录）②沉淀可重复运行的 live 验证脚本；导入登记新工作区、跨工作区移动、未知工作区修复入口均保持现状；并发去重维持尽力而为 |

## 第 4 轮（已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q12 | 新机制取舍 | 采纳 4 项：B1 取代链（supersedes/superseded_by，默认读最新、历史保留）、B2 可选过期日（仅显式设置、无默认 TTL，到期隐藏不删、可逆）、B3 钉选常驻（pinned 预算内必注入、免衰减）、B4 隐私＋写入纪律增强（敏感默认排除/可推导不存/JIT 验证提示/guard 模式扩充）；C1 会话级开关、C2 类别扩展缓行 |
| Q13 | 提取触发 | systemPrompt.context() 动态提示：宿主原生运行时提醒（v0.2.2-rc.1 runtime-context-reminders），快照可替换、零额外调用，插件簿记控制提示出现，设置可关 |
| Q14 | 审阅 UI | 扩展现有记忆星丛：origin 徽章（auto/manual）＋筛选＋被取代/已过期/已归档状态视图＋钉选/过期编辑＋一键撤销；不加右栏 tab、不加消息内卡片 |

## 第 5 轮（已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q15 | 版本号 | 0.9.0（特性升级，schemaVersion 1→2） |
| Q16 | 默认开关 | autoExtractHint 与 decayEnabled 均默认开启、设置页可关；取代/过期/钉选为可选字段无需开关；隐私 GUIDANCE 恒开 |
| Q17 | 工具面 | 扩展现有 4 工具：save/update 增可选参数（origin/supersedes/expires/pinned/archived），search 增可选过滤（include_superseded/include_expired/include_archived）；不新增工具；search/注入默认隐藏被取代/已过期/已归档，工具描述与 CHANGELOG 明示 |

## 事实侦察进度（全部完成）

- inventory ✅ → baseline.md（v0.8.1 现状基线）
- research-frameworks ✅ → part3-memory-frameworks.md（精华 20/糟粕 10；引用域名审计通过；Mem0 ADD-only、Letta 归档两条关键论断经官方原文复核证实）
- research-chat ✅ → part1-chat-assistants.md（53 条引用全官方域；ChatGPT/Claude/Copilot 官方正文核实；Gemini 官方域本环境不可达、lead 用真实官方 URL 重试仍失败，维持「未能核实」标注，不用代理绕行）
- research-coding ✅ → part2-coding-agents.md（191 条引用全官方域、官方重定向如实记录；Cursor Memories 文档已下线、Windsurf Cascade legacy、Copilot Memory GA；Copilot 投票/过期语义经 github/docs 官方仓库 raw 复核）
- host-scan ✅ → host-capabilities.md（turn/end＋inject/context 注入、sessionQuery、右栏 tab、设置插槽等确认）
- 汇总 → report.md（精华/糟粕对照＋候选特性包；第 4 轮已据此定案）

## 最终确认（Q18）

实施计划见 plan.md；**用户确认前不得实施**。确认后按 Q6 完整交付流程执行。

## 约束备忘

- 所有在线调研只用真实官方一手来源 URL，严禁 routify 等代理替换；每次调用重新核对。
- 回复与文档一律简体中文。
