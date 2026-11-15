# 记忆 Memory（dsh-memory）

跨会话长期记忆插件：让 Agent 记住用户偏好、项目事实与重要决策，并在新会话中自动召回。
Cross-session long-term memory for DeepSeek Harness: durable user preferences, project facts, and decisions, recalled into every new session.

## 功能 Features

- **双通道写入**：用户显式「记住/忘掉」＋ Agent 依据注入指引在对话中主动记录（自动写入后简短提示）；**学习信号驱动**（v3）：插件从会话的**直接用户消息**检测信号（显式记忆指令 / 直接纠正 / 工具失败后的纠正 / 新环境事实 / 重复交代），纯规则、零 LLM、零后台任务；`memory_save` 以 `origin=auto|manual` 写入时必须携带本会话有效且未消费的 `signal_id`，工具边界强制校验会话额度（每会话自动候选默认 ≤5，活跃＋待确认共享）与 R0–R3 风险分级：R3（机密/短期任务/内嵌指令/敏感推断）拒绝且不落候选正文，R2（程序性知识/宽泛约束/来源不符/弱信号/疑似新旧冲突）只进**待确认候选**、批准前不注入，R1 直接生效（可撤销）。直接用户纠正写成的偏好自动带 `constraint` 标记：注入优先级仅次于 pinned 且免软衰减。
- **两级作用域**：`global`（用户级，跨项目共享）与 `workspace`（按会话有效工作目录隔离，互不污染）。
- **自动召回（分层，v0.29.0）**：会话装配系统提示时实时读取记忆，按**钉选最先→非钉选 constraint→分类优先（偏好→决策→事实）→类内衰减乘子倒序（同分更新时间、最后 id 稳定排序）**装填字符预算：**常驻层**（pinned + constraint）注入完整正文、装不下整条省略且永不截断；**索引层**（其余活跃条目）注入**确定性单行摘要**——正文超 80 字符按字符截断加 `…`，完整正文用 `memory_search` 按 id 读取。未注入条目按「预算不足 N 条 / 单条过长 M 条」分类提示。默认预算 8000 字符。同一次装配的 `selectInjection` 结果复用给命中簿记与渲染，排序/预算只算一遍。
- **相关度检索**：关键词 AND 匹配（大小写不敏感、**CJK bigram 模糊**）之上按相关度×衰减乘子排序——内容命中×3、标签×2、分类/id×1，紧凑短语+4、空格短语+2，钉选小幅 boost；同分按更新时间倒序。空查询仍按更新时间列出。
- **取代链（supersede）**：信息变化可 save 新条目＋`supersedes=旧id`，旧条目标记被取代、默认隐藏、历史保留可查（`include_superseded`），避免并存矛盾。链完整性受校验：不能取代自身、不能覆盖已有后继、不能形成环（违反返回 `invalid`）；改取代目标会清理旧目标的反向引用（含 save 去重命中后改向/撤销取代的路径，不会留下「无人指向却永久隐藏」的搁浅条目）；删除时自动清理两个方向的悬垂引用（**全作用域扫描**：global＋所有工作区，覆盖「A 建立→移到 global→在 B 删除」）——被删条目的旧记忆恢复可见、后继的 `supersedes` 指针清除。导入数据同样受不变量约束：自指、批内环、从条目作用域不可达的目标、磁盘上未反向声明指向的无关目标都会被丢弃并计入 `repaired`，不会产生永久隐藏且工具无法修复的条目。
- **可选过期日（expires）**：`YYYY-MM-DD`（UTC、当日含），到期默认隐藏不删除、可恢复（`include_expired`）；坏日期 fail-open。面板日期输入以今天（UTC）为 `min`，新建或改动为过去日期会被拒绝（否则条目保存后立即隐藏，用户会误以为丢数据）；编辑既有已过期条目的原日期仍可继续编辑。
- **钉选常驻（pinned）**：钉选条目在预算内最先注入、免衰减。
- **归档（archived）**：归档条目默认隐藏、可恢复（`include_archived`）；不自动物理删除。
- **软衰减＋命中反馈**：检索/注入命中簿记 `last_access`/`hit_count`（节流 ≤1 次/小时），写入独立 `access.json` 账本、不改写条目 Markdown；衰减乘子 `clamp(1.5−0.15×闲置周数, 0.3, 1.5)`，永不过滤、pinned 与 constraint 豁免、`decayEnabled` 可关回退现状。
- **确定性存量治理（v0.29.0）**：`GET /duplicates` 只读列出「同作用域 + 规范化正文完全一致」的精确重复组；只有一条**关键元数据完全一致**（分类/标签集合/来源/钉选/过期日）才标记 `mergeable`，元数据不同组只报告（`metadataMismatch`）。`POST /duplicates/merge` 支持 dryRun 预览；确认后保留 `created` 最早的一条、其余**归档**（可逆），并写 `duplicates_merged` 审计（keeperId/archivedIds），不物理删除、不动正文。相似/冲突/取代关系不自动合并（查重面板与 supersede 链各自负责）。`POST /archive` 批量归档/恢复（复用 `archived`，可逆、审计），访问暴露与长期存活**不**触发任何自动归档。
- **Web 管理面板**：侧边栏「记忆」入口打开「记忆」面板，统计概览/浏览/搜索/分类过滤/状态过滤/分页/新建/编辑/删除撤销/批量选择/移动/钉选/归档/导出/导入，全局与工作区切换；标题旁显示当前插件版本（`/status.version`）。与 agent 工具共用同一服务层。删除撤销吐司具有优先级（6 秒内不会被其它提示挤掉，普通提示排队展示；连续删除时先前的撤销吐司也排队保留，两条都能撤销）且出现时自动聚焦撤销按钮（键盘可达），悬停/聚焦暂停倒计时时进度条同步冻结；批量删除走单个请求（服务端一次扫描/一次取代指针清理，撤销仍可一次恢复多条），逐项结算，部分失败时成功项仍可撤销并汇报失败原因（文件被占用报「稍后重试」、不存在报「未找到」）；请求 15 秒超时（导出/备份/查重 120 秒、导入 180 秒），网络/超时失败显示可重试错误而不是永久转圈。新建立即写入默认只发送用户真正设置的字段（分类/标签/钉选/来源的默认值不再作为「显式字段」参与同内容去重，避免新建重复内容时静默改写既有条目元数据）；翻页只请求列表、一次夹取到有效末页；busy 期间被禁用的控件在结束后把焦点归还给触发按钮（键盘用户不丢位置）；备份/导出/查重进行中使用中性 info 吐司（不再用成功图标误导）。
- **跨作用域移动**：`memory_update` 带 `scope` 或面板编辑弹窗切换作用域，即可在 global ↔ 当前工作区之间移动条目；目标已有相同内容时拒绝（409/duplicate），不产生重复。移动先写新文件再删旧文件，旧文件删除失败（Windows 被占用）时回滚新文件并返回 `code=io`（零变更），不会留下同 id 双作用域副本。
- **导入**：面板一键导出记忆为带版本的 JSON（`dsh-memory-export` v1，**按当前视图导出**：全局＋当前工作区 / 仅全局 / 指定工作区；全量备份走「立即备份」；导出与导入/备份共用写锁——导入提交窗口内不会导出半套状态，忙时返回可重试 `busy`；含作用域、工作区路径、权威 `workspaceKey` 与 v2 可选字段，按工作区目录读取、不受索引陈旧影响；导出文件名使用本地日期）。导入先 dry-run 预览（>1000 条时客户端分片预演并聚合计数；服务端单请求硬上限 1000 条，超限 400 invalid），确认后按「保留取代链」的分片顺序提交（每片 ≤300 条且同一条 id ↔ supersedes ↔ superseded_by 连通链必在同一片；每片仍是原子批次；弹窗显示「正在导入 d/t」与预览将修复的 `repaired` 指针数，中途失败保留弹窗并提示已写入数量，重试复用同一 `importId`——已成功片由服务端幂等回执直接返回，不会二次写盘或回滚用户新编辑；导入进行中提供唯一可点的「停止导入」，当前片结算后不再提交后续片，已落盘片保留并提示已写入数量）；可选「按 id 合并」模式原地更新已存在条目（保留 created；改成与另一条相同内容时按去重跳过）。备份恢复按 `workspaceKey` 落回原目录——索引损坏/缺失或陈旧都不会丢条目或搬错工作区（旧导出无 key 时按 cwd 兼容）。逐条校验、机密硬拒、同内容去重（含批内）、保留原 id 与时间戳；**id 跨作用域全局唯一且大小写不敏感**（Windows/NTFS 上 m-X 与 m-x 是同一文件）：任一作用域已占用（忽略大小写）则自动新分配，merge 模式用磁盘实际大小写原地更新（merge 也不跨作用域合并）。落盘阶段「全成或零变更」：先全部暂存临时文件再统一提交，失败逆序回滚并返回 `code=io`（文案脱敏），另一进程持锁时返回可重试的 `code=busy`；**取代关系物化与提交在同一临界区（`.lock-import → .lock-write`）内完成**——等待锁窗口内其它进程的编辑/删除不会被规划期陈旧副本覆盖。`pinned/archived` 只接受布尔 `true`（手改备份里的字符串 `"false"` 不再被当 true 静默归档）；导入的取代指针会物化补全（`supersedes` 目标补 `superseded_by`，磁盘目标随同一原子批次写；`superseded_by` 目标补 `supersedes`），不可达/自指/环/冲突后继丢弃并计入 `repaired`。路由层只透传已知业务错误码，未知文件系统异常统一 `500 code=internal`（不回传本机路径/临时文件名）。
- **一事一条目**：每条记忆一个 Markdown 文件（frontmatter 存元数据），人类可读、可手工编辑，改动立即生效。
- **取代链**：`memory_save`/`memory_update` 可 supersedes 另一条（目标未被其他条目取代且不成环），旧条目保留但默认隐藏；`memory_update` 传 `supersedes:''` 可撤销取代（旧条目恢复可见），传 `superseded_by:''` 可清除本条自己的悬垂误隐藏标记。面板查重（相似对）对超大簇做候选采样与 top-K 限流（limit ≤200），不会冻结宿主或返回空结果。
- **新覆旧**：信息变化时原地更新，或走取代链；仅手动遗忘，不自动删除。同内容重复保存命中归档/过期条目时会将其复活为活跃（`memory_save` 输出 `revived: true`）；去重命中时显式提供的 `supersedes`/`pinned`/`expires`/`category`/`tags`/`origin` 会应用到既有条目（输出 `applied: true`，渲染「已应用显式字段更新」），不会静默丢弃；去重命中也会刷新工作区索引的 `lastSeen`（与 update 同口径，最近使用排序不失真）；`supersedes: ''` 显式撤销取代会解除旧目标的反向隐藏，显式空 `tags` 数组会清空标签（与 `memory_update` 同口径）。删除只计入真正落盘成功（unlink）的条目：文件被 Windows 编辑器/AV/同步盘占用时单条返回 `code=busy`（503 可重试）、批量返回 `failed` 列表，绝不谎报「已忘记」。
- **隐私护栏**：密码/密钥/token（含 Bearer 令牌、带口令连接串，以及 GitLab/npm/Stripe/SendGrid/PyPI/GitHub 等独立令牌格式）在服务层被规则检测硬拒绝——**正文与标签统一检查**（标签同样落盘并可被检索，不能成为旁路）；其他敏感个人信息由指引要求先征得用户同意，敏感话题默认不存。

