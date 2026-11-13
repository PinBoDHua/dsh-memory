# 记忆 Memory（dsh-memory）

跨会话长期记忆插件：让 Agent 记住用户偏好、项目事实与重要决策，并在新会话中自动召回。
Cross-session long-term memory for DeepSeek Harness: durable user preferences, project facts, and decisions, recalled into every new session.

## 功能 Features

- **双通道写入**：用户显式「记住/忘掉」＋ Agent 依据注入指引在对话中主动记录（自动写入后简短提示）；**自动提取动态提示**按会话活动量周期性提醒沉淀（`origin=auto` 标记、写入后清除、零额外模型调用、可关）。
- **两级作用域**：`global`（用户级，跨项目共享）与 `workspace`（按会话有效工作目录隔离，互不污染）。
- **自动召回**：会话装配系统提示时实时读取记忆，按**钉选最先→分类优先（偏好→决策→事实）→类内衰减乘子倒序**在字符预算内注入全局＋当前工作区条目；超出预算的条目提示用搜索获取。默认隐藏被取代/已过期/已归档条目。
- **相关度检索**：关键词 AND 匹配（大小写不敏感、**CJK bigram 模糊**）之上按相关度×衰减乘子排序——内容命中×3、标签×2、分类/id×1，紧凑短语+4、空格短语+2，钉选小幅 boost；同分按更新时间倒序。空查询仍按更新时间列出。
- **取代链（supersede）**：信息变化可 save 新条目＋`supersedes=旧id`，旧条目标记被取代、默认隐藏、历史保留可查（`include_superseded`），避免并存矛盾。
- **可选过期日（expires）**：`YYYY-MM-DD`（UTC、当日含），到期默认隐藏不删除、可恢复（`include_expired`）；坏日期 fail-open。
- **钉选常驻（pinned）**：钉选条目在预算内最先注入、免衰减。
- **归档（archived）**：归档条目默认隐藏、可恢复（`include_archived`）；不自动物理删除。
- **软衰减＋命中反馈**：检索/注入命中簿记 `last_access`/`hit_count`（节流 ≤1 次/小时）；衰减乘子 `clamp(1.5−0.15×闲置周数, 0.3, 1.5)`，永不过滤、pinned 豁免、`decayEnabled` 可关回退现状。
- **Web 管理面板**：侧边栏「记忆」入口打开「记忆星丛」视觉面板，统计分布/浏览/搜索/分类过滤/状态过滤/分页/新建/编辑/删除撤销/批量选择/移动/钉选/归档/导出/导入，全局与工作区切换；与 agent 工具共用同一服务层。
- **跨作用域移动**：`memory_update` 带 `scope` 或面板编辑弹窗切换作用域，即可在 global ↔ 当前工作区之间移动条目；目标已有相同内容时拒绝（409/duplicate），不产生重复。
- **导出/导入**：面板一键导出记忆为带版本的 JSON（`dsh-memory-export` v1，作用域感知：全部/仅全局/指定工作区，默认全量；含作用域与工作区路径与 v2 可选字段）；导入先 dry-run 预览（新增/更新/重复跳过/拒绝计数），确认后落盘；可选「按 id 合并」模式原地更新已存在条目（保留 created）。逐条校验、机密硬拒、同内容去重（含批内）、保留原 id 与时间戳（skip 模式 id 被占用时自动新分配）。
- **一事一条目**：每条记忆一个 Markdown 文件（frontmatter 存元数据），人类可读、可手工编辑，改动立即生效。
- **新覆旧**：信息变化时原地更新，或走取代链；仅手动遗忘，不自动删除。
- **隐私护栏**：密码/密钥/token（含 Bearer 令牌、带口令连接串，以及 GitLab/npm/Stripe/SendGrid/PyPI/GitHub 等独立令牌格式）在服务层被规则检测硬拒绝；其他敏感个人信息由指引要求先征得用户同意，敏感话题默认不存。

## Web 管理面板 Panel

