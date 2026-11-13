# DSH 宿主扩展点侦察（host-scan · 2026-11-13 · 只读）

来源：host-scan 子代理阅读随版文档/源码核实；未做 live 验证。路径缩写：
- [R] = D:\deepseekharness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\dsh-doc\references\
- [P] = D:\deepseekharness\resources\app.asar\dsh\node_modules\@deepseek-ai\
- [D] = D:\deepseekharness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\docs\
- [M] = D:\Questions\dsh-memory\

## 1. 生命周期/事件
- agent 事件：agent/created、agent/disposed、agent/status、agent/pre-step（waterfall，可拒绝或替换进入步骤的消息）、agent/turn-stopping（回合将关闭时可 steer 保持打开）、agent/request-error（可重试）、agent/assistant-stream（live 流）、agent/inbox/inserted|claimed|discarded；agent/request 已弃用且不能改请求消息。来源：[P]dsh-agent\README.md L58-104；[R]practices.md L16-18。
- 会话事件：session/event（全部已提交事件 feed）、session/created、session/disposed（会话移除/结束）、session/flush；持久表面事件 user/message、assistant/message、tool/result、system/message、developer/message；回合结束 turn/end（带取消原因）、step/start、tool/call。来源：[P]dsh-session\README.md L28-52；[P]dsh-agent-loop\README.md L128；[R]practices.md L28。
- 工具管线：tools/pre-execute（allow/deny/ask）→ guard（单调拒绝）→ tools/execute（包装）→ tools/post-execute（改写结果）→ tools/result（观察冻结的最终结果，即「工具调用完成」）。来源：[P]dsh-tools\README.md L92、L137。
- 回合/会话结束注入提醒（不额外调模型）：可以。
  a) agent.inject()：写模型可见上下文、不唤醒 driver，记录为 agent/inbox/spliced，进入下一个被准入步骤；followup() 才唤醒。可在 turn/end 监听里 inject，提醒等待下次输入。来源：[P]dsh-agent\README.md L58；[R]practices.md L18、L29。
  b) ctx.systemPrompt.context()：运行时上下文提供者在每次准入前重读（refreshContext），仅变化时落盘为 <system-reminder> user 消息。来源：[D]subsystems\system-prompt.md L76-96、L184-194；[P]dsh-agent-loop\README.md L168-180。
  c) 会话结束后向「下一个会话」注入：未找到专用钩子；跨会话提醒靠装配时重读存储实现（dsh-memory 现做法）。来源：[P]dsh-session\README.md L34；[M]index.js L250-266。

## 2. 提示词注入
- 机制（弱→强）：ctx.systemPrompt.section()（有序段落）；ctx.systemPrompt.context()（缓存安全动态上下文，user 角色快照）；ctx.systemPrompt.variable()（{{变量}}）；agent.inject()（按 agent 持久上下文消息）；agent/pre-step waterfall（替换步骤消息，须 spread decision）；system-prompt/assemble waterfall（替换整个装配，须保留他人贡献）。来源：[R]practices.md L10、L16-18；[D]subsystems\system-prompt.md L124-234。
- 按回合动态更新：能。section/context 的 text 可为 (AssembleContext)=>string，每次装配（每个被提议步骤一次、agent/pre-step 之前）求值；context 另在准入刷新时重读；agent.ctx 作用域注册可影子同名全局。来源：[P]dsh-system-prompt\README.md L56-70；[D]subsystems\system-prompt.md L48-96。
- dsh-memory 现用：ctx.systemPrompt.section({name:'dsh-memory', order:9500, interpolate:false, text:sectionText})，每次装配实时重读记忆文件＋设置，失败降级纯指引。来源：[M]index.js L250-266。

## 3. 工具面
- 注册：ctx.tools.register(def)（或 defineTool）；parameters 支持类型化 DSL 与原始 JSON Schema；output.schema 声明规范 JSON 返回，output.render(args,value) 生成会话/UI 渲染内容块；isConcurrencySafe 声明并发安全；execute(args,exec) 收 exec.signal 协作取消；注册即自动进入提示词装配。来源：[P]dsh-tools\README.md L30-64。
- 条件工具 register(def,{when}) 每步求值；timeoutMs 仅声明，强制需 dsh-tool-call-timeout-policy。来源：[P]dsh-tools\README.md L69、L199。
- UI 提示：output.render 即会话可见渲染；Host 端 presentCall/presentResult 仅 Host 本地消费，Web 客户端经 tool.call.toolview 选渲染器、从原始参数/结果派生卡片。来源：[P]dsh-tools\README.md L96-98。
- 读会话历史/元数据：能。exec.agent.session（dsh-memory 用 session.id、session.header.cwd，workingDirectory 服务取有效 cwd）；ctx.sessions.get/list；session.deriveMessages()/snapshotEvents()；派生状态用 ctx.sessionProjections；历史会话用 ctx.sessionQuery（见 6）。来源：[M]index.js L71-88、L123-134；[P]dsh-session\README.md L44-64；[R]practices.md L26。

