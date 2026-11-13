# 消费级 AI 助手「记忆」功能调研 · Part 1：聊天助手

> 调研时间：2026-11-13（Asia/Shanghai）
> 调研对象：ChatGPT（OpenAI）、Claude（Anthropic）、Google Gemini、Microsoft Copilot（消费版 + Microsoft 365 工作版）
> 方法：以各平台**官方一手来源**为准（官方帮助中心、官方博客、官方 Learn/文档、官方新闻室）。`web_search` 仅作线索，结论均经 `web_fetch` 官方原文核实；无法抓取正文者明确标注「未能核实」，不臆造。
> URL 纪律：本报告所有引用 URL 均为目标平台真实官方域名（help.openai.com / openai.com / claude.com / support.claude.com / learn.microsoft.com / support.microsoft.com / news.microsoft.com / blogs.microsoft.com / blog.google / support.google.com / gemini.google.com），未使用任何临时代理或镜像地址。

## 核实状态图例

- ✅ **已核实**：`web_fetch` 抓到官方原文正文，结论直接来自该正文。
- 🟡 **部分核实**：官方页面抓到标题/日期等元信息，但正文为动态渲染未能完整抓取；相关细节标注「未能核实」。
- ❌ **未能核实**：官方 URL 已定位，但本调研环境中多次抓取失败（网络层错误）或正文不可得；仅给出官方链接供读者自查，不作为已证实结论。

**本环境抓取限制说明**：`support.google.com`、`gemini.google.com` 在本环境多次（≥9 次）`web_fetch` 均返回网络层错误（`TypeError: fetch failed`）；`blog.google` 文章页与 `openai.com/index/*` 博客页正文为客户端动态渲染，抓取仅得标题/日期壳。因此 **Gemini 一节多数机制细节标注「未能核实」**，OpenAI 两篇博客的正文级细节同样标注。其余平台（Claude、Microsoft、OpenAI 帮助中心）均抓到完整正文。

---

## 1. ChatGPT Memory（OpenAI）

### 1.0 时间线（标注核实状态）

| 时间 | 事件 | 状态 |
|---|---|---|
| 2024-02-13 | 首次推出 Memory 与相关控制（官方博客 *Memory and new controls for ChatGPT*） | 🟡 标题/日期已核实，正文未能抓取 |
| 2025-04 | 推出 reference chat history（引用全部历史聊天），先 Plus/Pro | ❌ 官方公告原文未能抓取；机制本身见现行 FAQ ✅ |
| 2026-01-15 | 改进记忆：更可靠地从历史聊天找到具体细节，被引用的历史聊天作为 source 展示（Plus/Pro，全球） | ✅ 官方发布说明 |
| 2026-05-05 | 推出 Memory Sources（全部消费级计划）；Plus/Pro 更好利用历史聊天/保存记忆/文件/Gmail 上下文 | ✅ 官方发布说明 |
| 2026-06-04 | 官方博客 *Dreaming: Better memory for a more helpful ChatGPT*，副标题「优化时效性、连续性、相关性」 | 🟡 标题/日期/副标题已核实，正文未能抓取 |
| 2026-08-14 | 已有项目可切换 Default memory / Project-only memory | ✅ 官方发布说明 |
| 2026-10-20 | 推出 locked chats（锁定聊天） | ✅ 官方发布说明 |
| 2026-11（FAQ 约 12 天前更新） | 现行帮助文档区分 improved memory 与 legacy saved memories，含 memory summary、Sources 等 | ✅ 官方帮助文档 |

来源：[Memory and new controls for ChatGPT（2024-02-13）](https://openai.com/index/memory-and-new-controls-for-chatgpt/)、[Dreaming（2026-06-04）](https://openai.com/index/chatgpt-memory-dreaming/)、[ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)（2026-01-15、2026-05-05、2026-08-14、2026-10-20 条目；较早条目经同一官方文章的官方本地化版本核实）、[Memory in ChatGPT（Help Center）](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。

### 1.1 记忆模型与存储 ✅

现行官方帮助文档把记忆来源分为多类，且**随计划/地区/平台/工作区设置而异**： past chats、saved memories、custom instructions、通过 Library 或 Space 保存的文件、已连接应用（如 Gmail）的内容。官方明确「Memory 不会保留每段对话的每个细节；ChatGPT 自行判断哪些可用信息与当前回答相关，且记忆会随上下文变化而变化」。

存在两套体验：
- **Improved memory**：持续更新一份「更广泛的相关上下文摘要」（continually updates a broader summary of relevant context）。
- **Legacy saved memories**：更显式的「单条记忆项列表」。
- 在提供选项处可在两者间切换（Settings → Personalization → Memory → Saved memories / Try improved memory），切换不删除聊天历史。

存储关系上，**saved memories 与聊天历史分开存储**：删除原始聊天不会自动删除由该聊天产生的独立 saved memory。reference chat history 派生的信息则「会随 ChatGPT 更新最有用的内容而变化」，不像显式 saved memory 那样固定。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。

### 1.2 写入路径（自动 vs 手动、触发时机） ✅

- **手动**：用户显式要求「记住……」即写入 saved memory。
- **自动**：当该行为可用时，ChatGPT 会把「有用上下文」主动保存为 saved memory；improved memory 则持续从历史聊天合成/更新摘要。官方 FAQ 明确「如果你分享了对将来可能有用的信息，ChatGPT 可能不经你要求就保存」。
- **触发时机**：并非每条消息都写；官方 FAQ 称「ChatGPT 不会为每个回答都搜索历史」，而是「在可能改善回答时才寻找相关上下文」。
- **敏感信息**：官方承认敏感信息若被分享可能进入 Memory，并表示正设法「把 ChatGPT 从主动记忆敏感信息（如健康细节）上引开——除非你明确要求」。
- **不写入的场景**：Temporary Chat 默认不创建/更新记忆；locked chat 锁定期间的新消息不写入常规记忆。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。

### 1.3 检索与注入方式 ✅

- 回答时由模型判断相关性，从上述多源中取用上下文注入；**不是每回答都全量检索历史**。
- **Sources（记忆来源）**：当使用个人上下文时，回答下方可能出现 Sources，列出贡献了个性化的历史聊天、saved memory、custom instruction、文件、已连接邮件等；可打开/审查、纠正或删除 saved memory、删除被引用聊天、标记相关/不相关。Sources 不一定展示影响回答的全部因素；**通过分享链接分享对话时不包含 Memory Sources**。
- **记忆可个性化网页搜索**：开启 Memory 后，ChatGPT 可用相关细节（位置、饮食偏好）构造更有用的搜索查询。
- 2026-01-15 起，被用于回答的历史聊天会作为 source 展示，便于回溯原始上下文（Plus/Pro）。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)。

### 1.4 用户控制（查看、编辑、删除、暂停） ✅