- 入口：左侧边栏「记忆」图标 → 主区域面板（与 Plugins 页同级），含「记忆 / 设置」双标签。
- 视觉：「记忆星丛 Memory Atlas」——靛紫渐变主色＋分类三色（偏好琥珀/事实湛蓝/决策翡翠）＋玫红警示；环境光晕背景、品牌徽章、分类色轨卡片＋图标勋章、悬停浮起、入场级联动画、骨架屏、星座插画空态、吸顶毛玻璃工具栏、自定义滚动条；全部下拉为自定义无障碍 listbox（portal 浮层、图标＋选中勾、完整键盘导航），彻底主题化、无系统原生弹出层；深色跟随宿主 `body[data-ds-dark-theme]`，动效尊重 `prefers-reduced-motion`（并可在设置中关闭），窄屏响应式。
- 记忆标签能力：作用域切换（全局＋当前工作区 / 仅全局 / 各已知工作区）、统计条（总数＋分类分布条＋计数筛选 chips＋全局/工作区计数）、列表注入徽章（标记已注入系统提示的活跃记忆）、关键词搜索（300ms 防抖、相关度排序、`/` 快捷聚焦、一键清空、隐藏匹配计数提示＋一键查看全部状态）、来源/标签服务端过滤（分页口径一致，标签精确匹配输入框）、分页（每页条数可设 20/50/100）、新建/编辑（内容字数统计、分类单选卡片、标签、作用域、编辑含来源选择「显式要求/主动沉淀」、Ctrl/⌘+Enter 保存）、删除二次确认＋6 秒撤销（单条/批量，原样恢复 id/时间戳）、批量选择浮栏（Esc 清除）、标签点击直达搜索、相对时间（可设绝对时间，悬停见绝对时间）、条目详情（点击正文展开：创建/更新时间、来源会话、复制 id、取代链 id 双向点击跳转）、状态筛选含「全部状态」（一览含隐藏态全部记忆）、导出 JSON、导入（dry-run 预览瓦片＋确认）、相似记忆查重（扫描当前作用域活跃记忆两两相似度≥50%，相似对可「新取代旧」保留历史或「忽略」保留两条）、图标吐司（动作按钮＋倒计时进度条）。
- 设置标签能力：见下「设置 Settings」。
- 数据面：宿主 `webServer` 命名路由 `/plugins/dsh-memory/{status,entries,workspaces,cwd,stats,similar,recall-preview,export,settings,settings/reset,backup,save,update,forget,import}`，浏览器同源 fetch；进程级 token（status 下发），写操作校验 `X-RPC-Key`，全部路由仅回环可达。
- 一个操作，两个调用方：面板与 agent 工具调用同一 `lib/service.js`，语义与失败原因完全一致。
- 样式仅用 `--dsw-alias-*` 主题令牌，自动跟随亮/暗主题；文案中英双语（zh/en）。

## 工具 Tools

| 工具 | 作用 |
|---|---|
| `memory_save` | 写入一条记忆（content 必填；category=preference/fact/decision；scope=global/workspace，默认 workspace；tags 可选；origin 必填 manual/auto；supersedes=旧id 取代；expires=YYYY-MM-DD；pinned）。同作用域完全相同的内容自动去重（仅针对未取代条目）。写入后返回相似记忆提示 `similar`（Jaccard≥0.5、最多 3 条、advisory 不阻断），便于取代/更新旧条目、避免并存矛盾。 |
| `memory_search` | 关键词检索（大小写不敏感、多词 AND、CJK bigram 模糊），非空查询按相关度×衰减排序；空查询＝按更新时间列出；可按 scope/category/origin/tag 过滤，limit 默认 20、offset 分页；include_superseded/include_expired/include_archived 找回隐藏态（默认 false）。返回 `{entries, hidden}`：hidden 统计被隐藏的匹配数（被取代/过期/归档，按首个排除原因归类），渲染附「可用 include_* 找回」提示。 |
| `memory_update` | 按 id 新覆旧（content/category/tags 可选更新）；可选 `scope` 在 global ↔ 当前工作区之间移动；supersedes 取代另一条、expires 设过期日（空串清除）、pinned 钉选、archived 归档/恢复、origin 修正来源标记。 |
| `memory_forget` | 按 id 永久删除。 |

## 存储 Storage

数据位于 `~/.dsh/.dsh-memory/`（home 级，本机各 profile 共享）：

