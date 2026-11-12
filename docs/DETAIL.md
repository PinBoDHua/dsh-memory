# 记忆 Memory（dsh-memory）

跨会话长期记忆插件：让 Agent 记住用户偏好、项目事实与重要决策，并在新会话中自动召回。
Cross-session long-term memory for DeepSeek Harness: durable user preferences, project facts, and decisions, recalled into every new session.

## 功能 Features

- **双通道写入**：用户显式「记住/忘掉」＋ Agent 依据注入指引在对话中主动记录（自动写入后简短提示）。
- **两级作用域**：`global`（用户级，跨项目共享）与 `workspace`（按会话有效工作目录隔离，互不污染）。
- **自动召回**：会话装配系统提示时实时读取记忆，在字符预算内注入全局＋当前工作区条目；超出预算的条目提示用搜索获取。
- **Web 管理面板**：侧边栏「记忆」入口打开独立面板，浏览/搜索/新建/编辑/删除，全局与工作区切换；与 agent 工具共用同一服务层。
- **一事一条目**：每条记忆一个 Markdown 文件（frontmatter 存元数据），人类可读、可手工编辑，改动立即生效。
- **新覆旧**：信息变化时原地更新；仅手动遗忘，不自动删除。
- **隐私护栏**：密码/密钥/token 在服务层被规则检测硬拒绝；其他敏感个人信息由指引要求先征得用户同意。

## Web 管理面板 Panel

- 入口：左侧边栏「记忆」图标 → 主区域面板（与 Plugins 页同级）。
- 能力：作用域切换（全局＋当前工作区 / 仅全局 / 各已知工作区）、关键词搜索（300ms 防抖）、新建/编辑（内容、分类、标签）、删除二次确认、操作结果提示。
- 数据面：宿主 `webServer` 命名路由 `/plugins/dsh-memory/{status,entries,workspaces,save,update,forget}`，浏览器同源 fetch；进程级 token（status 下发），写操作校验 `X-RPC-Key`，全部路由仅回环可达。
- 一个操作，两个调用方：面板与 agent 工具调用同一 `lib/service.js`，语义与失败原因完全一致。
- 样式仅用 `--dsw-alias-*` 主题令牌，自动跟随亮/暗主题；文案中英双语（zh/en）。

## 工具 Tools

| 工具 | 作用 |
|---|---|
| `memory_save` | 写入一条记忆（content 必填；category=preference/fact/decision；scope=global/workspace，默认 workspace；tags 可选）。同作用域完全相同的内容自动去重。 |
| `memory_search` | 关键词检索（大小写不敏感、多词 AND）；空查询＝按更新时间列出；可按 scope/category 过滤，limit 默认 20。 |
| `memory_update` | 按 id 新覆旧（content/category/tags 可选更新）。 |
| `memory_forget` | 按 id 永久删除。 |

## 存储 Storage

数据位于 `~/.dsh/.dsh-memory/`（home 级，本机各 profile 共享）：

```
.dsh-memory/
├── global/<id>.md
└── workspaces/
    ├── index.json            # 目录哈希 → 工作区路径对照（仅供排查）
    └── <cwd-hash>/<id>.md
```

文件格式（frontmatter + 正文）：

```markdown
---
id: m-xxxxxx-xxxxxx
category: fact
scope: workspace
tags: ["构建", "pnpm"]
created: 2026-11-13T01:00:00.000Z
updated: 2026-11-13T01:00:00.000Z
source: <session-id>
---
这条项目使用 pnpm 而不是 npm。
```

写入为「临时文件＋改名」的原子写；每次操作实时重读磁盘，因此 DSH 运行中手工编辑文件也会立即生效。损坏的文件会被跳过而不是报错。

## 配置 Config

通过插件行的 `config` 调整（profile 的 `cordis.patch.yml` 中 `id: dsh-memory` 条目）；默认值由插件自身收敛，无需 schemastery 依赖。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关：关闭后不注册工具与注入。 |
| `autoInject` | `true` | 是否把召回的记忆注入系统提示（关闭后工具仍可用）。 |
| `injectionBudgetChars` | `6000` | 注入记忆的字符预算；从最新条目开始装，装不下的提示用 `memory_search`。 |

## 限制 Limitations

- 检索为关键词匹配，无语义/向量检索。
- 无自动衰减/自动清理；遗忘只能手动。
- 自动记录依赖模型遵循注入指引，不是后台独立提取。
- 记忆按 home 共享：同一台机器上的所有 profile 看到同一份记忆。
- 面板不支持跨作用域移动条目（与工具一致）；编辑不改变作用域。
- 面板「当前工作区」取会话初始目录（SessionSummary.cwd）；会话内 cd 后，agent 工具按有效目录写入，两者可能不同。
- 索引损坏导致路径未知的工作区（cwd:null）在下拉中显示为「未知工作区」但不可选；其记忆在该工作区为会话工作目录时仍对 agent 工具与召回注入可见，也可直接编辑对应目录下的文件。
- 与 DSH 既有机制互补：不接管 goals、skills、AGENTS.md，也不索引会话历史。

## English summary

dsh-memory gives the agent durable cross-session memory. Four tools (`memory_save`, `memory_search`, `memory_update`, `memory_forget`) and a Web management panel (sidebar "Memory" entry) share one service layer over one-fact-per-entry Markdown files under `~/.dsh/.dsh-memory/`, split into a global scope and per-workspace scopes keyed by the session's effective working directory. A system-prompt section re-reads the files on every assembly and injects the newest entries within a configurable character budget; the rest stay reachable via search. The panel talks to loopback-only `webServer` routes guarded by a process token. Credentials are rejected at the service boundary; other sensitive information requires user confirmation per the injected guidance. Updates supersede in place; forgetting is manual only. Hand edits to the Markdown files take effect immediately.