- **入口**：Settings → Personalization → Memory；依体验不同可见 Memory / Reference saved memories / Reference chat history / Memory summary / Manage / Saved memories 等控件。
- **查看**：Memory summary 提供高层视图（不一定含全部细节/来源）；也可直接问 ChatGPT「你记得我什么」。
- **编辑/纠正**：可在 memory summary 文本框输入纠正、高亮文本纠正；可编辑 saved memory（控件可用时）；可口头告知信息有误/过时。
- **单条删除**：从 memory summary 或 saved-memory 控件删除单条；或删除承载该信息的聊天/文件/断开应用。
- **全部清除**：memory summary 的 ••• 菜单提供 **Delete and turn off memory**（删除摘要所示记忆并关闭 Memory，但不删历史聊天）。
- **「不再提及」**：Don't mention this again 降低未来引用，但**不删除原始来源**。
- **开关**：可关 Memory；关 Reference saved memories 会同时关 Reference chat history；Reference saved memories 开启时可单独管理 Reference chat history。关闭 Memory 不删历史聊天；重新开启后可能从仍在历史中的聊天生成新记忆。
- **saved-memory 高级控件**（依计划/平台）：搜索、排序、自动优先级、版本历史。
- **青少年账户**：家长/监护人可通过 Parental controls 管理支持的记忆控件。
- **工作区**：所有者/管理员可管理记忆设置与角色权限。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。

### 1.5 作用域（账号、项目、会话） ✅

- **账号级**：记忆默认跨会话作用于账号；多账户切换时「每个账户保留各自的 chats、memory、settings、subscriptions」（2026-10-30）。
- **项目级（Project-only memory）**：在 ChatGPT for Healthcare 与带 Regulated Workspace 的 Enterprise 中，成员可选 Project-only memory，把记忆上下文限定在特定项目——项目内聊天可互相引用，但不能引用项目外对话，项目外也不能引用项目内。2026-08-14 起所有计划的合格未共享项目可在 Default / Project-only 间切换；**共享项目强制 Project-only**；Project-only 项目中不提供 ChatGPT Work。
- **会话级**：Temporary Chat（可选是否个性化）、locked chats（锁定期间新消息不个性化常规聊天）。
- **Health 空间**：Health 的对话、记忆、文件与 ChatGPT 其余部分分开保存，不用于训练基础模型（2026-01-07 发布说明）。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)。

### 1.6 冲突与更新策略 ✅/🟡