```
.dsh-memory/
├── meta.json                 # 存储元数据：schemaVersion/createdAt（首次写入时创建）
├── settings.json             # 设置覆盖层（可选；缺失＝用默认/profile 基线）
├── backups/                  # 自动/手动备份的全量导出 JSON（按保留份数裁剪）
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
origin: auto
expires: 2026-12-31
pinned: true
---
这条项目使用 pnpm 而不是 npm。
```

v2 可选字段（`origin`/`supersedes`/`superseded_by`/`superseded_at`/`expires`/`pinned`/`archived`/`last_access`/`hit_count`）**稀疏存储**：仅在显式设置时写入文件，旧文件无需改写、读取时懒缺省（缺 origin 视为 manual、缺 pinned/archived 视为 false）；origin 可经 `memory_update` 或面板编辑弹窗显式修正（0.10.0 起 save 工具必填 origin，面板文案「显式要求/主动沉淀」）。

写入为「临时文件＋改名」的原子写；每次操作实时重读磁盘，因此 DSH 运行中手工编辑文件也会立即生效。损坏的文件会被跳过而不是报错。

并发与版本化：记忆按 home 共享，多个 DSH 进程可能同时写入。`index.json` 的读-改-写与批量导入的落盘阶段由跨进程写锁保护（原子 mkdir 互斥；持锁进程崩溃留下的陈旧锁按 mtime 自愈；获取超时抛错）。单条保存/更新本身是原子文件写，id 唯一，不需要锁。`meta.json` 记录 `schemaVersion`（当前 2）；加载时若检测到旧 v1 数据，先强制备份一次（即使自动备份关闭）再升级 meta 锚点，新字段懒缺省、不逐文件改写，旧记忆零丢失。缺失或损坏时自动重建，不影响读写。

导出文档格式（面板「导出」生成，「导入」接受）：

```json
{
  "format": "dsh-memory-export",
  "version": 1,
  "exportedAt": "2026-11-13T02:00:00.000Z",
  "entries": [
    { "id": "m-…", "scope": "workspace", "workspace": "d:\\proj\\alpha", "category": "fact", "tags": [], "created": "…", "updated": "…", "source": "…", "content": "…" }
  ]
}
```

global 条目的 `workspace` 为 `null`。导入保留原 id/时间戳/来源；id 已被不同内容占用时自动新分配；`created`/`updated` 缺失或非法时取导入时刻。

## 设置 Settings

面板「设置」标签提供四组配置，持久化为数据目录下的 `settings.json` 覆盖层：**profile 插件行 `config` 为基线，`settings.json` 覆盖其上**，服务实时读取、改完即生效（防抖自动保存），可手工编辑；「恢复默认」一键删除 `settings.json`。所有值在 `lib/settings.js` 集中校验/夹取，未知键丢弃。

| 组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 注入与召回 | `autoInject` | `true` | 是否把召回的记忆注入系统提示（关闭后工具仍可用）。 |
| 注入与召回 | `injectionBudgetChars` | `6000` | 注入字符预算（0–20000）；按钉选最先→分类优先→类内衰减乘子装填，超出提示用 `memory_search`。设置页「召回预览」展示当前注入/未注入条数、占用字符与注入清单（`GET /recall-preview`，刷新按需重算）。 |
| 注入与召回 | `autoExtractHint` | `true` | 自动提取动态提示：按会话活动量周期性提醒主 agent 沉淀记忆（零额外模型调用）。 |
| 注入与召回 | `decayEnabled` | `true` | 软衰减排序：相关度×新近度乘子；关闭回退按更新时间排序。 |
| 存储与备份 | `autoBackup` | `false` | 开启后每天自动导出全量到 `backups/`（启动 5 秒首检、每小时检查、距上次超 24h 才落盘）。 |
| 存储与备份 | `backupRetention` | `7` | 备份保留份数（1–30），超出裁剪最旧；仅删备份，不删记忆。 |
| 面板偏好 | `defaultView` | `all` | 默认视图：`all`/`global`/`workspace`（workspace＝当前工作区）。 |
| 面板偏好 | `pageSize` | `50` | 每页条数：20/50/100。 |
| 面板偏好 | `animations` | `true` | 界面动效开关。 |
| 面板偏好 | `relativeTime` | `true` | 相对时间（关闭则显示绝对时间）。 |

