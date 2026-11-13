# dsh-memory 现状基线（v0.8.1 · 2026-11-13 只读盘点）

来源：inventory 子代理实际读文件/只读 git 命令核实；行号为当时快照。

## 包与入口
- package.json：name=dsh-memory，version=0.8.1，type=module，main=index.js，MIT；engines dsh>=0.2.0-rc.2、node>=22.6；**零 dependencies、无 scripts**；dsh.bundle.patch=./cordis.patch.yml；dsh.client platform=web，inject ui-layout/ui-sidebar/locale/api-session-controller；files 白名单含 lib/client/tests/docs。
- cordis.patch.yml：仅 insert（裸 id 是覆盖语义，必须 insert）；不写 config。
- index.js（298 行）：inject=['tools','systemPrompt']；注册 4 工具＋systemPrompt.section；可选 ctx.inject(['webServer']) 挂路由（缺失仅告警）；自动备份定时器（启动 5s 首检＋每小时）；会话 cwd 优先 workingDirectory 服务、回退 session.header.cwd（L73-87）；刻意不 import @deepseek-ai/* 包。
- lib/ 七模块：service.js（唯一公共边界「缝1」）、store.js（存储）、routes.js（HTTP 契约「缝3」）、settings.js（设置覆盖层）、render.js（注入渲染）、lock.js（跨进程锁）、guard.js（机密护栏）。
- client/client.js：2015 行手写 classic script 无构建；__ModuleLoader__.load 内 require react/react-dom（L690-700）；纯逻辑 UMD 导出供 node 单测「缝4」；面板文案内联（NS='dsh-memory'）；locale/zh.json、en.json 仅插件元信息。

## 工具面（index.js L90-246）
- memory_save：content 必填；category=preference/fact/decision（默认 fact）；scope=global/workspace（默认 workspace）；tags 数组；同作用域内容去重（折叠空白＋忽略大小写）；机密硬拒 code=secret；isConcurrencySafe=false。
- memory_search：空格分词 AND、大小写不敏感；空查询＝按 updated 倒序；scope=global/workspace/all（默认 all）；category 过滤；limit 默认 20；isConcurrencySafe=true。
- memory_update：id 必填；content/category/tags 可选（tags 整体替换）；scope 可跨作用域移动（目标同内容拒绝 duplicate）；isConcurrencySafe=false。
- memory_forget：id 必填，永久删除；isConcurrencySafe=false。
- workspace 均取会话有效目录；save 的 source 记录 session.id。

## 存储
- 纯文件系统 Markdown＋frontmatter，一事一文件；无数据库/缓存/索引，每次操作实时重读磁盘；坏文件跳过；写入＝临时文件＋rename 原子写（store.js L203-208）。
- 位置：DSH_HOME=C:\Users\李\.dsh → C:\Users\李\.dsh\.dsh-memory\；meta.json（schemaVersion=1、createdAt，迁移锚点）、global/<id>.md、workspaces/<cwd-hash>/<id>.md、workspaces/index.json（哈希→cwd/firstSeen/lastSeen）、settings.json 与 backups/ 尚未生成（autoBackup 默认关）。
- 字段：id=m-<Date.now base36>-<6hex>（文件名安全正则防路径穿越）、category、scope、tags（≤12 个、每个≤64 字符）、created/updated ISO、source 会话 id、content 正文。
- workspace 目录名＝规范化 cwd（绝对化、去尾分隔符、Windows 小写）sha256 前 16 位 hex（store.js L31-41）。
- 并发：原子 mkdir 跨进程锁（超时 5s、陈旧 10s 自愈、重试 25ms）保护 index.json 与批量导入；单条保存原子写不加锁；并发同内容去重尽力而为。

## 召回注入与检索
- ctx.systemPrompt.section({name:'dsh-memory', order:9500, interpolate:false, text:回调})（index.js L266）；每次装配实时重读；读取失败降级纯 GUIDANCE。
- 内容＝GUIDANCE＋按全局/当前工作区分组召回行；排序分类优先 preference→decision→fact、同级新者优先（render.js L27-33）；字符预算默认 6000（夹取 0–20000），无条数上限；装不下跳过并计数、提示 memory_search；autoInject=false 只注入指引。
- 检索：AND 关键词（content/tags/category/id，大小写不敏感）＋相关度＝内容×3＋标签×2＋分类/id×1，紧凑短语（CJK 相邻）+4、空格短语+2；同分按 updated 倒序（store.js L369-406）。无向量/语义。

## 客户端 UI 与路由
- Slot：main keyed（key='dsh-memory' 整页）＋sidebar.panellist（order=20）；locale.register；注入 <style id=dsh-memory-style>；inject=['slots','locale']。
- 「记忆星丛 Memory Atlas」记忆/设置双标签：作用域切换（未知工作区置灰）、统计＋分类 chips、搜索（300ms 防抖、/ 聚焦）、分页（20/50/100）、新建/编辑弹窗（分类三色、Ctrl/⌘+Enter）、删除二次确认＋6 秒撤销（import 原样恢复 id/时间戳）、批量浮栏、标签直达搜索、相对时间、条目详情（来源会话/复制 id）、导出 JSON、导入 dry-run；设置四组（注入召回/隐私护栏展示/存储备份/面板偏好）防抖自动保存＋恢复默认；自定义无障碍 Select（createPortal）；深色跟随 body[data-ds-dark-theme]，--dsw-alias-* 令牌。
- 路由（routes.js，12 条 exact，前缀 /plugins/dsh-memory/）：GET status（下发进程 token＋version＋root＋schemaVersion＋counts）/entries/workspaces/stats/export/settings；POST settings/settings/reset/backup/save/update/forget/import。
- 鉴权：仅回环（remoteAddress＋Host 正则）；进程 token=randomBytes(24).hex 经 status 下发；写操作校验 X-RPC-Key（timingSafeEqual）；GET 读无需 token；body≤1MB；错误映射 not-found→404、secret/invalid/no-workspace→400、duplicate→409。

## Config 与 settings
- 无 schemastery；CONFIG_DEFAULTS＋手写 resolveConfig（index.js L35-49）：enabled=true（仅 profile 可设）、autoInject=true、injectionBudgetChars=6000。
- settings.json 覆盖层（settings.js L14-29）：autoInject、injectionBudgetChars（0–20000）、autoBackup=false、backupRetention=7（1–30）、defaultView='all'、pageSize=50、animations=true、relativeTime=true；未知键丢弃；有效值＝默认←profile 基线（仅注入两键）←overlay；容忍 BOM；恢复默认＝删 settings.json。

## 测试与 git
- tests/ 六文件 94 test（store 29/service 28/routes 14/client 12/lock 6/settings 5）＋双进程并发 fixtures；运行 node --test tests/*.test.mjs；无 test script；**live 验证为手工，无脚本文件**。
- git：main，工作区干净；fbabc6a v0.8.1 → 1fb558a v0.1.0（单日 10 版，CHANGELOG 全部 2026-11-13）；remote https://github.com/PinBoDHua/dsh-memory.git。

## 已知局限（docs/DETAIL.md L115-126，10 条）
1 无语义/向量检索；2 无自动衰减/清理（遗忘仅手动）；3 自动记录依赖模型遵循指引（非后台提取）；4 记忆按 home 共享（所有 profile 同份）；5 移动仅 global↔当前工作区；6 导入拒绝路径未知的 workspace 条目（no-workspace）；7 面板「当前工作区」取会话初始目录，cd 后与工具有效目录可能不同；8 索引损坏的工作区显示「未知工作区」不可选（可手工修文件）；9 不接管 goals/skills/AGENTS.md、不索引会话历史；10 并发同内容去重尽力而为。

## 其他
- 仓库无调研/设计笔记目录（本次新建 docs/research/memory-survey-2026-11/）；全库无 TODO/FIXME/路线图；唯一前瞻锚点 store.js L25-26 SCHEMA_VERSION=1。