- ✅ improved memory「持续更新更广泛的相关上下文摘要」；reference chat history 派生信息「随 ChatGPT 更新最有用的内容而变化」——即系统侧自动修订，而非静态条目。
- ✅ 用户可口头纠正、编辑 summary/saved memory、标记 source 不相关来干预。
- 🟡 *Dreaming* 博客（2026-06-04）副标题明确优化「时效性、连续性、相关性」。搜索索引显示该官方博文正文举例「把『你七月要去新加坡』随时间修订为『你在 2026 年七月去过新加坡』」，并称降低免费版所需算力约 5 倍、提升 Plus/Pro 记忆容量——**这些正文级细节未能核实**（博客正文动态渲染，仅抓到标题/日期/副标题）。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[Dreaming](https://openai.com/index/chatgpt-memory-dreaming/)（🟡）。

### 1.7 遗忘与衰减 ✅

- **关 Reference chat history**：从历史聊天记住的信息「计划在 30 天内从 OpenAI 系统删除」；原始聊天仍保留除非用户删除。
- **删除 saved memory**：阻止未来个性化使用，但不移除历史对话中的提及；OpenAI 可能为安全/调试保留已删除 saved memory 的日志**最多 30 天**。
- **彻底移除**需多源清理：memory summary、saved memories、常规与归档聊天、Library/Space 文件、已连接应用；删除与记忆更新传播需要时间。
- **reference chat history 无单独存储上限**（「There is no separate storage limit for what ChatGPT can reference through chat history」）。
- 关 Memory 不删历史聊天；Don't mention this again 不删源。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)。

### 1.8 隐私设计 ✅

- **Temporary Chat**：开始前可选是否使用既有记忆/custom instructions/plugins（选 Unpersonalized 则不用）；开始后不可改。临时聊天**不创建/更新记忆**（即使个性化开启）；保存临时聊天会转为常规聊天并遵循账号个性化与模型改进设置。默认非个性化。
- **训练**：个人账号在「Improve the model for everyone」开启时，OpenAI 可能用聊天与记忆改进模型（可在 Data controls 关闭）；Business/Enterprise/Edu/Healthcare 工作区内容默认不用于训练。
- **安全例外**：关闭 Memory/个性化**不会**禁用罕见高风险情境下有限的安全/安保上下文使用，该用途独立于个性化控件。
- **受监管工作区**：Healthcare 与 Regulated Workspace Enterprise 中 improved memory 默认禁用；该功能不在 BAA 覆盖内，使用时不应输入 PHI。
- **locked chats**：锁定聊天可用常规记忆，但锁定期间新消息不个性化常规聊天；永久解锁后整段对话可能在设置允许时用于常规记忆。
- **广告**（2026-03 发布说明）：Free/Go 在部分国家展示广告；若开启广告个性化，广告会使用留在 ChatGPT 内、不与广告主共享的信息（含历史聊天与记忆）；敏感/受监管话题及未成年不展示。

来源：[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)、[ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)。

### 1.9 特色亮点

- **双机制分层**：显式 saved memories（可控条目）+ reference chat history（无上限、自动演化）+ improved memory 摘要，兼顾可控与「懂你」。
- **Sources 可溯源 + 可操作**：把「哪条记忆/哪段聊天/哪个文件/哪封邮件」暴露给用户并支持纠正/删除/标记不相关，是少见的细粒度透明化。
- **Memory summary 可编辑 + Don't mention this again**：在「删除」之外提供「降低引用」的软控制。
- **Project-only memory / Health 隔离 / locked chats**：多层作用域隔离。
- **saved-memory 版本历史、搜索、自动优先级**（依计划）。

### 1.10 明显短板

- **自动写入 + 敏感信息可能落库**：官方承认敏感信息可能被主动记忆，需用户事后清理。
- **删除语义复杂**：删聊天≠删 saved memory；彻底遗忘需跨 5+ 来源手动清理，且传播有延迟、日志保留 30 天。
- **summary 非全量**：Memory summary 与 Sources 都「不一定含全部」，用户难以确知到底记住了什么。
- **体验碎片化**：控件随计划/地区/平台/工作区差异大，improved/legacy 双轨并存，用户心智负担重。
- **安全例外不可关**：高风险情境的上下文使用独立于个性化开关，用户无法完全退出。

---

## 2. Claude（Anthropic）

### 2.0 时间线 ✅

| 时间 | 事件 |
|---|---|
| 2025-09-11 | 官方博客 *Bringing memory to Claude*：Team/Enterprise 先行；引入项目级记忆、可编辑 memory summary、Incognito chat（全体用户） |
| 2025-10-23 | 扩展至 Pro/Max（博客更新段） |
| 2026-10-30 | 博客编者注：此前提及的 Max 现含 Max 与 Ultra 计划 |
| 2026-10-31（太平洋时间）起 | 新建 Team/Enterprise 组织默认对成员开启 memory（除非该账号此前关过）；旧组织默认关 |
| 2026-11（帮助文档「本周更新」） | 新记忆体验：按 topic 实时保存；Chat 与云端 Cowork 共享记忆；Duet 研究预览使用/写入记忆；legacy 24 小时摘要体验仅少数 Team/Enterprise 组织保留 |

来源：[Bringing memory to Claude](https://claude.com/resources/articles/memory)（由 [anthropic.com/news/memory](https://www.anthropic.com/news/memory) 重定向至 claude.com 官方域）、[Use Claude's chat search and memory to build on previous context](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.1 记忆模型与存储 ✅

- **新体验（主流）**：Claude 在聊天过程中**按一组独立 topic 保存记忆**，而非对话结束后才摘要（「Mention that a deadline moved, and your next conversation already knows」）。
- **Legacy 体验（少数 Team/Enterprise）**：自动摘要对话、跨聊天历史合成关键洞察（不含项目内聊天），**每 24 小时更新一次**，为每个新的独立对话提供上下文；每个项目有独立记忆空间与专属 project summary。
- **项目记忆**：每个项目有独立记忆；项目内工作时使用「项目记忆 + 项目外聊天的账号记忆」，但**不使用其他项目的记忆**；新记忆存入项目，开启记忆时也可在项目外聊天引用。可在项目页 Memory 下关闭「Use account memory」使项目记忆完全隔离。
- **跨产品**：Chat 与**云端 Cowork** 共享记忆（本地 Cowork 不用记忆）；Duet（Pro/Max/Ultra 研究预览）也使用并写入记忆。
- **存储与加密**：记忆条目静态加密（encryption at rest）；legacy 的 chat summaries 与对话数据同存、memory synthesis 加密并与底层对话关联。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)、[Bringing memory to Claude](https://claude.com/resources/articles/memory)。

### 2.2 写入路径（自动 vs 手动、触发时机） ✅

- **自动**：聊天过程中实时按 topic 保存（新体验）；legacy 为每 24 小时合成。
- **手动**：可直接对 Claude 说「remember this」保存；可在设置 Manage 面板用「Tell Claude what to change or remove」框添加；可在聊天中要求记住/修改/忘记，更新作用于下一段对话。
- **初始 setup**：可让 Claude 基于既有聊天生成记忆（博客「let Claude generate memory with your past chats at initial set-up」）。
- **敏感话题默认不写**：默认不保存健康、种族、族裔、宗教、政治、性别认同等敏感话题；用户可在 Settings → Your Claude 开启「Include sensitive topics in memory」，或在首次因敏感被拒存时的一次性提示中开启。开启后**仅向后保存**（不追溯），每次保存敏感条目会在输入框上方提示；拒绝提示或后续关闭会**移除已存敏感条目**。旧版移动端不显示提示则不保存敏感话题。
- **永不保存**（即使用户要求）：政府 ID 号、犯罪记录、金融账号、移民身份；Claude 会告知无法保存。
- **不写入场景**：Incognito chat、单聊关闭 Memory、使用过 Personal Finance 链接账户的聊天（设计上不存记忆也不被搜索）。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.3 检索与注入方式 ✅

- **记忆注入**：新体验下 topic 记忆为对话提供上下文；legacy 下 24 小时合成的 summary 为每个新独立对话提供上下文。
- **聊天搜索（RAG）**：付费计划（Pro/Max/Ultra/Team/Enterprise）可让 Claude 搜索既往对话，**以 RAG 实现并在对话中显示为 tool call**；搜索边界为「项目外全部聊天」与「单个项目内聊天（限该项目）」；设计上不搜索使用过 Personal Finance 链接账户的聊天。搜索默认开启（ rollout 到账号后）。
- **引用（citations）**：通过搜索引用既往对话时，显示**回链到原始聊天的 citations**，并提供删除特定对话的选项。
- 项目内使用项目记忆 + 账号记忆（不含其他项目）。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.4 用户控制（查看、编辑、删除、暂停） ✅

- **查看/管理**：Settings → Your Claude → Your memory 旁「Manage」（旧布局 Settings → Memory）；全部记忆列于 **Topics** 下，点开可读、用编辑图标修改、或 Delete 删除；改一个 topic 即作用于此后所有对话。
- **聊天内更新**：直接告诉 Claude 记住/修改/忘记，下一段对话生效（legacy 下无需等每日合成）。
- **暂停 vs 重置**（关闭记忆时二选一）：
  - **Pause memory**：保留既有记忆（含已开启的敏感话题），但不用也不新建；暂停期间对话不会在恢复后补入记忆；恢复后记忆与敏感话题记忆均回到开启。
  - **Reset memory**：**永久删除全部记忆（含项目记忆），不可撤销**；重新启用从零开始。
- **单聊关闭**：新聊天「+」菜单关 Memory（须在发首条消息前设置，开始后不可改）；该聊天不用记忆、不存记忆、不被其他聊天搜索到，但**仍留在聊天历史**（区别于 incognito）。项目内同理；语音模式需先关记忆再开语音。
- **搜索开关**：Settings → Your Claude 的「Search and reference chats」开关（也控制 Duet 能否搜索历史）。
- **导入/导出**（实验性）：可从其他 AI 导入记忆、导出 Claude 记忆备份/迁移；详见 2.9。
- **组织级**（Team/Enterprise Owner）：Organization settings → Capabilities 开关；关闭后全员停用且不能自开，但**不删除既有记忆条目**（重开可再用），关闭期间用户不能在设置查看/删除条目。Owner 不能替单个用户开启，也不能查看/编辑用户个体记忆。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)、[Bringing memory to Claude](https://claude.com/resources/articles/memory)。

### 2.5 作用域（账号、项目、会话） ✅

- **账号级**：Free/Pro/Max/Ultra 默认开启记忆（web/Desktop/Mobile）；Team/Enterprise 由 Owner 控制可用性。
- **项目级**：每项目独立记忆；可选「Use account memory」决定是否与账号记忆互通；项目删除则项目记忆删除。
- **会话级**：Incognito chat（全体计划，不存历史不存记忆）、单聊 Memory off（留历史但不参与记忆）。
- **跨产品**：云端 Cowork 与 Chat 共享；本地 Cowork 不用；Duet 使用/写入。
- **组织默认值分界**：2026-10-31（PT）起新建组织默认成员开启；旧组织默认关；HIPAA、政府平台、Claude for Teachers 组织不默认开启。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.6 冲突与更新策略 ✅

- 新体验**实时更新** topic（聊天中即写），用户编辑/删除即时作用于后续对话。
- legacy 每 24 小时合成；对话创建/修改/删除后 24 小时内更新记忆。
- 用户可在聊天或 Manage 面板直接改写 topic；「Fix something in one topic and the change applies to every conversation from then on」。
- 敏感条目：拒绝提示或关闭敏感开关会移除已存敏感条目。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.7 遗忘与衰减 ✅

- **新体验**：删除对话（含保留期到期）**不会**移除由其生成的记忆条目，但用户可在记忆开启时删除单条记忆。
- **自定义保留期衰减**（新统一 Claude 体验开启的组织）：若组织设置了覆盖聊天的自定义数据保留期，该保留期**也适用于记忆（项目记忆除外）**——**超过该期限未更新的记忆条目会被删除**，条目的部分内容可被移除而其余保留；适用于设期前已存条目，记忆暂停期间仍适用。项目记忆随项目删除而删除。
- **legacy**：删除对话会从记忆合成中移除；24 小时内更新。
- **Incognito**：不贡献记忆、不在成员历史可见，但 Owner 可通过数据导出获取，受组织保留政策约束（为安全至少保留 30 天）。
- 信任与安全系统标记或法律要求的内容可能被保留。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)。

### 2.8 隐私设计 ✅

- **Incognito chat**：全体用户可用；不存记忆、不存历史；Team/Enterprise 下仍纳入标准数据导出与保留政策；Enterprise 用客户管理加密密钥（CMEK）时因内容加密而无法搜索历史。
- **敏感话题分层**：默认不存敏感话题（opt-in）；政府 ID/犯罪记录/金融账号/移民身份**永不保存**；Personal Finance 链接账户聊天不存不搜。
- **加密与合规**：记忆静态加密；HIPAA/公共部门协议组织不提供新记忆体验；自定义保留期组织需开启新统一体验才适用记忆保留。
- **审计与导出**（Enterprise）：记录 Owner 开关组织级记忆；记忆条目适用标准对话访问日志；**个体成员记忆编辑不记日志**；记忆纳入标准对话历史导出，关记忆不移除导出中的记忆，incognito 纳入组织导出。
- **安全测试**：博客称 rollout 前对敏感 wellbeing 话题与边缘案例做广泛安全测试（是否强化有害模式、过度迎合、绕过 safeguards），并据此调整记忆行为。

来源：[Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)、[Bringing memory to Claude](https://claude.com/resources/articles/memory)。

### 2.9 特色亮点

- **项目级记忆隔离**作为安全护栏（机密讨论与一般运营分离），且可选是否与账号记忆互通。
- **可编辑 memory summary / topic**：用户可精确查看并改写 Claude 记住的内容，编辑即时全局生效。
- **敏感话题默认排除 + 永不保存清单 + 逐条提示**：分层隐私默认值，opt-in 才存敏感，且每次存敏感都提示。
- **Pause vs Reset 二分**：暂停保留可恢复，重置永久清除，语义清晰。
- **聊天搜索 RAG + citations + tool call 可见**：检索过程透明、可回链、可删除源对话。
- **记忆导入/导出（实验性）**：官方提供跨 AI 迁移路径（含推荐导出 prompt），降低锁定。
- **按 topic 实时写入**（新体验）：比「对话后摘要」更即时。
- **自定义保留期驱动的记忆衰减**：把企业数据保留政策延伸到记忆（项目记忆除外），是少见的合规级衰减。

### 2.10 明显短板

- **删对话不删记忆**（新体验）：用户以为删聊天即遗忘，实则记忆条目仍在，需另行删除。
- **组织关闭记忆不删数据**：Owner 关闭后条目仍存、重开即用，且关闭期间用户无法查看/删除自己的条目。
- **个体记忆编辑无审计日志**（Enterprise）：合规追溯有盲区。
- **导入实验性、工作导向过滤**：官方明示导入可能不成功，且 Claude 偏工作上下文，可能不保留与工作无关的个人细节。
- **legacy 24 小时延迟**：少数组织仍用每日合成，实时性差。
- **Incognito 并非真「无痕」**：Team/Enterprise 下仍进数据导出、受保留政策约束（至少 30 天）。

---

## 3. Google Gemini

> ⚠️ **本节核实程度显著低于其他平台**。本调研环境中 `support.google.com`（≥9 次）与 `gemini.google.com` 的 `web_fetch` 均返回网络层错误；`blog.google` 文章正文为动态渲染，仅能核实标题。下列机制细节除标题/URL 外**多数标注「未能核实」**，仅给出官方链接供读者自查，不作为已证实结论。已核实的官方博客 RSS（[Gemini RSS](https://blog.google/products-and-platforms/products/gemini/rss/)）确认 blog.google 为 Gemini 官方博客，但当前 feed 仅含 2026-10/11 文章，不含记忆相关历史文章。

### 3.0 时间线（标题级核实，日期来自搜索索引）

| 时间 | 事件 | 状态 |
|---|---|---|
| 2025-08 | 官方博客 *Gemini adds Temporary Chats and new personalization features*：引入 Temporary Chats 与基于历史聊天的个性化（personal context） | 🟡 标题已核实；日期来自搜索索引；正文未能核实 |
| 2026-02-26 | 官方博客（加拿大）*Use past chats to get more personalized responses*（作者 Michael Siliski, Senior Director, PM, Gemini app）：向加拿大全体用户 rollout「参考历史聊天」设置 | 🟡 标题已核实；正文未能核实 |
| 2026-04-28 | 官方博客（英国/法国）*Gemini launches new personalisation features in the UK* 等：向英国/法国推出「Memories」设置 | 🟡 标题已核实；正文未能核实 |

来源：[Gemini adds Temporary Chats and new personalization features](https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/)、[Use past chats to get more personalized responses（CA）](https://blog.google/intl/en-ca/feed/use-past-chats-to-get-more-personalized-responses/)、[Gemini launches new personalisation features in the UK](https://blog.google/company-news/inside-google/around-the-globe/google-europe/united-kingdom/gemini-launches-new-personalisation-features-in-the-uk/)。

### 3.1 记忆模型与存储 ❌（未能核实）

官方帮助文章定位如下，但正文未能抓取，机制细节**未能核实**：
- [Save info and reference past chats in Gemini Apps（answer/16413516）](https://support.google.com/gemini/answer/16413516?hl=en)：标题表明含「保存信息」与「参考历史聊天」两类能力。
- [Save info & preferences in Gemini Apps（answer/15637730）](https://support.google.com/gemini/answer/15637730?hl=en)：标题表明为「Saved info / 偏好」手动保存能力。
- [Get personalized responses with memory of your past Gemini chats（answer/16598469）](https://support.google.com/gemini/answer/16598469?hl=en)：标题表明为「基于历史聊天记忆的个性化」。
- [Gemini Apps Privacy Hub（answer/13594961）](https://support.google.com/gemini/answer/13594961?hl=en)：隐私总览。

搜索索引线索（**未经正文核实，仅供自查**）：Saved info 早期面向 Gemini Advanced 付费用户、仅英文、不支持工作/学校账户、不支持 Gemini Live；「参考历史聊天/Memories」要求 18+、个人 Google 账户、Keep Activity 开启。这些限制是否仍为现行状态**未能核实**。

### 3.2 写入路径（自动 vs 手动） ❌（未能核实）

- 标题级：存在手动「Save info」（answer/15637730）与自动「从历史聊天学习」（answer/16598469、博客）两条路径。
- 自动提取的触发时机、是否需用户显式开启、敏感信息处理等细节**未能核实**。

### 3.3 检索与注入方式 ❌（未能核实）

- 标题级：可「ask Gemini to look at past chats before responding」（answer/16413516 标题）。
- 是否每回答检索、是否有类似 ChatGPT Sources / Claude citations 的溯源 UI，**未能核实**。

### 3.4 用户控制（查看、编辑、删除、暂停） ❌（未能核实）

- 搜索索引线索（**未经正文核实**）：Privacy Hub 提及「可查看、编辑、删除可用的 Memory summary」「删除某聊天以停止用其个性化」「Temporary Chat」。
- 是否有单条删除/全部清除/开关、Saved info 的增删改入口（搜索线索称 Settings → Saved info → Add），**未能核实**。

### 3.5 作用域（账号、项目、会话） ❌（未能核实）

- 标题/线索级：个人 Google 账户级；Temporary Chat 为会话级隔离；Gems（自定义助手）与记忆的关系——搜索线索（社区帖，非一手）称 Gems 暂无跨会话长期记忆、Personal Context 不适用于 Gems，**此点未能从官方一手来源核实**。
- 官方 Gems 文档未在本次抓取范围内取得正文，**未能核实**。

### 3.6 冲突与更新策略 ❌（未能核实）

- 无官方正文可证，**未能核实**。

### 3.7 遗忘与衰减 ❌（未能核实）

- 搜索索引线索（**未经正文核实**）：Privacy Hub 提及 Keep Activity 关闭时 Gemini Live 聊天最多存 72 小时；删除聊天可停止其个性化。记忆条目本身的保留/衰减策略**未能核实**。

### 3.8 隐私设计 ❌（未能核实）

- 标题级：Temporary Chats（2025-08 博客标题已核实）为隐私功能；Keep Activity 与 Gemini Apps Activity 管理为隐私控件（Privacy Hub 标题）。
- 训练用途、未成年人限制、工作/学校账户排除等细节**未能核实**。

### 3.9 特色亮点（仅标题级可证）

- 官方博客标题显示 Gemini 将「Temporary Chats」与「基于历史聊天的个性化」作为一组隐私+个性化更新推出（2025-08），并按地区（加拿大 2026-02、英国/法国 2026-04）逐步 rollout「Memories」设置。
- 其余亮点因正文未能核实，暂不列举。

### 3.10 明显短板（含调研层面）

- **官方一手来源在本环境不可达**：support.google.com / gemini.google.com 抓取失败、blog.google 正文动态渲染，导致本报告无法对 Gemini 记忆机制做一手核实——这本身提示 Gemini 官方文档的可抓取性/透明度弱于 OpenAI/Anthropic/Microsoft 的帮助中心。
- 机制层面的短板因未能核实，暂不臆断。

---

## 4. Microsoft Copilot（消费版 + Microsoft 365 工作版）

> Copilot 的「记忆」分两套语境：**消费版**（个人 Microsoft 账户，copilot.com / Windows / macOS / 移动 / Edge 侧栏）与 **Microsoft 365 Copilot / Copilot Chat**（工作/学校 Entra 账户）。两者控件命名不同（消费版「Personalization and memory」/「Saved memories」；工作版管理员侧「Enhanced personalization」）。2026-08-18 起消费版推出新版 App，官方帮助文档据此分为「旧版 App」与「新版 App（for individuals）」两套。

### 4.0 时间线 ✅

| 时间 | 事件 |
|---|---|
| 2025-04-04 | 微软 50 周年 + Copilot 发布会：消费版 Copilot 推出 Memory & Personalization（官方新闻室英文活动页 + 意大利新闻室稿） |
| 2026-08-18 | 消费版新版 Copilot App（web/desktop/mobile）上线；官方隐私文档分为旧版与「for individuals」新版 |
| 2026-09-25 | 官方博客 *Introducing the new Copilot with Home, Code and Autopilot*：Home（Chat+Cowork）、Code、Autopilot（持久主动个人 agent，有自己的 memory）；经 Frontier 计划 rollout |
| 2026-11-03 | Learn 管理文档 *Manage Copilot personalization and memory* 更新（仍标注 preview/Frontier） |

来源：[Microsoft 50th Anniversary + Copilot event](https://news.microsoft.com/april-2025-copilot-news/)、[Microsoft News Center Italy（2025-04-04）](https://news.microsoft.com/it-it/2025/04/04/microsoft-presenta-le-nuove-funzionalita-di-copilot-e-azure-ai-foundry-unai-ancora-piu-personale-e-proattiva/)、[Microsoft Copilot for individuals: overview](https://support.microsoft.com/en-us/privacy/microsoft-copilot/overview)、[Introducing the new Copilot with Home, Code and Autopilot](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)、[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)。

### 4.1 记忆模型与存储 ✅

- **三类记忆来源**（Learn 管理文档）：saved memories、从聊天历史推断的细节（inferred）、custom instructions。
- **工作版存储位置**：记忆存于**用户 Exchange 邮箱的隐藏文件夹**，因此遵循与其他邮箱数据相同的安全与合规策略（如 Customer Lockbox、静态加密）。eDiscovery/Graph 中记忆项类为 `IPM.Contact`，位于 `CopilotMemory` 文件夹。
- **消费版**：官方隐私文档描述「记住对话中的关键细节与偏好」（沟通风格、喜好话题、目标、重复任务）；新版 App 在 Settings → Personalization → Saved memories 管理。
- **工作版个性化数据面**（support）：Copilot Chat 对话与使用数据、Microsoft 365 工作数据、使用信号、profile 信息；**Work insights**（仅工作/学校账户，依计划）从邮件/Teams 聊天/会议转录等工作内容学习，并可用于邮件草稿的语气/措辞/结构模仿。
- **许可**：Copilot memory 对「有/无 Microsoft Copilot 许可」的 Copilot Chat 用户均可用（工作版）；个性化与记忆处于 **preview（Frontier 计划）**，管理员控制可用性。
- **Autopilot**（2026-09-25 博客）：持久主动 agent，在租户内有自己的 identity、memory、computer、workspace，基于 Microsoft IQ。

来源：[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)、[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[Microsoft Copilot for individuals: privacy controls](https://support.microsoft.com/en-us/privacy/microsoft-copilot/privacy-controls)、[Introducing the new Copilot](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)。

### 4.2 写入路径（自动 vs 手动、触发时机） ✅

- **自动 saved memories**：Copilot Memory 开启时自动从 Copilot Chat 对话保存关键信息；**默认开启**。当检测到值得记住的信息时，**会询问用户是否保存**（「it asks you if you would like to save」）。
- **手动**：在 Copilot Chat 直接说「Copilot, remember that I prefer Excel over PowerPoint for reporting」；保存后显示 **Memory updated** 提示。
- **聊天历史推断**：从既往对话推断「什么对你重要」，用于后续对话（动态）。
- **custom instructions**：用户一次性设置的常设偏好（角色、沟通风格、格式），自动应用于每个对话。
- **Work insights**（工作版）：从工作内容学习；可问「What do you know about me」获取摘要，并要求忘记某条 work insight。
- **不写入**：Temporary chat 不访问/不存储个性化信息、不进历史、不被后续引用。

来源：[Manage Copilot Memory in Microsoft Copilot](https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot)、[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[使用记忆和自定义指令个性化 Copilot（Learn Training）](https://learn.microsoft.com/zh-cn/training/modules/write-effective-prompts-do-more-prompting/3a-personalize-copilot-memory-instructions)。

### 4.3 检索与注入方式 ✅

- saved memories 成为生成回答的上下文；聊天历史推断与 work insights 共同个性化回答与推荐。
- 可问「What do you know about me」获取 Copilot 所用重要信息（含 work insights）的摘要。
- 邮件草稿场景：用已发邮件的写作模式（语气、措辞、组织方式）使草稿更像用户本人。
- 官方培训模块明确两条构建路径：saved memories（检测+提示保存 / 主动告知）与 chat history inference（从既往对话识别模式与偏好）。

来源：[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[使用记忆和自定义指令个性化 Copilot](https://learn.microsoft.com/zh-cn/training/modules/write-effective-prompts-do-more-prompting/3a-personalize-copilot-memory-instructions)。

### 4.4 用户控制（查看、编辑、删除、暂停） ✅

**工作版（M365 Copilot Chat）**：
- 入口：Copilot Chat → … Settings and more → Chat settings → Personalization → Saved memories → Manage saved memories。
- 单条删除（每条旁 Delete）/ **Delete all memories**；Saved memories 开关关闭**不自动删除**已存记忆。
- **彻底删除某信息需两步**：① 删 saved memory；② 关 Chat history 开关以删除聊天历史推断（工作账户开关可能为「Chat history & work insights」，会一并删 work insights 记忆）。
- **30 天恢复窗口**：删除后 30 天内重新打开 Chat history 开关，Copilot 会**恢复**已删的聊天历史（及 work content）记忆。
- 保留 Chat history 开启但不想用某条：可在聊天中要求不要用该信息个性化。
- custom instructions：Settings → Personalization 管理；关闭开关停止应用但不删除内容。

**消费版（旧版 App）**：
- 入口：profile → Memory → Personalization and memory（copilot.com / Windows / macOS / 移动 / Edge 侧栏）。
- 查看：问「What do you know about me?」；添加：「Remember that I like gardening」；删除单条：「Forget that I like science fiction movies」；全部删除：profile → Memory → **Delete all Memory**（不删聊天历史）。
- **关闭 Personalization and memory：Copilot 会忘记其对话记忆**（与 M365「关闭不删」不同）；仍可看历史聊天，但未来不再个性化；重开后开始记新细节。
- Microsoft usage data 开关：控制是否用 Bing/MSN/Edge 等数据个性化。

**消费版（新版 App，2026-08-18 起）**：
- Settings → Personalization → Saved memories 旁 Manage → 单条 Delete / **Delete all memories**；关 Saved memories 开关**不自动删除**已存记忆（需 Manage → Delete all memories）。
- **One shared experience** 开关：控制 Bing/Edge/MSN 跨产品共享体验（Copilot 聊天可个性化 Bing/MSN，反之亦然）。
- 聊天历史：单条删除（Chats → …More → Delete）；全部删除经 privacy dashboard。
- 广告个性化开关（Allow ads personalization）；Web search 开关；Edge 浏览数据导入（仅美国账户）。

**管理员（工作版）**：Enhanced personalization 默认开启，可经 Microsoft Graph（enhancedPersonalizationSetting）编程关闭；关闭后用户侧 Custom instructions / Saved memories / Chat history 控件显示为关且不能自开。

来源：[Manage Copilot Memory](https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot)、[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[Microsoft Copilot privacy controls（旧版）](https://support.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-privacy-controls)、[Microsoft Copilot for individuals: privacy controls（新版）](https://support.microsoft.com/en-us/privacy/microsoft-copilot/privacy-controls)、[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)。

### 4.5 作用域（账号、项目、会话） ✅

- **账号级**：消费版按个人 Microsoft 账户；工作版按 Entra 用户，记忆存于该用户 Exchange 邮箱。
- **跨产品（消费版）**：One shared experience 使 Copilot 与 Bing/Edge/MSN 互相个性化；Microsoft usage data 引入其他 Microsoft 产品数据。
- **会话级**：Temporary chat（工作版与消费版均有）不访问/不存记忆、不进历史；工作版 temporary chat 仍可能被组织保留政策保留、IT 管理员可在保留期内访问。
- **工作版组织级**：管理员 Enhanced personalization 控制全租户；preview/Frontier 阶段。
- **Autopilot**：租户内独立 identity/memory/workspace（2026-09-25 博客）。

来源：[Microsoft Copilot for individuals: privacy controls](https://support.microsoft.com/en-us/privacy/microsoft-copilot/privacy-controls)、[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)。

### 4.6 冲突与更新策略 ✅

- **saved memories 智能管理**：官方明确「Copilot manages your saved memories intelligently, merging related ones, updating outdated details, or removing ones when you ask」——自动合并相关、更新过时、按请求移除。
- **聊天历史细节动态**：Copilot 可能随学习「更新或丢弃较旧细节」（update or discard older details）。
- 用户可聊天内要求忘记某条 / 不用某信息个性化。

来源：[Manage Copilot Memory](https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot)、[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)。

### 4.7 遗忘与衰减 ✅

**工作版（Learn 管理文档）**：
- **Purview 保留策略/标签不适用于 Copilot memory**；无管理员控件强制记忆保留规则（例：聊天「3 个月删除」策略不会删记忆）。
- **saved memories**：保留至用户在 Settings → Personalization 显式删除；删聊天不删由其生成的 saved memory；关闭开关停止应用但不删除。
- **聊天历史细节**：动态；若用户删除了某信息最初被分享/引用的**所有**聊天，则该信息在聊天历史细节中的痕迹**7 天内**删除。
- **关闭 Chat history 控件**（管理员或用户级）：聊天历史细节**30 天后**删除。
- **DSR/eDiscovery**：管理员可经 Purview eDiscovery/Content Search + Graph Explorer 搜索/导出/删除记忆（`IPM.Contact` / `CopilotMemory`）；custom instructions 不可被 eDiscovery 发现（用户可手动导出）。
- **无审计日志**：记忆与个性化操作不产生 Purview 审计日志条目。
- 管理员**不能**限制加入记忆的信息类型。

**消费版（旧版 App）**：关闭 Personalization and memory 即「忘记对话记忆」；对话历史保留 18 个月，可单条/全部删除。

来源：[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)、[Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers)、[Microsoft Copilot privacy controls（旧版）](https://support.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-privacy-controls)。

### 4.8 隐私设计 ✅

- **工作版**：记忆随 Exchange 邮箱安全/合规策略（Customer Lockbox、静态加密）；temporary chat 仍可被管理员经 Purview 访问（与常规聊天一样）；preview/Frontier。
- **消费版训练**：旧版 App 可 opt-out 对话活动用于模型训练（Training on conversation activity / voice）；opt-out 不影响个性化（仍可记住近期对话）。新版 App 的 activity-history 文档另有说明（本次未抓取该子页正文）。
- **消费版广告**：无 M365 订阅者可能见广告；个性化广告**可能使用聊天历史、saved memories 及其他共享 Microsoft 数据**；可关 Allow ads personalization；**18 岁以下不展示个性化广告**（无论设置）。
- **未成年人**：消费版有「Copilot for young people」专门文档（本次未抓取正文）。
- **跨产品共享**：One shared experience 可关；Edge 浏览数据导入仅美国、需显式开启。
- **2025-04-04 发布稿**：强调用户通过专用 dashboard 完全控制可被记忆的信息，可完全关闭记忆功能。

来源：[Manage Copilot personalization and memory（Learn）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory)、[Microsoft Copilot privacy controls（旧版）](https://support.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-privacy-controls)、[Microsoft Copilot for individuals: privacy controls（新版）](https://support.microsoft.com/en-us/privacy/microsoft-copilot/privacy-controls)、[Microsoft News Center Italy（2025-04-04）](https://news.microsoft.com/it-it/2025/04/04/microsoft-presenta-le-nuove-funzionalita-di-copilot-e-azure-ai-foundry-unai-ancora-piu-personale-e-proattiva/)。

### 4.9 特色亮点

- **记忆入 Exchange 邮箱**（工作版）：复用企业既有安全/合规/eDiscovery 体系，记忆可被 DSR 流程搜索/导出/删除——企业治理友好。
- **saved memories 自动合并/更新/移除** + 聊天历史细节动态丢弃：显式的冲突与衰减语义。
- **检测即询问保存**：自动写入前给用户确认机会（区别于 ChatGPT 的静默自动保存）。
- **Work insights + 邮件风格模仿**：把记忆扩展到工作内容并落到具体产出（草稿像本人）。
- **明确的删除时间窗**：删源聊天后 7 天清痕迹、关控件后 30 天删推断、30 天内重开可恢复——语义可预期。
- **消费版跨产品共享可关**（One shared experience）+ 广告个性化独立开关 + 18 岁以下无个性化广告。

### 4.10 明显短板

- **Purview 保留策略不适用于记忆 + 无审计日志 + 管理员不能限制记忆内容类型**（工作版）：企业合规存在明显盲区，记忆成为保留策略的「法外之地」。
- **关闭≠删除（工作版/新版消费版）**：关 Saved memories 开关不删已存记忆，用户易误以为已遗忘；而旧版消费版关闭即忘记——**两套语义不一致**，跨版本心智混乱。
- **30 天恢复窗口**：删除后 30 天内重开 Chat history 会恢复已删推断，「删除」并非立即不可逆。
- **custom instructions 不可被 eDiscovery 发现**：DSR 覆盖不全。
- **广告可用记忆**（消费版）：个性化广告可能使用聊天历史与 saved memories，隐私敏感。
- **preview/Frontier + 逐步 rollout**：功能可见性因账户/租户而异，用户难以确知自己是否启用。
- **temporary chat 仍可被管理员访问**（工作版）：并非对组织「无痕」。

---

## 5. 精华：值得借鉴的机制

> 说明「为什么好」+「实现代价直觉」（低/中/高，指相对工程复杂度，非精确估算）。

1. **分层记忆模型：显式条目 + 自动演化摘要 + 无上限历史引用**（ChatGPT）
   - 为什么好：把「用户可控的确定事实」与「系统自动理解的模糊偏好」分开，兼顾可控性与「懂你」；历史引用无存储上限避免硬容量焦虑。
   - 代价直觉：高。需多套存储/检索/更新管线与一致性维护，以及双轨 UI。

2. **Sources / citations 可溯源 + 可操作**（ChatGPT Sources、Claude past-chat citations）
   - 为什么好：把「哪条记忆/哪段聊天/哪个文件」暴露给用户，并支持纠正/删除/标记不相关，建立信任、便于纠错，是记忆透明化的关键。
   - 代价直觉：中。需在检索时记录 provenance 并渲染可操作 UI；删除/纠正需回写存储。

3. **可编辑的 memory summary / topic，编辑即时全局生效**（Claude、ChatGPT memory summary）
   - 为什么好：用户能精确改写模型「记住的自己」，比只能删除更细粒度；即时生效避免等待合成。
   - 代价直觉：中。需结构化记忆表示 + 编辑回写 + 注入一致性。

4. **项目级记忆隔离 + 可选账号互通**（Claude project memory、ChatGPT Project-only memory）
   - 为什么好：以项目为安全边界，机密与一般运营分离；可选互通兼顾灵活。是「作用域即护栏」的范例。
   - 代价直觉：中。需作用域标签 + 检索过滤 + 共享/隔离开关。

5. **敏感话题默认排除 + 永不保存清单 + 逐条 opt-in 提示**（Claude）
   - 为什么好：隐私默认值保守（健康/种族/宗教/政治等默认不存），政府 ID/金融账号等永不存，opt-in 后每次存敏感都提示——分层、可预期、可审计。
   - 代价直觉：中。需敏感分类器 + 策略层 + 提示 UI + 关闭时清除已存敏感。

6. **Pause vs Reset 二分 + 单聊记忆开关**（Claude）
   - 为什么好：暂停（保留可恢复）与重置（永久清除）语义清晰；单聊 off 提供会话级隔离且留历史，区别于 incognito。控制粒度细且语义不混淆。
   - 代价直觉：低-中。主要是状态机与 UI 语义设计。

7. **检测即询问保存 + Memory updated 提示**（Copilot）
   - 为什么好：自动写入前给用户确认机会，比静默自动保存更尊重用户；保存提示提供即时反馈。
   - 代价直觉：低-中。需价值检测 + 确认交互 + 提示。

8. **记忆复用企业合规体系（Exchange 邮箱 + eDiscovery/DSR）**（Copilot 工作版）
   - 为什么好：记忆不另起炉灶，直接继承邮箱安全/合规/搜索/导出/删除能力，企业治理成本低、可审计可 DSR。
   - 代价直觉：中（若已有 Exchange/Purview 体系则偏低）。需把记忆建模为邮箱项并接入既有管线。

9. **明确的删除/衰减时间窗 + 自动合并更新**（Copilot：7 天清痕迹、30 天删推断、智能合并/更新/丢弃；Claude：自定义保留期驱动记忆衰减）
   - 为什么好：遗忘语义可预期（何时清、何时删、能否恢复），自动合并/更新避免记忆膨胀与过时。
   - 代价直觉：中。需定时清理任务 + 版本/合并逻辑 + 保留期联动。

10. **记忆导入/导出（跨 AI 迁移）**（Claude，实验性）
    - 为什么好：降低用户锁定、支持备份与迁移，官方甚至给出推荐导出 prompt；是「用户拥有自己记忆」的体现。
    - 代价直觉：中。需导入解析/抽取 + 导出序列化 + 工作导向过滤；实验性说明可靠性仍在打磨。

11. **Temporary/Incognito 会话级隔离 + 可选是否用既有记忆**（ChatGPT temporary chat 可选个性化、Claude incognito、Copilot temporary chat）
    - 为什么好：给用户「这次别记/别用」的即时出口；ChatGPT 进一步允许临时聊天选择是否使用既有记忆，粒度更细。
    - 代价直觉：低-中。需会话级标志 + 读写隔离；注意企业保留例外要明示。

12. **按 topic 实时写入（而非对话后摘要）**（Claude 新体验）
    - 为什么好：「deadline 改了下一段对话就知道」，实时性优于 24 小时合成；topic 结构便于查看/编辑/删除。
    - 代价直觉：中。需流式抽取 + topic 归并 + 实时一致性。

---

## 6. 糟粕：应避免的设计

1. **静默自动记忆敏感信息**（ChatGPT 官方承认敏感信息可能不经要求被保存）
   - 为什么差：用户在不知情下把健康/政治等敏感细节落库，事后清理成本高、信任受损。应默认排除敏感（如 Claude）或至少写入前提示（如 Copilot）。

2. **「删除」语义不一致 / 关闭≠删除**（Copilot 工作版与新版消费版关开关不删；旧版消费版关即忘记；ChatGPT 删聊天≠删 saved memory）
   - 为什么差：用户以为「关了/删了就忘了」，实则数据仍在，跨版本/跨平台语义混乱，造成隐私误判。应统一「关闭」「删除」「暂停」语义并明示。

3. **彻底遗忘需跨多源手动清理 + 传播延迟 + 日志保留**（ChatGPT 需清 summary/saved memories/常规与归档聊天/文件/连接应用，传播需时，日志留 30 天）
   - 为什么差：「被遗忘权」落地成本极高，普通用户几乎无法真正彻底删除。应提供一键级联删除并明示残留与延迟。

4. **记忆成为企业保留策略/审计的盲区**（Copilot 工作版：Purview 保留策略不适用、无审计日志、管理员不能限制记忆内容类型、custom instructions 不可 eDiscovery）
   - 为什么差：记忆绕过企业合规体系，形成数据治理漏洞，DSR/审计覆盖不全。应让记忆继承保留/审计/内容策略。

5. **删除后可被恢复的窗口**（Copilot 30 天内重开 Chat history 恢复已删推断）
   - 为什么差：「删除」并非不可逆，用户预期与系统行为不符，敏感场景风险高。应明示恢复窗口或提供真正不可逆删除。

6. **summary / Sources 非全量，用户无法确知记住了什么**（ChatGPT memory summary 与 Sources 都「不一定含全部」）
   - 为什么差：透明化不彻底，用户难以审计自己的完整画像，纠错无从下手。应提供完整可导出视图（如 Claude「verbatim 导出」）。

7. **组织关闭记忆不删数据 + 关闭期间用户不能查看/删除自己的条目**（Claude）
   - 为什么差：管理员一关，用户既不能用也不能清理自己的记忆，数据悬置且用户失去控制权。应允许关闭期间仍可查看/删除。

8. **个性化广告使用聊天历史与 saved memories**（Copilot 消费版）
   - 为什么差：把私密记忆用于广告定向，隐私敏感、用户反感；即便可关，默认关联即有风险。应将记忆与广告定向解耦。

9. **Incognito/Temporary 并非真无痕（企业可导出/保留）**（Claude incognito 进组织导出至少 30 天；Copilot temporary chat 管理员可访问）
   - 为什么差：「无痕」命名误导用户以为对组织也不可见，实则不然。应明确命名与告知企业保留例外。

10. **体验碎片化、控件随计划/地区/平台/版本剧烈差异**（ChatGPT improved/legacy 双轨、控件因账户而异；Copilot 新旧 App 两套语义；Gemini 分地区 rollout）
    - 为什么差：用户心智负担重、文档与实际不符、支持成本高。应统一核心语义并清晰标注差异。

11. **官方文档可抓取性/透明度弱**（Gemini：support.google.com 与 gemini.google.com 在本环境不可达、blog.google 正文动态渲染）
    - 为什么差：一手核实困难，用户与研究者难以确认机制细节，透明度落后于 OpenAI/Anthropic/Microsoft 的静态帮助中心。应提供可静态抓取、版本明确的官方文档。

---

## 附录 A：来源清单与核实状态

### OpenAI（官方）
- ✅ [Memory in ChatGPT（Help Center, 8590148）](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) — 现行机制主来源，约 2026-11 初更新。
- ✅ [ChatGPT release notes（6825453）](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) — 2026-07~11 条目；2026-01-15、2026-05-05 等较早条目经同一官方文章的官方本地化版本（[lv-lv](https://help.openai.com/lv-lv/articles/6825453-chatgpt-release-notes)、[kk-cyrl](https://help.openai.com/kk-cyrl/articles/6825453-chatgpt-release-notes)）核实。
- 🟡 [Dreaming: Better memory for a more helpful ChatGPT（2026-06-04）](https://openai.com/index/chatgpt-memory-dreaming/) — 标题/日期/副标题已核实；正文动态渲染未能抓取（含 [zh-Hans-CN 版](https://openai.com/zh-Hans-CN/index/chatgpt-memory-dreaming/) 亦仅得壳）。
- 🟡 [Memory and new controls for ChatGPT（2024-02-13）](https://openai.com/index/memory-and-new-controls-for-chatgpt/) — 标题/日期已核实；正文未能抓取。
- ❌ 2025-04 reference chat history 公告、2025-06-03 免费用户记忆更新：官方带日期公告原文未能抓取（机制见现行 FAQ）。

### Anthropic / Claude（官方）
- ✅ [Bringing memory to Claude](https://claude.com/resources/articles/memory) — 由 [anthropic.com/news/memory](https://www.anthropic.com/news/memory) 重定向至 claude.com 官方域；2025-09-11 + 2025-10-23 更新 + 2026-10-30 编者注。
- ✅ [Use Claude's chat search and memory to build on previous context（11817273）](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) — 「本周更新」（2026-11），含新/legacy 体验、组织控制、保留与合规。
- ✅ [Import and export your memory from Claude（12123587）](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude) — 导入/导出流程（实验性）。

### Google Gemini（官方）
- 🟡 [Gemini adds Temporary Chats and new personalization features](https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/) — 标题已核实，正文未能核实。
- 🟡 [Use past chats to get more personalized responses（CA, 2026-02-26）](https://blog.google/intl/en-ca/feed/use-past-chats-to-get-more-personalized-responses/) — 标题已核实，正文未能核实。
- 🟡 [Gemini launches new personalisation features in the UK（2026-04-28）](https://blog.google/company-news/inside-google/around-the-globe/google-europe/united-kingdom/gemini-launches-new-personalisation-features-in-the-uk/) — 标题级；抓取失败。
- ✅ [Gemini 官方博客 RSS](https://blog.google/products-and-platforms/products/gemini/rss/) — 确认官方博客；当前 feed 仅 2026-10/11。
- ❌ [Save info and reference past chats（16413516）](https://support.google.com/gemini/answer/16413516?hl=en)、[Save info & preferences（15637730）](https://support.google.com/gemini/answer/15637730?hl=en)、[Memory of past chats（16598469）](https://support.google.com/gemini/answer/16598469?hl=en)、[Gemini Apps Privacy Hub（13594961）](https://support.google.com/gemini/answer/13594961?hl=en) — 本环境多次抓取失败，正文未能核实。

### Microsoft（官方）
- ✅ [Manage Copilot personalization and memory（Learn, 2026-11-03 更新）](https://learn.microsoft.com/en-us/copilot/manage/copilot-personalization-memory) — 管理员/存储/保留/合规主来源（由 /microsoft-365/copilot/ 路径重定向）。
- ✅ [Personalize what Microsoft Copilot remembers](https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers) — 用户侧机制、work insights、两步删除、30 天恢复。
- ✅ [Manage Copilot Memory in Microsoft Copilot](https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot) — 保存/删除/智能合并。
- ✅ [Microsoft Copilot privacy controls（旧版 App）](https://support.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-privacy-controls) — 消费版旧版控制、18 个月保留、训练 opt-out。
- ✅ [Microsoft Copilot for individuals: overview（新版 App）](https://support.microsoft.com/en-us/privacy/microsoft-copilot/overview)、[privacy controls（新版 App）](https://support.microsoft.com/en-us/privacy/microsoft-copilot/privacy-controls) — 2026-08-18 起新版消费版控制。
- ✅ [使用记忆和自定义指令个性化 Copilot（Learn Training, zh-cn）](https://learn.microsoft.com/zh-cn/training/modules/write-effective-prompts-do-more-prompting/3a-personalize-copilot-memory-instructions) — 两条记忆路径、临时聊天。
- ✅ [Microsoft 50th Anniversary + Copilot event（2025-04）](https://news.microsoft.com/april-2025-copilot-news/)、[Microsoft News Center Italy（2025-04-04）](https://news.microsoft.com/it-it/2025/04/04/microsoft-presenta-le-nuove-funzionalita-di-copilot-e-azure-ai-foundry-unai-ancora-piu-personale-e-proattiva/) — 消费版 Memory & Personalization 发布。
- ✅ [Introducing the new Copilot with Home, Code and Autopilot（2026-09-25）](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/) — 新 Copilot、Autopilot 自有 memory。

## 附录 B：调研局限

1. **Gemini 一手核实不足**：support.google.com / gemini.google.com 在本环境网络层不可达，blog.google 正文动态渲染，故 Gemini 机制细节多标「未能核实」。建议后续在可直连 Google 域名的环境复核 answer/16413516、15637730、16598469、13594961 及 2025-08 / 2026-02 / 2026-04 博客正文。
2. **OpenAI 博客正文级细节**：Dreaming（2026-06-04）与 2024-02-13 公告正文动态渲染未能抓取，相关量化说法（算力降 5 倍、召回率/偏好遵从度提升、新加坡时态修订示例）仅见于搜索索引，**未作为已核实结论写入正文**，仅在 1.6 标注。
3. **2025 年 OpenAI 时间线**：reference chat history（2025-04）与免费用户记忆（2025-06-03）的官方带日期公告原文未能抓取，机制以现行 FAQ 为准。
4. **动态 rollout**：各平台功能随计划/地区/平台/租户/版本差异大且持续变化，本报告为 2026-11-13 快照，具体控件以用户账户实际可见为准。