- **隐私护栏**：机密拦截（密码/密钥/token 硬拒写）始终启用、不可关闭，面板仅作展示。
- **总开关 `enabled`**：仍由 profile 配置管理（关闭会卸载整个插件，面板自身亦消失），故不放入面板。

## 配置 Config

profile 插件行 `config`（`cordis.patch.yml` 中 `id: dsh-memory` 条目）作为基线，可被面板 `settings.json` 覆盖；默认值由插件自身收敛，无需 schemastery 依赖。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关：关闭后不注册工具与注入（仅 profile 可设）。 |
| `autoInject` | `true` | 注入基线值；面板设置可覆盖。 |
| `injectionBudgetChars` | `6000` | 注入预算基线值；面板设置可覆盖。 |

## 限制 Limitations

- 检索为关键词匹配（含 CJK bigram 模糊）＋相关度×衰减排序，无语义/向量检索。
- 软衰减仅影响排序（永不过滤、可关）；不自动物理清理记忆，遗忘只能手动（自动备份仅裁剪备份文件，不删记忆）；过期/归档/取代均为可逆隐藏。
- 自动记录依赖模型遵循注入指引与动态提示，不是后台独立提取（零额外模型调用）。
- 记忆按 home 共享：同一台机器上的所有 profile 看到同一份记忆。
- 移动仅支持 global ↔ 当前工作区（工具按会话有效目录，面板按所选工作区）；不支持在两个不同工作区之间直接移动。
- 导入时，工作区路径未知（索引损坏）的 workspace 条目会被拒绝（no-workspace）；可手工把文件放回对应目录。
- 面板「当前工作区」已与会话有效目录对齐：初始取 SessionSummary.cwd，再经 `/cwd` 路由按 workingDirectory 服务（跟随 cd）刷新，与 agent 工具口径一致；服务不可用时回退初始目录。
- 索引损坏导致路径未知的工作区（cwd:null）在下拉中显示为「未知工作区」但不可选；其记忆在该工作区为会话工作目录时仍对 agent 工具与召回注入可见，也可直接编辑对应目录下的文件。
- 与 DSH 既有机制互补：不接管 goals、skills、AGENTS.md，也不索引会话历史。
- 并发写入下，单条保存的去重检查是尽力而为：两个进程同时写入完全相同的内容时可能各留一条（可手动删除）；文件与索引本身不会损坏或丢失。

## English summary

dsh-memory gives the agent durable cross-session memory. Four tools (`memory_save`, `memory_search`, `memory_update`, `memory_forget`) and a Web management panel (sidebar "Memory" entry) share one service layer over one-fact-per-entry Markdown files under `~/.dsh/.dsh-memory/`, split into a global scope and per-workspace scopes keyed by the session's effective working directory. A system-prompt section re-reads the files on every assembly and injects entries within a configurable character budget, ordering pinned entries first, then preferences over decisions over facts, then by a soft-decay multiplier within a category; superseded/expired/archived entries are hidden by default. Non-empty searches are AND keyword matches (with CJK bigram fuzzy matching) ranked by relevance times a decay multiplier. Schema v2 adds optional, sparsely-stored fields: `origin` (manual/auto), a supersede chain (`supersedes`/`superseded_by`/`superseded_at`), `expires` (hide-on-expiry, reversible, bad dates fail-open), `pinned`, `archived`, and access bookkeeping (`last_access`/`hit_count`, throttled to once per hour). Loading old v1 data forces a backup before bumping the meta anchor; entry files are never rewritten (lazy defaults), so migration is lossless. A feature-detected `systemPrompt.context()` provider periodically reminds the agent to consolidate memories (zero extra model calls, toggleable). The panel offers scope/status/origin filtering, pin/archive quick actions, an expires editor, and talks to loopback-only `webServer` routes guarded by a process token. Credentials (including bearer tokens and connection strings with passwords) are rejected at the service boundary; other sensitive information requires user confirmation per the injected guidance. Updates supersede in place or via the supersede chain, and can move an entry between global and the current workspace. The panel exports all memories as a versioned JSON document (preserving v2 fields) and imports them back with a dry-run preview, per-entry validation, dedupe, and preserved ids/timestamps. Forgetting is manual only; decay never filters and nothing is auto-deleted. Hand edits to the Markdown files take effect immediately. A cross-process mkdir lock protects the workspace index and bulk-import writes when several DSH profiles share the same home.