## 4. 客户端 UI
- 注册方式：ctx.slots.inject(ownerKey, ()=>ctx.slots.register(...))；浏览器产物注册惰性 factory（id=包名），React 来自浏览器模块表。来源：[R]ui-plugin.md L7-13；[R]practices.md L36。
- 可用 slot/面板：
  · 全局独立页面：根作用域 main keyed slot（conversation 为保留键）＋sidebar.panellist 图标入口（同 id），ctx.layout.selectPanel(id)。dsh-memory 现用此方案（key=dsh-memory）。来源：[P]dsh-client-ui-layout\README.md L36；[P]dsh-client-ui-sidebar\README.md L42；[M]client\client.js L6。
  · 右侧栏停靠标签：ctx.sidebarRightTabs.register({id,kind,patterns?,title,guide?,keepMounted?})＋sidebar.right.pane.tab slot（key=注册 id）；ctx.sidebarRight.openTab/openResource 导航；guide 入口盒、sidebar.right.tab.menu.item 菜单。来源：[P]dsh-client-ui-sidebar-right\README.md L83-90、L112。
  · 设置页：settings.section（＋settings.section.icon）、settings.plugins.tab（插件页标签）、settings.onboarding；ctx.configForms 读写 Host 设置。来源：[P]dsh-client-ui-settings\README.md L45-47。
  · 消息内 Chat 行：ctx.uiConversation.events.register() 定义事件＋conversation.chat.node slot（按 kind 渲染）。来源：[R]practices.md L37。
  · 其他：conversation.composer.dock（输入框坞）、shell.overlay（浮层）、shell.bottom。来源：[R]ui-plugin.md L5；[P]dsh-client-ui-layout\README.md L38。