## Web 管理面板 Panel

- 入口：左侧边栏「记忆」图标 → 主区域面板（与 Plugins 页同级），含「记忆 / 设置」双标签。
- 视觉：索引式（ledger）扁平语言、跟随宿主明暗主题——内容最宽 1080px 居中，页头为强调色品牌标记＋标题＋等宽小号版本徽标；记忆列表按作用域分成细线面板（表头＝作用域图标＋计数 pill），行内 2px 低饱和分类色左轨＋分类色软底 pill，来源/注入/状态/作用域/时间用中圆点串联的轻量元信息，悬停整行淡底、操作按钮常驻低透明度并在悬停/聚焦时提亮；顶部统计概览面板（总数、9px 三色分类分布条、带边框与等宽计数的分类/状态筛选 chips、作用域计数、筛选时一键清除）；工具栏为独立细线面板（搜索优先、32px 控件、吸顶实色）。设置页为分组面板（强调色图标底座＋表头细线＋行内说明），弹窗头部有图标底座、字段 inset 底、命令栏吸底；无渐变、无氛围光、无毛玻璃、无卡片投影、无入场级联动画。全部下拉为自定义无障碍 listbox（portal 浮层、前缀图标＋选中勾、完整键盘导航），主题化、无系统原生弹出层；深色跟随宿主 `body[data-ds-dark-theme]`，功能性动效（加载骨架、吐司倒计时）尊重 `prefers-reduced-motion`（并可在设置中关闭），窄屏响应式。
- 记忆标签能力：作用域切换（全局＋当前工作区 / 仅全局 / 各已知工作区）、统计条（总数＋分类分布条＋计数筛选 chips＋全局/工作区计数）、列表注入徽章（标记已注入系统提示的活跃记忆；随初始化、设置保存、写操作与工作目录变化刷新，筛选/翻页不重复请求，失败保留旧值）、关键词搜索（300ms 防抖、相关度排序、`/` 快捷聚焦、一键清空、隐藏匹配计数提示＋一键查看全部状态）、来源/标签/状态服务端过滤（分页口径一致，标签精确匹配输入框，状态优先级统一：被取代＞已过期＞已归档＞活跃）、分页（每页条数可设 20/50/100）、新建/编辑（内容字数统计、分类单选卡片、标签、作用域、编辑含来源选择「显式要求/主动沉淀」、Ctrl/⌘+Enter 保存）、删除二次确认＋6 秒撤销（单条/批量，原样恢复 id/时间戳）、批量选择浮栏（Esc 清除）、标签点击精确过滤、相对时间（可设绝对时间，悬停见绝对时间）、条目详情（点击正文展开：创建/更新时间、来源会话、复制 id、取代链 id 双向点击跳转）、状态筛选含「全部状态」（一览含隐藏态全部记忆）、导出 JSON、导入（dry-run 预览瓦片＋确认）、相似记忆查重（扫描当前作用域活跃记忆两两相似度≥50%，相似对可「新取代旧」保留历史或「忽略」保留两条）、图标吐司（动作按钮＋倒计时进度条）。
- 面板「记忆 / 设置」双标签符合 WAI-ARIA Tabs（tablist/tab/tabpanel 关联、roving tabIndex、←/→/Home/End 键盘切换；两个 tabpanel 常驻 DOM，非激活 `hidden`，`aria-controls` 目标始终存在；隐藏的设置页不加载召回预览；按标签分别记忆滚动位置并在 layout 阶段恢复，翻页/筛选等导航行为回到列表顶部；召回徽章只随数据写操作（dataVersion）与设置/工作目录变化刷新，导出/查重/导入预演不触发全量扫描）。列表细节：卡片标签点击走精确 `tag=` 过滤；「已恢复为活跃」的保存有专属提示；写请求期间卡片操作按钮禁用（列表 `aria-busy`）；空态区分筛选无结果 / 工作区为空 / 整库为空；区块计数只在单页完整结果时显示；批量选择浮栏在列表之前（键盘可达，`role=region`）；搜索/标签过滤各有独立清空按钮；卡片复选框 aria-label 含条目内容前缀；取消选择后焦点回面板容器。弹窗 busy 结束且焦点掉到 body 时自动聚焦回弹窗（保存失败/审计操作后键盘上下文不丢）。吐司：按 id 重挂载（倒计时重启）、悬停/聚焦暂停且进度条同步冻结、暂停期间不被普通提示替换、连续删除的两个撤销吐司排队而不互相覆盖、关闭后焦点回退面板容器；删除/归档撤销按钮仅在焦点已丢失或从卡片**动作按钮**触发时自动聚焦（复选框/标签/正文/输入框/弹窗场景不抢焦点，避免打断输入与回车误触）；归档撤销即使列表正在刷新（busy）也生效。分类 chip 在按分类筛选时隐藏其它分类的数字（byCategory 是过滤后分布，显示 0 会误导），只保留「全部」与当前分类。空态/错误态按钮（清除筛选、重试）点击后焦点回面板容器。错误文案与导入拒绝列表使用本地化连接符（`errJoin`/`labelSep`）与错误码映射，未知错误才回退服务端 reason。分片导入的「停止导入」只在真实写盘阶段出现，当前片结算后不再提交后续片；停止/中断提示与召回刷新采用真实写入数（imported+updated，重复/拒绝不计）。编辑器分类 radiogroup 支持方向键/Home/End 与 roving tabIndex；导入先 strip BOM 再解析，读文件/语法/格式错误分别归因，读取窗口置 busy。设置页保存一致性：保存/重置/备份共用一套状态机（dirty/saving/已保存/错误）——服务端夹取值会回收到界面（草稿与 effective 对齐）、防抖窗内的改动不会被并发重载覆盖、重置不会被在途保存回滚、保存失败保留草稿并提供「重试保存」（不谎报已保存）、加载失败显示重试；编辑器标签按 12 个/64 字符去重收敛并给出计数提示；滑杆拖动只更新本地值、松手才提交；编辑/删除请求期间弹窗显示进行中。
- 0.26.0 面板修正与补强：作用域路径比较平台感知（Windows 忽略大小写：「● 当前工作区」可靠显示、`defaultView='workspace'` 的下拉映射回规范 value 不再空白；POSIX 保持大小写敏感不误并）；设置页按 `/` 会先切回记忆页再聚焦搜索（旧实现闭包陈旧导致按键被吞）；翻页只刷新列表、不重扫与页码无关的 `/stats`，页码超界一次跳末页；busy 结束把焦点归还给触发按钮；新建只发送用户显式设置字段；过去过期日被拒绝并提示；查重使用 120s 独立超时并有进行中提示；备份/导出/查重进行中使用中性 info 吐司；导入预览显示 `repaired` 瓦片；导出文件名用本地日期。
- 0.27.0 列表密度：工具栏分段控件与设置页「列表密度」下拉同步写入 `viewMode`（`comfortable` 默认为索引行；`compact` 为单行高密度表格，隐藏来源/注入/作用域/标签行、展开后恢复，分组与统计同步收紧），持久化到 settings.json；服务端枚举校验、非法值丢弃，旧配置回落舒适视图。
- 0.27.1 可读性：工具栏操作均带可见文字（搜索/作用域/来源/标签、`视图`＋`舒适/紧凑`、导出/导入/查重/刷新），行内钉选/归档/编辑/删除在舒适视图显示「图标＋文字」（紧凑视图保留图标并用 `aria-label` 提供可访问名称）；不再有需要猜含义的纯图标操作。
- 0.28.0 学习分区：记忆页顶部新增「学习」分组，展示**待确认候选**（逐条「批准/拒绝」，批准后落盘为活跃条目并保留来源，拒绝只留审计）、**最近自动写入**（「归档」= 可逆撤销，恢复后条目文件逐字节相同）与审计尾部；无待确认/自动写入时整块隐藏。数据来自只读端点 `GET /learning`；批准/拒绝走 `POST /learning/approve|reject`（回环 + token；`pendingId` 缺失 400、未知 404、已处理 409/invalid）。
- 0.29.0 分层与存量治理：设置页召回预览显示**常驻（画像，只读：pinned/constraint 分组）与索引层**、以及「未注入原因：预算不足/单条过长」；工具栏新增「合并重复」弹窗（重复组、可合并/仅报告计数、keeper、合并按钮，Esc 关闭），批量选择浮栏新增「归档所选/恢复所选」（带撤销）；均走回环+token 端点，合并/归档写审计。
- 数据面：宿主 `webServer` 命名路由 `/plugins/dsh-memory/{status,entries,workspaces,cwd,stats,similar,recall-preview,export,settings,settings/reset,backup,save,update,forget,import,learning,learning/approve,learning/reject,duplicates,duplicates/merge,archive}`，浏览器同源 fetch；进程级 token（status 下发），写操作校验 `X-RPC-Key`，全部路由仅回环可达。
- 一个操作，两个调用方：面板与 agent 工具调用同一 `lib/service.js`，语义与失败原因完全一致。工具输出渲染（`renderSaveResult`/`renderSearchResult`/`renderUpdateResult`/`renderForgetResult`）与检索条目映射（`searchResultEntry`）为模块级纯函数，独立单测覆盖（含 lossless JSON 往返）。
- 样式仅用 `--dsw-alias-*` 主题令牌，自动跟随亮/暗主题；文案中英双语（zh/en）。