- 记忆审阅/管理面板现成能力：现 main 全局面板可续用；右栏 tab 提供按会话停靠/浮动/keepMounted；管理列表视觉参考 Plugin Manager 页；主题用 --dsw-alias-* 令牌、文案走 ctx.locale；禁止 iframe served HTML、禁止 require 宿主 Client 包、禁止操作他人 DOM。来源：[R]practices.md L33-36。
- client↔host 通信：
  · Remote RPC：ctx.remote 命名空间（如 settings）、会话命令 ctx.remote.commands.execute()；传输 HTTP POST 一元＋/api/remote.mux WebSocket 流；鉴权：进程级 launch token（GET / ?token=）换签名 HttpOnly Cookie（默认 30 天），Host/Origin 信任检查，未认证 401/信任失败 403。来源：[R]user-actions.md L8；[P]dsh-client-connection\README.md L34、L41-49。
  · webServer 命名路由：ctx.webServer.register(exact/prefix, handler/resource)，无服务器级鉴权、路由所有者自负责。dsh-memory 现用 /plugins/dsh-memory/*＋进程级 token（X-RPC-Key）＋回环检查。来源：[P]dsh-host-webserver\README.md L61、L132；[M]index.js L290-297、client\client.js L7。

## 5. Config
- 定义：export const Config（schema 库为 @deepseek-ai/schemastery，宿主激活时校验行 config）；dsh-memory 未声明 Config，自行解析 raw config＋默认值。来源：[R]host-plugin.md L62-65；[P]dsh-agent-loop\src\index.ts L11；[M]index.js L34-49。
- 用户配置存储：profile 的 cordis.patch.yml（用户 patch 层，升级保留）；插件不得自行重写，须用 ctx.get('configEditor').edit(entry,change)：校验候选、序列化写入、保留注释/!!js、拒绝被高层覆盖的值。来源：[R]configuration.md L3-12；[P]dsh-config-editor\README.md L12、L41、L67-69。
- 热更新：普通字段编辑→重启插件重建状态；.volatile() 字段原地更新、config.field.get() 读取；新装 bundle 可 HMR 激活，替换已装包需重启。dsh-memory 的 settings.json 每次装配重读（插件自有热更新）。来源：[R]configuration.md L12；[R]host-plugin.md L75；[M]index.js L248-262。

## 6. 存储
- 宿主设施：ctx.storage（hub）＋ctx.storageDomain（domain 形态）＋后端（dsh-storage-json，config.root 指定目录；kv facet）；仅 Host 侧、无模型可见影响；组合行 storage＋backend＋storage-domain。来源：[P]dsh-storage\README.md L28-58、L79。
- 数据目录约定：$DSH_HOME 否则 ~/.dsh（resolveDshHome/dshHomePath/dshCachePath，cache 在 home/cache）；凭据 $DSH_HOME/.credentials.yaml（ctx.credentials.modifyRecord）。来源：[P]dsh-home-paths\README.md L31-41；[P]dsh-client-connection\README.md L43；[R]configuration.md L12。
- 历史会话数据：能。ctx.sessionQuery：listSessions/readSession/filterSessions/filterEvents/readSurface/searchSessions/searchEvents/traceSession 等，live 优先、持久兜底；全文检索需 dsh-session-query-sqlite（随发行版挂载）；持久日志 JSONL（dsh-session-persistence-jsonl）。来源：[P]dsh-session-query\README.md L28-43。
- 会话日志写入限制：不得 append 新 type；appendPluginRecord 仅限 DSH experimental 包；插件数据放 storage 服务或自有文件。dsh-memory 现用 ~/.dsh/.dsh-memory/ Markdown＋frontmatter。来源：[R]practices.md L21；[P]dsh-session\README.md L72-76；[M]index.js L51-54。

## 7. 边界
- 直接调模型：并非禁止——ctx.llm.stream 是唯一受支持路径；辅助请求须以模块增强在 LlmRequestPurposeMap 声明 purpose；模型可见输入必须可由会话日志重建；loop 请求深冻结不可改写。插件可发起额外模型调用（如摘要）但受上述约束。来源：[P]dsh-llm\README.md L12、L34、L61-63。（本次升级 Q7 已决定不用。）
- 跨会话访问：Host 代码可经 ctx.sessions/ctx.sessionQuery 读 live＋持久会话（见 6）；未找到禁止性规定。
- 影响其他插件：扩展点共享、用够用的最弱机制；guard 拒绝单调不可翻转；restrict 只能移除；waterfall 依赖注册顺序、须 next() 并保留他人贡献；assemble 替换整体须保留他人；agent.ctx 作用域注册只影响该 agent。来源：[R]practices.md L8-10、L16-19。
- 其他禁止：不得读其他插件 DOM/样式/组件源码；不得 require 宿主 Client 包；不得替换 app root/向 document.body 追加；不得 iframe served HTML 页；tools/pre-execute 不能改写 exec.arguments；agent/request 不能改请求消息（已弃用）；不得自行重写 profile patch。来源：[R]ui-plugin.md L13；[R]practices.md L33-35；[P]dsh-tools\README.md L197；[P]dsh-agent\README.md L78；[R]configuration.md L3。

## 8. 版本与升级指南
- 当前版本：0.2.2-rc.2（CLI 包 @deepseek-ai/dsh 与桌面 runtime 同版本）。来源：[P]dsh\package.json L2-4；D:\deepseekharness\resources\app.asar\dsh\package.json L2-4。
- 升级索引：[D]upgrade-guide\README.md。与记忆类插件相关的面（条目路径均在 [D]upgrade-guide\v<T>\<item>\guide.md）：
  · v0.2.2-rc.1/runtime-context-reminders：运行时上下文 user/message 包 <system-reminder>，首份/后续快照措辞与清空标记（form:'snapshot', sections:[]）——直接影响记忆注入呈现与识别。
  · v0.2.2-rc.1/session-append-overloads：Session.append 单事件＋数组双重载。
  · v0.2.1-rc.2/conditional-tools：system-prompt/assemble 不再携带工具；条件工具走步骤准入（when）。
  · v0.2.1-rc.2/session-projection-handles：投影注册异步句柄；注册表级状态读取弃用。
  · v0.2.1-rc.3/inbox-only-agent-wait：wait_agent 仅由 inbox 输入结束（inject 不唤醒的配套语义）。
  · v0.2.1-alpha.4/session-model-selection：agent/request 弃用、模型在步骤准备时固定。
  · v0.2.1-alpha.3/plugin-engines-dsh：兼容性先读 engines.dsh（dsh-memory 声明 >=0.2.0-rc.2，见 [M]package.json L17-20）。
  · v0.2.1-alpha.2/plugin-install-over-installed：HMR 下覆盖安装已装包失败，升级须先移除（与现有 dsh-memory 升级流程一致）。
  · v0.2.1-alpha.1/instruction-home-override：harness home 恒为 $DSH_HOME 或 ~/.dsh。
- 未找到以「记忆」命名的专用新扩展点；相关新能力为运行时上下文提醒、投影句柄、条件工具等通用面。