## 工具 Tools

| 工具 | 作用 |
|---|---|
| `memory_save` | 写入一条记忆（content 必填；category=preference/fact/decision；scope=global/workspace，默认 workspace；tags 可选；origin 必填 manual/auto；**signal_id 必填**：必须是本会话学习提醒中给出的有效信号，否则 `no-signal`；已消费返回 `signal-consumed`；超出会话额度返回 `autolimit`；R3 候选返回 `rejected-risk`；R2 候选返回 `status:"pending"` 与 pendingId，批准前不生效）。直接用户纠正形成的 preference 自动带 `constraint` 标签。同作用域完全相同的内容自动去重（仅针对未取代条目；若命中的是归档/过期条目则复活为活跃并返回 `revived: true`）。写入后返回相似记忆提示 `similar`（Jaccard≥0.5、最多 3 条、advisory 不阻断），便于取代/更新旧条目、避免并存矛盾。信号驱动的自动写入不接受 `pinned`/`expires`/`supersedes`（须走 `memory_update` 显式修正流）。 |
| `memory_search` | 关键词检索（大小写不敏感、多词 AND、CJK bigram 模糊），非空查询按相关度×衰减排序；空查询＝按更新时间列出；可按 scope/category/origin/tag 过滤，limit 默认 20、offset 分页；include_superseded/include_expired/include_archived 找回隐藏态（默认 false）。返回 `{entries, hidden}`：hidden 统计被隐藏的匹配数（被取代/过期/归档，按首个排除原因归类），渲染附「可用 include_* 找回」提示。 |
| `memory_update` | 按 id 新覆旧（content/category/tags 可选更新）；可选 `scope` 在 global ↔ 当前工作区之间移动（可同时 `supersedes` 建立取代链）；supersedes 取代另一条（目标必须未被他条取代且不成环）、expires 设过期日（空串清除）、pinned 钉选、archived 归档/恢复、origin 修正来源标记。 |
| `memory_forget` | 按 id 永久删除。 |

## 存储 Storage

数据位于 `~/.dsh/.dsh-memory/`（home 级，本机各 profile 共享）：

```
.dsh-memory/
├── meta.json                 # 存储元数据：schemaVersion/createdAt（首次写入时创建；v3 起为 3）
├── access.json               # 命中账本：id → { at, count }（检索/注入命中，节流 ≤1 次/小时；可选）
├── settings.json             # 设置覆盖层（可选；缺失＝用默认/profile 基线）
├── learning/                 # v3 学习存储（与条目正文分离；pending/audit 纳入快照与备份）
│   ├── pending.json          # R2「需确认」候选：状态/风险原因/来源指针；批准前不注入
│   ├── audit.jsonl           # 只追加审计事件（类型/id/计数，不复制候选正文）
│   └── state.json            # operational：会话额度、信号提醒/消费状态（TTL 7 天惰性回收；不入快照）
├── backups/                  # 自动/手动备份的全量记忆导出 JSON（另附 learning 状态；只轮转插件自己的 dsh-memory-<时间戳>[-N].json；备份与导入共用写锁、同毫秒文件名去重；不含设置/账本元数据）
├── global/<id>.md
├── .cache/entries-v1.json    # 大库（≥1024 条）派生解析索引：条目+文件签名，5s 去抖原子写；可随时删除/重建，含正文副本；库缩到阈值以下或清空时自动删除；被数据根快照忽略
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

v3 学习存储（`learning/`）：`pending.json`（R2 候选：id/来源/风险原因/状态，批准前不注入、不生效）、`audit.jsonl`（自动保存、pending 审批、归档/恢复、合并、迁移等事件；**只记事件与 id，不复制候选正文**）、`state.json`（会话额度、信号提醒/消费状态；operational 数据，TTL 7 天惰性回收，不入数据快照）。条目本身零新字段：`constraint` 是复用 `tags` 的保留标记（注入置顶、免软衰减），直接用户纠正的 preference 由闸门自动补标。

写入为「临时文件＋改名」的原子写（失败时清理临时文件，不在数据目录留垃圾；Windows 上杀软/索引器/同步盘会短暂占用 rename 目标，瞬时错误 EPERM/EACCES/EBUSY 自动重试 3×100ms；仍失败统一返回脱敏的 `code=io` 固定文案，原始 SystemError 含本机路径不进模型/面板）；每次操作实时重读磁盘，因此 DSH 运行中手工编辑文件也会立即生效。**文件名是 id 权威、所在目录是 scope 权威**（frontmatter 里的 id/scope 仅兼容无上下文解析，写回时自动修正）——复制/改名/手改不会让一条记忆「变成」另一条。UTF-8 BOM 与 CRLF 手改文件可正常解析；损坏文件会被跳过而不是报错，但仍可按 id 删除，不留不可管理的孤儿文件（删除损坏文件时同步清理其它条目指向它的取代指针，避免前驱永久隐藏）。条目解析结果带进程内缓存（签名＝路径＋mtime/ctime/size/ino/birthtimeMs，规避 Windows 文件时间 tick 碰撞）：热路径只 `statSync`、不重复读文件与解析；手工编辑、其它进程原子写、删除都会改变签名并自动失效；LRU 上限 32768。大库（目录内 ≥1024 个条目文件）进一步启用目录级列表缓存：缓存解析结果数组，本进程写入/删除走同步补丁，外部手改/增删由递归 `fs.watch` 只重读变化的那一个文件；watcher 不可用时退化为旧路径（不缓存）。因此大库热路径不再逐文件 `statSync`（30k 条目 warm listAll ~50ms），大库中手工编辑在 watcher 事件后（通常毫秒级）可见；小库仍逐文件校验，保持「改完立即可见」的严格语义。大库的目录缓存另持久化为 `<root>/.cache/entries-v1.json`（派生数据，可随时删除；5 秒去抖原子写）：进程重启后只逐文件 `statSync` 校验 mtime/ctime/size/ino/birthtime，未变化条目直接复用解析结果，30k 库冷启动从约 19–23s 降到约 1.7s；签名不一致/新增文件才重新读解析，索引缺失/损坏/版本不符自动回退全量解析；`DSH_MEMORY_INDEX=0` 可禁用。冷启动若发现目录条目已清空/降到阈值以下，会删除过期索引文件——避免「已永久删除」的正文以明文副本残留在 `.cache`；JSON 派生文件（`.cache` 索引、`meta.json`、`access.json`、工作区 `index.json`、导入回执）读取均容忍 UTF-8 BOM（记事本手改后不会被当成空文件覆写）。`.cache/` 被数据根快照忽略，不属于用户数据。命中簿记（`last_access`/`hit_count`）写入独立 `access.json` 账本（原子写＋跨进程锁、读取带签名缓存），**不再改写条目 Markdown**——没有单文件读-改-写窗口，也不会覆盖并发写入的正文；账本损坏按空处理并在下次命中时自愈，删除条目时同步清理其账本记录，并在启动与导入后惰性清理「已无对应文件」的幽灵记录（避免同 id 重新导入继承旧命中、账本无界增长）。

并发与版本化：记忆按 home 共享，多个 DSH 进程可能同时写入。`index.json` 的读-改-写、`access.json` 命中账本与批量导入的落盘阶段由跨进程写锁保护（原子 mkdir 互斥；锁目录记录 owner nonce，释放只删自己的锁——临界区超时被抢占后不会误删新持有者；批量导入每 128 条刷新锁 mtime 心跳，长临界区不会被并发进程判为陈旧；持锁进程崩溃留下的陈旧锁按 mtime 自愈——自愈前先把锁目录原子 `rename` 到带 owner nonce 的认领目录（只有一个进程能成功），复核仍陈旧才删除，避免两个等待者各自删掉对方刚建立的新锁（双持有）；认领到新锁则放回；锁超时错误带 `code=busy`（HTTP 503，设置页显示可重试忙碌提示），文案固定为 `lock timeout`、不拼接锁路径（工具面经宿主原样渲染给模型，不得泄漏数据根绝对路径）；陈旧锁认领 `rename` 失败（Windows 目录被占用可长期 EBUSY）时回到统一等待路径（deadline 检查＋退避 sleep），不会 100% CPU 自旋冻结宿主、`timeoutMs` 始终生效。用绝对时间差判断，未来 mtime 的锁同样会自愈；获取超时抛错；锁是同步临界区，async 回调会被显式拒绝以免提前放锁）。面板一次刷新会同时请求 entries 与 stats：两者共用单遍 `collectEntries`（一次列目录＋一次遍历产出可见集/隐藏计数/状态分布），大库下不再各自两遍全量遍历；两者使用同一组过滤参数（status/include_*/category/origin/tag），过滤视图下统计头与列表一致；隐藏计数按 `entryStatus` 优先级归类（superseded→expired→archived），与状态 chips 同口径。相似查重使用内容特征倒排候选，避免 O(N²)。单条保存/更新/移动/删除与批量导入一样持根级写锁（`.lock-write`，导入先持 `.lock-import` 再进本锁，锁序一致无死锁；单条临界区毫秒级），避免跨进程双后继取代/并发更新丢字段/删除后被陈旧读复活；导入幂等回执持久化（`.cache/import-receipts.json`）在 `.lock-receipts` 内合并写、读时锁外重读兜底，跨进程/跨实例重放不会互相清掉回执。`meta.json` 记录 `schemaVersion`（当前 3）；加载时若检测到旧 v1/v2 数据，先强制备份一次（即使自动备份关闭）再升级 meta 锚点：v2→v3 同时创建 `learning/` 目录与初始状态文件，**条目正文与 frontmatter 零改写**，旧记忆零丢失；迁移写失败会保持 `migrationPending` 并在 status 暴露 `migrationError`（最近 10 分钟已有备份则复用，避免反复启动新增备份挤掉历史恢复点）。缺失或损坏时自动重建，不影响读写；但**存在却不可解析**的 meta.json 不再回落成「健康版本」，status 上报 `schemaVersion:null` + `metaError`。`/status` 的 counts 是目录文件计数（不解析内容，大库也是毫秒级）；设置页的存储占用统计有 5 秒缓存，避免每次设置保存响应对大库全树 stat。HTTP 写路由只接受 JSON 对象 body，非对象（null/数组/标量）统一 400 `invalid-json`。

导出文档格式（面板「导出」生成，「导入」接受）：

```json
{
  "format": "dsh-memory-export",
  "version": 1,
  "exportedAt": "2026-11-13T02:00:00.000Z",
  "skipped": 0,
  "entries": [
    { "id": "m-…", "scope": "workspace", "workspace": "d:\\proj\\alpha", "category": "fact", "tags": [], "created": "…", "updated": "…", "source": "…", "content": "…" }
  ]
}
```

global 条目的 `workspace` 为 `null`。`skipped` 是导出时发现的损坏 `.md` 文件数（目录文件数 − 可解析条目数），导入端忽略该字段；面板导出提示会在 `skipped > 0` 时追加损坏文件警示。导入保留原 id/时间戳/来源；id 已被不同内容占用时自动新分配；`created`/`updated` 缺失或非法时取导入时刻。

## 设置 Settings

面板「设置」标签提供四组配置，持久化为数据目录下的 `settings.json` 覆盖层：**profile 插件行 `config` 为基线，`settings.json` 覆盖其上**，服务实时读取、改完即生效（防抖自动保存），可手工编辑；「恢复默认」一键删除 `settings.json`。所有值在 `lib/settings.js` 集中校验/夹取，未知键丢弃；覆盖层读-改-写与重置持 `.lock-settings` 跨进程锁，多窗口/多进程同时改不同键不会互相覆盖丢失。

| 组 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 注入与召回 | `autoInject` | `true` | 是否把召回的记忆注入系统提示（关闭后工具仍可用）。 |
| 注入与召回 | `injectionBudgetChars` | `8000` | 注入字符预算（0–20000）；常驻层（pinned/constraint）完整装填，索引层单行摘要装填，超出提示用 `memory_search`。设置页「召回预览」展示常驻/索引分层、注入/未注入条数、未注入原因（预算不足/单条过长）、占用字符与注入清单（`GET /recall-preview`，刷新按需重算）。 |
| 注入与召回 | `autoExtractHint` | `true` | **自动学习总开关**：关闭后不检测学习信号、不注入学习提醒、拒绝信号驱动的自动候选（面板手动添加不受影响）。 |
| 注入与召回 | `decayEnabled` | `true` | 软衰减排序：相关度×新近度乘子；关闭回退按更新时间排序。 |
| 学习 | `autoLearn.maxWritesPerSession` | `5` | 每会话自动落盘候选上限（0–5；活跃＋pending 共享；0＝关闭自动候选）。用户显式 `origin=manual` 保存不占额度。 |
| 学习 | `conflictAlert` | `true` | 疑似冲突/待确认提醒开关（I4 使用；待确认候选始终不会注入）。 |
| 学习 | `digest.enabled` / `digest.weekday` | `true` / `1` | 确定性周报开关与星期（1=周一；I4 使用；只做审计数据聚合，不调用 LLM）。 |
| 存储与备份 | `autoBackup` | `false` | 开启后每天自动导出全量到 `backups/`（启动 5 秒首检、每小时检查、距上次超 24h 才落盘；只轮转插件自己的时间戳备份；失败降级并在 status 暴露 `backupError`）。 |
| 存储与备份 | `backupRetention` | `7` | 备份保留份数（1–30），超出裁剪最旧；仅删备份，不删记忆。 |
| 面板偏好 | `defaultView` | `all` | 默认视图：`all`/`global`/`workspace`（workspace＝当前工作区）。 |
| 面板偏好 | `pageSize` | `50` | 每页条数：20/50/100。 |
| 面板偏好 | `viewMode` | `comfortable` | 列表密度：`comfortable`（索引行，分类/标签/元信息全量）/`compact`（单行高密度表格，一屏更多条目；工具栏分段控件与设置页下拉同源）。 |
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
| `injectionBudgetChars` | `8000` | 注入预算基线值；面板设置可覆盖。 |

## 限制 Limitations

- 检索为关键词匹配（含 CJK bigram 模糊）＋相关度×衰减排序，无语义/向量检索。
- 软衰减仅影响排序（永不过滤、可关）；不自动物理清理记忆，遗忘只能手动（自动备份仅裁剪备份文件，不删记忆）；过期/归档/取代均为可逆隐藏。
- **自动学习是信号驱动的"人在环"**：没有直接用户消息信号就不会自动落盘；R2 候选需面板批准后才生效；不做后台 LLM 提取/整合（零额外模型调用）。规则层是保守启发式，可能漏检真实信号或误报（漏检＝少学，误报＝多一条待确认/可撤销条目）。
- **`constraint` 是行为偏好提示，不是工具级强制安全策略**：真正的高风险操作仍需宿主策略/审批；R3（机密/短期任务/内嵌指令/敏感推断）是规则型护栏，不能识别全部敏感语义——面板必须保留来源、审阅与撤销入口。
- 备份/导出会附带 `learning` 状态（pending/audit），但**导入/恢复只恢复 entries**：不从备份恢复 pending 候选（设计已知限制，留待后续增量）。
- 信号状态的清理依赖 TTL（7 天）与写入时惰性回收；会话异常退出可能在 `learning/state.json` 留下短期残留（operational 数据，不参与快照 diff）。
- 学习分区的 GUI 断言在 I4 补齐；I1 以单元测试、live 契约与 `scripts/eval-replay.mjs`（FI-1…FI-10）覆盖机制，面板回归由既有 gui-check 全绿保障。
- **召回是两层**：索引层只有确定性单行摘要（正文超 80 字符截断），完整正文必须 `memory_search`；常驻层（pinned/constraint）永不截断，装不下整条省略并计数。
- **存量合并只处理精确重复**（同作用域+规范化正文+关键元数据一致）；相似/冲突/元数据不同只报告，不自动合并；合并=归档可逆（不物理删除），并写 `duplicates_merged` 审计。重复组扫描范围与面板一致（global + 当前工作区），其它工作区需切换后查看。
- 访问暴露与长期存活**不会**触发自动归档或质量加分；批量归档只能由用户在选择后显式执行。
- 记忆按 home 共享：同一台机器上的所有 profile 看到同一份记忆。
- 移动仅支持 global ↔ 当前工作区（工具按会话有效目录，面板按所选工作区）；不支持在两个不同工作区之间直接移动。
- 导入时，工作区条目优先按权威 `workspaceKey` 定位目录——索引损坏/缺失（cwd 未知）也能恢复到原工作区；只有**旧格式导出（无 workspaceKey）且 cwd 缺失**的条目会被拒绝（no-workspace），可手工把文件放回对应目录。
- 面板「当前工作区」已与会话有效目录对齐：初始取 SessionSummary.cwd，再经 `/cwd` 路由按 workingDirectory 服务（跟随 cd）刷新，与 agent 工具口径一致；agent 侧对 workingDirectory 按次实时查询（服务晚于插件就绪也能生效），服务不可用时回退初始目录。
- 索引损坏导致路径未知的工作区（cwd:null）在下拉中显示为「未知工作区」但不可选；其记忆在该工作区为会话工作目录时仍对 agent 工具与召回注入可见，也可直接编辑对应目录下的文件。
- 与 DSH 既有机制互补：不接管 goals、skills、AGENTS.md，也不索引会话历史。
- 并发写入下，单条保存的去重检查是尽力而为：两个进程同时写入完全相同的内容时可能各留一条（可手动删除）；文件与索引本身不会损坏或丢失。

## English summary

dsh-memory gives the agent durable cross-session memory. Four tools (`memory_save`, `memory_search`, `memory_update`, `memory_forget`) and a Web management panel (sidebar "Memory" entry) share one service layer over one-fact-per-entry Markdown files under `~/.dsh/.dsh-memory/`, split into a global scope and per-workspace scopes keyed by the session's effective working directory. A system-prompt section re-reads the files on every assembly and injects them in two layers within a configurable character budget: a resident layer (pinned entries and user-correction `constraint` preferences, full text, never truncated) and an index layer (all other active entries as deterministic one-line summaries capped at 80 characters; `memory_search` reads the full entry), ordering pinned entries first, then preferences over decisions over facts, then by a soft-decay multiplier within a category; superseded/expired/archived entries are hidden by default, and entries that did not fit are reported with separate over-budget / single-entry-too-long counts. Non-empty searches are AND keyword matches (with CJK bigram fuzzy matching) ranked by relevance times a decay multiplier. Schema v2 adds optional, sparsely-stored fields: `origin` (manual/auto), a supersede chain (`supersedes`/`superseded_by`/`superseded_at`), `expires` (hide-on-expiry, reversible, bad dates fail-open), `pinned`, `archived`, and access bookkeeping (`last_access`/`hit_count`, throttled to once per hour). Deterministic stock curation lists exact duplicate groups (same scope, normalized content and key metadata) through `GET /duplicates`; a confirmed `POST /duplicates/merge` keeps the earliest entry, archives the rest (reversible) with a `duplicates_merged` audit record, and never merges merely similar or metadata-different entries; `POST /archive` archives/restores a batch (reversible, audited), and access or survival never triggers automatic archiving. Loading old v1 data forces a backup before bumping the meta anchor; entry files are never rewritten (lazy defaults), so migration is lossless. A feature-detected `systemPrompt.context()` provider turns direct-user learning signals (explicit "remember" instructions, direct corrections, corrections after a failed tool, new environment facts, repeated statements) into a one-line reminder carrying only signal ids; `memory_save` must present a live, unconsumed `signal_id` and the tool boundary enforces per-session auto-write quota (default 5) plus R0–R3 risk separation: refused (credentials/short-term/embedded-instructions/sensitive inference), pending review (procedural knowledge, broad constraints, weak/inferred signals, suspected conflicts), or active low-risk. Direct-user corrections become `constraint`-tagged preferences that inject right after pinned entries and are exempt from soft decay. Schema v3 adds a `learning/` directory (`pending.json`, append-only `audit.jsonl`, operational `state.json`) created by a backup-first, entry-preserving v2→v3 migration. The panel gains a "Learning" section for pending approval/rejection, recent auto writes (archive = reversible undo) and audit; loopback-only `/learning`, `/learning/approve`, `/learning/reject` routes back it. `scripts/eval-replay.mjs` deterministically replays mechanisms FI-1…FI-10 against isolated data roots. The panel offers scope/status/origin filtering, pin/archive quick actions, an expires editor, and talks to loopback-only `webServer` routes guarded by a process token. Credentials (including bearer tokens and connection strings with passwords) are rejected at the service boundary; other sensitive information requires user confirmation per the injected guidance. Updates supersede in place or via the supersede chain, and can move an entry between global and the current workspace. The panel exports all memories as a versioned JSON document (preserving v2 fields) and imports them back with a dry-run preview, per-entry validation, dedupe, and preserved ids/timestamps. Forgetting is manual only; decay never filters and nothing is auto-deleted. Hand edits to the Markdown files take effect immediately. A cross-process mkdir lock protects the workspace index and bulk-import writes when several DSH profiles share the same home.
