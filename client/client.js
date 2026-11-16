/**
 * dsh-memory 浏览器客户端 —— 手写 classic script，无构建步骤。
 * 纯逻辑函数经 UMD 尾部导出供 node 单测（缝 4）；浏览器侧注册惰性 factory。
 * 与 dsh-reverse-proxy-connect 同一产物形态：window.__ModuleLoader__.load。
 *
 * 面板：layout main keyed 槽（key=dsh-memory）+ sidebar.panellist 导航。
 * 数据面：同源 fetch /plugins/dsh-memory/*（进程级 token，写操作带 X-RPC-Key）。
 *
 * 视觉语言：扁平克制、跟随宿主明暗主题。分类三色（偏好琥珀/事实湛蓝/决策翡翠）＋
 * 玫红警示仅作功能识别；纯色主色、细边框卡片、无渐变/氛围光/装饰徽章/入场级联动画。
 * 颜色全部走 --dsw-alias-* 令牌 + 插件自有变量，深色分支跟随宿主
 * body[data-ds-dark-theme]；文案 ctx.locale（zh/en）。标题旁显示 /status.version。
 */
(function (global) {
  'use strict'

  // ===== 纯逻辑（node 可测，缝 4） =====

  // 标签上限与单项长度（与宿主 lib/store.js cleanTags 同口径）。
  var TAG_MAX_COUNT = 12
  var TAG_MAX_LENGTH = 64

  // 标签解析（纯函数）：中英文逗号分隔、trim、去重、单项截 64 字符、最多 12 个。
  // 与宿主 store.cleanTags 同口径，客户端提前收敛，避免「提示已保存、服务端却静默截断」。
  function parseTags(text) {
    // 无原型对象：标签名可能恰好是 constructor/toString/__proto__，普通对象去重会
    // 把这类标签静默丢弃（与宿主 Set 口径分叉，客户端少存数据）。
    var seen = Object.create(null)
    var out = []
    var parts = String(text || '').split(/[,，]/)
    for (var i = 0; i < parts.length; i++) {
      var tag = parts[i].trim().slice(0, TAG_MAX_LENGTH)
      if (!tag || seen[tag]) continue
      seen[tag] = true
      out.push(tag)
      if (out.length >= TAG_MAX_COUNT) break
    }
    return out
  }

  function validateDraft(draft) {
    var content = String((draft && draft.content) || '').trim()
    if (content === '') return { ok: false, error: 'empty-content' }
    var category = (draft && draft.category) || 'fact'
    if (['preference', 'fact', 'decision'].indexOf(category) === -1) return { ok: false, error: 'bad-category' }
    var expires = draft && draft.expires
    if (expires !== undefined && expires !== null && expires !== '' && !isExpiresDate(expires)) return { ok: false, error: 'bad-expires' }
    // 过去日期会让条目保存后立刻隐藏（「已保存」吐司 + 默认列表看不到 = 误以为丢数据）。
    // 新建可直接拒绝；编辑只在用户真的改成过去日期时拒绝（保留既有过期条目的原值可继续编辑）。
    if (expires && isExpiresDate(expires) && expires < todayUtcIso()) {
      var unchanged = draft && draft.mode === 'edit' && expires === draft.expiresOriginal
      if (!unchanged) return { ok: false, error: 'expires-past' }
    }
    return { ok: true }
  }

  /** 当前 UTC 日期（YYYY-MM-DD）：与宿主 isExpired「按 UTC 日、当日含」口径一致。 */
  function todayUtcIso(now) {
    var d = new Date(typeof now === 'number' ? now : Date.now())
    if (isNaN(d.getTime())) return ''
    var mm = d.getUTCMonth() + 1
    var dd = d.getUTCDate()
    return d.getUTCFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd
  }

  /** 本地日期戳（导出文件名用）：UTC ISO 在 UTC+8 的凌晨会显示「昨天」。 */
  function localDateStamp(now) {
    var d = new Date(typeof now === 'number' ? now : Date.now())
    if (isNaN(d.getTime())) return ''
    var mm = d.getMonth() + 1
    var dd = d.getDate()
    return d.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd
  }

  /** 客户端运行平台是否 Windows（路径比较大小写不敏感）。 */
  function platformIsWindows() {
    try {
      if (typeof navigator === 'undefined' || !navigator.userAgent) {
        return typeof process !== 'undefined' && process.platform === 'win32'
      }
      var ua = String(navigator.userAgent || '')
      if (/Windows/i.test(ua)) return true
      var platform = navigator.userAgentData && navigator.userAgentData.platform
      return /Windows/i.test(String(platform || navigator.platform || ''))
    } catch { return false }
  }

  /** 面板「新建记忆」请求体（纯函数）：只带用户真正设置的字段——宿主去重命中时会
   *  应用显式字段，把表单默认值（category=fact / tags=[] / pinned=false / origin=manual）
   *  当显式字段发送会静默改写既有条目的分类/标签/钉选（第十轮审计 C2）。 */
  function buildCreatePayload(editor, tags, workspaceTarget) {
    var draft = editor || {}
    var scope = draft.scope === 'global' ? 'global' : 'workspace'
    var payload = {
      content: String(draft.content || '').trim(),
      scope: scope,
    }
    if (scope === 'workspace' && workspaceTarget) payload.workspace = workspaceTarget
    if (draft.category && draft.category !== 'fact') payload.category = draft.category
    var list = Array.isArray(tags) ? tags : []
    if (list.length > 0) payload.tags = list
    if (draft.pinned) payload.pinned = true
    if (draft.expires) payload.expires = draft.expires
    return payload
  }

  /** 页码夹取（纯函数）：总数变小/删末页后一次跳到有效末页，而不是逐页回退。 */
  function clampPageToTotal(page, total, pageSize) {
    var size = Math.max(1, Math.floor(Number(pageSize) || 1))
    var count = Number(total) || 0
    var lastPage = Math.max(0, Math.ceil(count / size) - 1)
    return Math.max(0, Math.min(Number(page) || 0, lastPage))
  }

  /**
   * 路径比较键（纯函数）：/workspaces 索引里的 cwd 经宿主 normalizeCwd（Windows 小写），
   * /cwd 返回会话原始大小写；逐字符比较会让「● 当前工作区」永不命中。Windows 忽略
   * 大小写，其他平台保持敏感（避免把 /home/A 与 /home/a 误并）。
   */
  function cwdCompareKey(cwd, caseInsensitive) {
    var s = String(cwd == null ? '' : cwd)
    var ci = caseInsensitive === undefined ? platformIsWindows() : !!caseInsensitive
    return ci ? s.toLowerCase() : s
  }

  // 过期日必须是真实日历日期（YYYY-MM-DD）；坏日期一律 fail-open，不视为过期。
  function isExpiresDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    var d = new Date(value + 'T00:00:00Z')
    if (isNaN(d.getTime())) return false
    return d.getUTCFullYear() === Number(value.slice(0, 4)) && d.getUTCMonth() + 1 === Number(value.slice(5, 7)) && d.getUTCDate() === Number(value.slice(8, 10))
  }

  // 到期判定按 UTC、当日含（expires=今天仍有效）；now 为毫秒时间戳，缺省当前时间。
  function isExpired(expires, now) {
    if (!isExpiresDate(expires)) return false
    var d = new Date(typeof now === 'number' ? now : Date.now())
    if (isNaN(d.getTime())) return false
    var mm = d.getUTCMonth() + 1
    var dd = d.getUTCDate()
    var today = d.getUTCFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd
    return expires < today
  }

  // 单一状态标签优先级：被取代 > 已过期 > 已归档 > 活跃（pinned 与状态正交）。
  function statusOf(entry, now) {
    var e = entry || {}
    if (e.superseded_by) return 'superseded'
    if (isExpired(e.expires, now)) return 'expired'
    if (e.archived) return 'archived'
    return 'active'
  }

  function originOf(entry) {
    return entry && entry.origin === 'auto' ? 'auto' : 'manual'
  }

  // 查看任一隐藏态（被取代/已过期/已归档/已钉选/全部）时放宽全部 include_*：
  // 服务端先过隐藏门再做 status 后置过滤，只放宽自身会让「同时被取代＋归档」
  // 等组合态条目被别的隐藏门挡掉；active 不需要任何放宽参数。
  function statusQueryFlags(status) {
    if (!status || status === 'active') return {}
    return { include_superseded: true, include_expired: true, include_archived: true }
  }

  function groupEntries(entries) {
    var groups = { global: [], workspace: [] }
    var list = Array.isArray(entries) ? entries : []
    for (var i = 0; i < list.length; i++) {
      var entry = list[i]
      if (entry && entry.scope === 'global') groups.global.push(entry)
      else groups.workspace.push(entry)
    }
    return groups
  }

  function nextToken(current, response) {
    var payload = response && response.payload
    if (payload && typeof payload.key === 'string' && payload.key !== '') return payload.key
    if (response && response.status === 403) return ''
    return current || ''
  }

  // 面板列表请求参数（纯函数）：作用域＋过滤条件＋隐藏态放宽标志＋分页。
  // origin/tag/status 必须随请求上行，否则服务端过滤不会生效（见 0.24.1 修复）。
  function entriesParams(filters) {
    var f = filters || {}
    var params = { scope: f.scope || 'all' }
    if (f.workspace) params.workspace = f.workspace
    if (f.query) params.query = f.query
    if (f.category) params.category = f.category
    if (f.origin) params.origin = f.origin
    if (f.tag) params.tag = f.tag
    if (f.status) params.status = f.status
    var flags = statusQueryFlags(f.status)
    for (var key in flags) if (Object.prototype.hasOwnProperty.call(flags, key)) params[key] = flags[key]
    if (f.limit) params.limit = f.limit
    if (f.offset) params.offset = f.offset
    return params
  }

  function buildEntriesQuery(params) {
    var p = params || {}
    var parts = ['scope=' + encodeURIComponent(p.scope || 'all')]
    if (p.workspace) parts.push('workspace=' + encodeURIComponent(p.workspace))
    if (p.query) parts.push('query=' + encodeURIComponent(p.query))
    if (p.category) parts.push('category=' + encodeURIComponent(p.category))
    if (p.origin) parts.push('origin=' + encodeURIComponent(p.origin))
    if (p.tag) parts.push('tag=' + encodeURIComponent(p.tag))
    if (p.status) parts.push('status=' + encodeURIComponent(p.status))
    if (p.include_superseded) parts.push('include_superseded=true')
    if (p.include_expired) parts.push('include_expired=true')
    if (p.include_archived) parts.push('include_archived=true')
    if (p.limit) parts.push('limit=' + encodeURIComponent(String(p.limit)))
    if (p.offset) parts.push('offset=' + encodeURIComponent(String(p.offset)))
    return '?' + parts.join('&')
  }

  function workspaceOptions(input) {
    var workspaces = (input && input.workspaces) || []
    var currentCwd = input && input.currentCwd
    var ci = input && input.caseInsensitive !== undefined ? !!input.caseInsensitive : platformIsWindows()
    var options = [{ value: 'global', kind: 'global' }]
    // 无原型：路径经比较键归一后仍可能撞上 __proto__ 这类键（防御性，与 id 集合同口径）。
    var seen = Object.create(null)
    for (var i = 0; i < workspaces.length; i++) {
      var ws = workspaces[i]
      if (!ws || typeof ws.cwd !== 'string' || ws.cwd === '') continue
      var key = cwdCompareKey(ws.cwd, ci)
      if (seen[key]) continue
      seen[key] = true
      options.push({ value: ws.cwd, kind: 'workspace', count: ws.count || 0 })
    }
    if (typeof currentCwd === 'string' && currentCwd !== '' && !seen[cwdCompareKey(currentCwd, ci)]) {
      options.push({ value: currentCwd, kind: 'workspace', count: 0 })
    }
    return options
  }

  /** 把任意大小写的 cwd 映射回选项里的规范 value（Windows 上 /workspaces 下发小写路径）。 */
  function canonicalWorkspaceValue(cwd, options, caseInsensitive) {
    if (!cwd) return cwd
    var list = Array.isArray(options) ? options : []
    var ci = caseInsensitive === undefined ? platformIsWindows() : !!caseInsensitive
    var key = cwdCompareKey(cwd, ci)
    for (var i = 0; i < list.length; i++) {
      var opt = list[i]
      if (!opt || opt.kind !== 'workspace' || typeof opt.value !== 'string') continue
      if (cwdCompareKey(opt.value, ci) === key) return opt.value
    }
    return cwd
  }

  /** 导入拒绝项展示：已知错误码走本地化文案，未知才回退服务端双语 reason。 */
  function importRejectText(rejected, t) {
    var r = rejected || {}
    var key = errorKeyFor(r)
    if (key) {
      try { return t(key) } catch { /* fall through */ }
    }
    return String(r.reason || r.code || '')
  }

  function errorKeyFor(err) {
    if (!err) return null
    var code = err.code
    if (code === 'not-found') return 'errNotFound'
    if (code === 'secret') return 'errSecret'
    if (code === 'invalid') return 'errInvalid'
    if (code === 'no-workspace') return 'errNoWorkspace'
    if (code === 'duplicate') return 'errDuplicate'
    if (code === 'io') return 'errIo'
    if (code === 'busy') return 'errBusy'
    if (code === 'timeout') return 'errTimeout'
    if (code === 'network') return 'errNetwork'
    if (code === 'bad-response') return 'errBadResponse'
    var msg = err.message
    if (msg === 'unauthorized') return 'errUnauthorized'
    if (msg === 'loopback-only') return 'errLoopback'
    if (msg === 'invalid-json') return 'errInvalidJson'
    if (msg === 'body-too-large') return 'errBodyTooLarge'
    // 未知异常在宿主端统一为 internal（不回传本机路径/Node 原始错误）。
    if (msg === 'internal') return 'errInternal'
    if (msg === 'timeout') return 'errTimeout'
    if (msg === 'bad-response') return 'errBadResponse'
    if (err.status === 403) return 'errUnauthorized'
    return null
  }

  // 撤销吐司优先：当前 toast 带撤销动作且未到期时，普通提示排队稍后展示，
  // 避免删除后 6 秒内任意其它操作把「撤销」挤掉（删除不可逆）。
  function shouldQueueToast(current, incoming, now) {
    if (!current || !incoming) return false
    if (!current.action || incoming.action) return false
    var until = Number(current.until)
    return !isFinite(until) || now < until
  }

  // 吐司倒计时剩余（纯函数）：total 为本段起始剩余预算，started 为段起点；
  // pausedAt 非空表示已暂停，elapsed 冻结在 pausedAt（重复暂停同一 pausedAt 结果
  // 不变，不会重复扣减）；未暂停按 now 扣减。下限 300ms，避免恢复后立即消失。
  function toastRemainingMs(started, pausedAt, now, total) {
    var budget = Number(total)
    if (!isFinite(budget)) budget = 0
    var ref = (pausedAt === null || pausedAt === undefined) ? now : pausedAt
    var elapsed = Math.max(0, Number(ref) - Number(started))
    return Math.max(300, budget - elapsed)
  }

  // 吐司恢复判定（纯函数）：确实处于暂停、且焦点已离开吐司才恢复倒计时——
  // 鼠标移出但键盘焦点仍在撤销按钮上时不得恢复（否则吐司在键盘用户眼前消失）。
  function shouldResumeToast(paused, focusInside) {
    return !!paused && !focusInside
  }

  // 批量删除结果归类（Promise.allSettled）：成功项可撤销、失败项汇报原因。
  function partitionSettled(items, settled) {
    var ok = []
    var failed = []
    var list = Array.isArray(items) ? items : []
    var results = Array.isArray(settled) ? settled : []
    for (var i = 0; i < list.length; i++) {
      var result = results[i]
      if (result && result.status === 'fulfilled') ok.push(list[i])
      else failed.push({ entry: list[i], error: result ? result.reason : undefined })
    }
    return { ok: ok, failed: failed }
  }

  // id 成员集合（纯函数）：ID_PATTERN 允许 __proto__/constructor 这类键，普通对象
  // 赋值会被原型 setter 吞掉（选择同步失效/批量删除误报/撤销集漏项），统一用无原型
  // 对象（与 parseTags 同口径）。
  function idSetOf(items) {
    var set = Object.create(null)
    var list = Array.isArray(items) ? items : []
    for (var i = 0; i < list.length; i++) {
      var item = list[i]
      if (item) set[item.id] = true
    }
    return set
  }

  // 批量删除结算（纯函数）：宿主返回 {deleted, ids, notFound, failed}——ids=已删除
  // （进撤销集），failed=文件被占用 unlink 失败 → busy，notFound → not-found，
  // 未归因项兜底 not-found。此前只读 ids、其余一律误报 not-found。
  function settleBulkDelete(targets, result) {
    var r = result || {}
    var deleted = Object.create(null)
    var busyIds = Object.create(null)
    var ids = Array.isArray(r.ids) ? r.ids : []
    var busyList = Array.isArray(r.failed) ? r.failed : []
    var i
    for (i = 0; i < ids.length; i++) deleted[ids[i]] = true
    for (i = 0; i < busyList.length; i++) busyIds[busyList[i]] = true
    var list = Array.isArray(targets) ? targets : []
    var ok = []
    var failed = []
    for (i = 0; i < list.length; i++) {
      var e = list[i]
      var id = e && e.id
      if (deleted[id] === true) ok.push(e)
      else if (busyIds[id] === true) failed.push({ item: e, error: { code: 'busy' } })
      else failed.push({ item: e, error: { code: 'not-found' } })
    }
    return { ok: ok, failed: failed }
  }

  // 写路由统一包 {result}：设置类接口取 result 里的设置视图（避免把包裹对象当视图导致崩溃）。
  function unwrapResult(payload) {
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result')) return payload.result
    return payload
  }

  // 设置写入状态机（纯函数）：保存/重置/备份共用一套状态，解决「在途保存与重置互相
// 回滚」「saving 卡在保存中」「保存失败无脏标记/重试」等问题。
// 事件：edit / save-start / save-ok / save-fail / save-settled / reset-start /
// reset-ok / reset-fail / load-ok。未知事件按状态机无变化处理。
function settingsStatusNext(status, event) {
  var base = status || { dirty: false, saving: false, savedOnce: false, error: '' }
  var next = { dirty: base.dirty, saving: base.saving, savedOnce: base.savedOnce, error: base.error }
  var type = event && event.type
  if (type === 'edit') { next.dirty = true; next.error = '' }
  else if (type === 'save-start') { next.saving = true; next.error = '' }
  else if (type === 'save-ok') { next.saving = false; next.dirty = false; next.savedOnce = true; next.error = '' }
  else if (type === 'save-fail') { next.saving = false; next.dirty = true; next.savedOnce = false; next.error = event.error || '' }
  else if (type === 'save-settled') { next.saving = false }
  else if (type === 'reset-start') { next.saving = false; next.dirty = false; next.savedOnce = false; next.error = '' }
  else if (type === 'reset-ok') { next.saving = false; next.dirty = false; next.savedOnce = true; next.error = '' }
  else if (type === 'reset-fail') { next.saving = false; next.savedOnce = false; next.error = event.error || '' }
  else if (type === 'load-ok') { if (!next.dirty) next.error = '' }
  return next
}

  // 保存结果提示键（纯函数）：复活优先于去重，其次相似提示，最后普通保存。
  function savedToastKey(result) {
    var r = result || {}
    if (r.revived) return 'revivedSaved'
    if (r.deduplicated) return 'deduplicated'
    var similar = r.similar || []
    if (similar.length > 0) return 'similarSaved'
    return 'saved'
  }

  // 大库导入分片：每片 ≤300 条（每次请求仍是原子批次），逐片顺序提交、显示进度。
// 这样单次请求不会冻结宿主事件循环数十秒，也不会撞上 180s 总超时；已写入的片重试时
// 由服务端内容去重/merge 幂等吸收。
  function chunkEntries(items, size) {
    var list = Array.isArray(items) ? items : []
    var n = Math.max(1, Math.floor(Number(size) || 1))
    var out = []
    for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
    return out
  }

  // 区块计数是否可信（纯函数）：只有「单页完整结果」时，页内分组条数才等于全量总数；
// 分页或筛选状态下列表只是子集，显示条数会与统计条数字矛盾。
  function sectionCountsExact(page, hasMore, filtered) {
    return Number(page) === 0 && !hasMore && !filtered
  }

  // 默认视图选择（纯函数）：「当前工作区」默认视图必须等 cwd 解析完成后再应用——
// 过早标记 initialized 会让晚到的 cwd 永久失效。resolved=false 表示还需等待。
// options 可选：把 currentCwd 映射回 /workspaces 的规范 value（Windows 大小写不同
// 时，否则 Select 匹配不到任何选项 → 空触发器）。
  function defaultViewSelection(settings, currentCwd, options, caseInsensitive) {
    if (!settings || !settings.effective) return { selection: null, resolved: false }
    var dv = settings.effective.defaultView
    if (dv === 'global') return { selection: 'global', resolved: true }
    if (dv === 'workspace') {
      if (!currentCwd) return { selection: null, resolved: false }
      return { selection: canonicalWorkspaceValue(currentCwd, options, caseInsensitive), resolved: true }
    }
    return { selection: null, resolved: true }
  }

  // 设置内容签名（纯函数）：召回刷新只依赖 effective 的内容而非对象引用——
  // 备份/重载会生成新 settings 对象，内容未变时不应触发全量 /recall-preview 重扫。
  function settingsSignature(settings) {
    if (!settings || !settings.effective) return ''
    try { return JSON.stringify(settings.effective) } catch { return '' }
  }

  // 外部写入刷新节流（纯函数）：窗口 focus/visibilitychange 距上次自动刷新
  // 满 minGap（默认 30s）才允许再次触发，避免频繁切窗打爆列表请求。
  function shouldAutoRefresh(lastAt, now, minGap) {
    var gap = Number(minGap) > 0 ? Number(minGap) : 30000
    var last = Number(lastAt)
    if (!isFinite(last) || last <= 0) return true
    return Number(now) - last >= gap
  }

  // 导入文件文本解析（纯函数）：容忍 UTF-8 BOM（记事本/部分编辑器保存会带），
// 并把「JSON 语法错误」与「不是导出文件」归因分开，便于用户纠正。
  function parseImportText(text) {
    var raw = String(text == null ? '' : text).replace(/^\uFEFF/, '')
    var doc
    try { doc = JSON.parse(raw) } catch { return { ok: false, errorKey: 'errImportJson' } }
    if (!validateImportDoc(doc).ok) return { ok: false, errorKey: 'errImportDoc' }
    return { ok: true, doc: doc }
  }

  // 导出参数（纯函数）：按当前视图导出——「全局＋当前工作区」不再静默导出全部工作区；
  // 当前工作目录未知时回退仅全局（与列表实际可见范围一致）。
  function exportParams(selection, currentCwd) {
    if (selection === 'global') return { scope: 'global' }
    if (selection === 'all' || selection === undefined || selection === null) {
      return currentCwd ? { scope: 'all', workspace: currentCwd } : { scope: 'global' }
    }
    return { scope: 'workspace', workspace: selection }
  }

  function validateImportDoc(doc) {
    if (!doc || typeof doc !== 'object') return { ok: false, error: 'bad-doc' }
    if (doc.format !== 'dsh-memory-export' || doc.version !== 1) return { ok: false, error: 'bad-doc' }
    if (!Array.isArray(doc.entries)) return { ok: false, error: 'bad-doc' }
    return { ok: true }
  }

  function importSummary(plan) {
    var p = plan || {}
    return {
      imported: Number(p.imported) || 0,
      updated: Number(p.updated) || 0,
      deduplicated: Number(p.deduplicated) || 0,
      repaired: Number(p.repaired) || 0,
      rejected: Array.isArray(p.rejected) ? p.rejected.length : 0,
    }
  }

  /**
   * 超过服务端单请求上限（hardMax）的连通分量按拓扑分层拆分：只放置「supersedes
   * 目标已全部落盘」的条目（Kahn），保证任何跨片指针都指向同片或更早的片——服务端
   * 对磁盘上的取代目标会物化反向指针（superseded_by），链语义跨片重建、不静默丢链。
   * 取代环无法分层时按原顺序倾倒（服务端本来就会修复并丢弃环指针）。
   */
  function splitLinkedComponentTopologically(items, cap) {
    var indexById = new Map()
    for (var i = 0; i < items.length; i++) indexById.set(String(items[i].id), i)
    var dep = []
    for (var j = 0; j < items.length; j++) {
      var target = items[j] && items[j].supersedes
      var idx = target === null || target === undefined ? undefined : indexById.get(String(target))
      dep.push(idx === undefined ? -1 : idx)
    }
    var placed = []
    var remaining = items.length
    var chunks = []
    var current = []
    function place(item) {
      current.push(item)
      if (current.length >= cap) { chunks.push(current); current = [] }
    }
    while (remaining > 0) {
      var progressed = false
      for (var k = 0; k < items.length; k++) {
        if (placed[k]) continue
        if (dep[k] !== -1 && !placed[dep[k]]) continue
        placed[k] = true
        remaining -= 1
        progressed = true
        place(items[k])
      }
      if (!progressed) {
        // 取代环：剩余条目按原顺序倾倒，绝不死循环。
        for (var m = 0; m < items.length; m++) {
          if (placed[m]) continue
          placed[m] = true
          remaining -= 1
          place(items[m])
        }
      }
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  /**
   * 分片导入分包（保留取代链）：把 id ↔ supersedes ↔ superseded_by 用并查集合并成
   * 连通分量，同一分量必须落在同一批——否则跨片的取代指针会被服务端按「不可达」
   * 修复丢弃，导致已取代的旧记忆重新变为活跃（静默数据损坏）。
   * 分量超过 size 时单独成批（内容完整优先于批大小）；但服务端单请求有硬上限
   * （lib/service.js MAX_IMPORT_ENTRIES=1000），超过 hardMax 的分量整批提交会被
   * 400 invalid 拒绝——大备份从此完全无法导入。因此分量 > hardMax 时改按拓扑
   * 分层拆分（supersedes 目标先落盘），跨片指针由服务端按磁盘状态重新物化。
   */
  function chunkEntriesPreservingLinks(entries, size, hardMax) {
    var list = Array.isArray(entries) ? entries : []
    var n = Math.max(1, Math.floor(Number(size) || 1))
    var cap = Math.max(n, Math.floor(Number(hardMax) || 1000))
    if (list.length === 0) return []
    if (list.length <= n) return [list]
    var parent = Object.create(null)
    var indexOf = Object.create(null)
    function find(x) {
      while (parent[x] !== undefined && parent[x] !== x) {
        parent[x] = parent[parent[x]]
        x = parent[x]
      }
      return x
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i]
      if (!e || !e.id) continue
      if (parent[e.id] === undefined) parent[e.id] = e.id
      indexOf[e.id] = i
    }
    for (var j = 0; j < list.length; j++) {
      var en = list[j]
      if (!en || !en.id) continue
      var links = [en.supersedes, en.superseded_by]
      for (var k = 0; k < links.length; k++) {
        var target = links[k]
        if (!target || indexOf[target] === undefined) continue
        var ra = find(en.id)
        var rb = find(target)
        if (ra !== rb) parent[ra] = rb
      }
    }
    var order = []
    var groups = Object.create(null)
    for (var m = 0; m < list.length; m++) {
      var item = list[m]
      if (!item || !item.id) { order.push({ items: [item] }); continue }
      var root = find(item.id)
      if (!groups[root]) {
        groups[root] = { items: [] }
        order.push(groups[root])
      }
      groups[root].items.push(item)
    }
    var chunks = []
    var current = []
    for (var g = 0; g < order.length; g++) {
      var items = order[g].items
      if (items.length > cap) {
        // 超过服务端单请求硬上限：整批提交会被 400 拒绝，改按拓扑分层拆分
        // （目标在前、指针在后，跨片链由服务端按磁盘状态物化重建）。
        if (current.length > 0) { chunks.push(current); current = [] }
        chunks = chunks.concat(splitLinkedComponentTopologically(items, cap))
        continue
      }
      if (items.length > n) {
        if (current.length > 0) { chunks.push(current); current = [] }
        chunks.push(items)
        continue
      }
      if (current.length + items.length > n) {
        chunks.push(current)
        current = []
      }
      current = current.concat(items)
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  /**
 * 聚合多片 dry-run 预览（服务端单请求上限 1000 条，整档预演需分片）。
 */
  function aggregateImportPlans(plans) {
    var totals = { imported: 0, updated: 0, deduplicated: 0, repaired: 0, rejected: [] }
    var list = Array.isArray(plans) ? plans : []
    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {}
      totals.imported += Number(p.imported) || 0
      totals.updated += Number(p.updated) || 0
      totals.deduplicated += Number(p.deduplicated) || 0
      totals.repaired += Number(p.repaired) || 0
      if (Array.isArray(p.rejected)) totals.rejected = totals.rejected.concat(p.rejected)
    }
    return totals
  }

  /**
 * 带撤销按钮的吐司展示时是否应接管焦点：只在焦点已丢失（body/面板容器/已卸载节点）
 * 且无弹窗时接管。用户正在输入框/下拉/可编辑区时不得抢焦点——排队撤销吐司延迟出现
 * 时抢焦点会打断输入，回车还可能误触一次真实写操作。
 */
function shouldFocusToastAction(info) {
  var i = info || {}
  if (i.hasModal) return false
  if (i.isBody || !i.isConnected) return true
  if (i.inCardAction) return true // 卡片动作按钮刷新后会卸载，接管到撤销按钮是安全且必要的
  var tag = String(i.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || i.isContentEditable) return false
  return i.isPage === true
}

/**
 * 分类 chip 数字：按分类筛选时 byCategory 是「过滤后」的分布，其它分类恒为 0，
 * 会被读成「库里没有这类记忆」。筛选态只在当前选中的分类 chip 上显示数字。
 */
function categoryChipCount(stats, category, categoryFilter) {
  if (!stats || !stats.byCategory) return null
  if (categoryFilter && categoryFilter !== category) return undefined // 隐藏
  return Number(stats.byCategory[category]) || 0
}

function pageSlice(entries, size) {
    var list = Array.isArray(entries) ? entries : []
    var n = Math.max(1, Number(size) || 1)
    return { items: list.slice(0, n), hasMore: list.length > n }
  }

  /**
 * 精确重复组合计（纯函数，存量治理用）：可合并组数 / 仅报告组数 / 合并将归档条数。
 * mergeable 组按 entries.length-1 计（keeper 保留），与 service.mergeDuplicates 口径一致。
 */
function duplicatePlanSummary(groups) {
  var list = Array.isArray(groups) ? groups : []
  var mergeable = 0
  var reportOnly = 0
  var wouldArchive = 0
  for (var i = 0; i < list.length; i++) {
    var group = list[i] || {}
    var entries = Array.isArray(group.entries) ? group.entries : []
    if (group.mergeable === true && entries.length >= 2) {
      mergeable += 1
      wouldArchive += entries.length - 1
    } else {
      reportOnly += 1
    }
  }
  return { groups: list.length, mergeable: mergeable, reportOnly: reportOnly, wouldArchive: wouldArchive }
}

  /**
 * 审计事件聚合计（纯函数，I4 面板学习分区用）：按类型计数、去掉未知形状事件。
 * 只做确定性计数，不读取/渲染任何候选正文。
 */
function auditCounts(events) {
  var list = Array.isArray(events) ? events : []
  // 无原型对象：audit.jsonl 可手改，type='__proto__'/'constructor' 不得被原型 setter
  // 吞掉或拼出 garbage（与 idSetOf/settleBulkDelete 等同一加固口径，C8）。
  var counts = Object.create(null)
  for (var i = 0; i < list.length; i++) {
    var type = list[i] && typeof list[i].type === 'string' ? list[i].type : 'unknown'
    if (type === 'digest_emitted') continue
    counts[type] = (counts[type] || 0) + 1
  }
  return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b) }).map(function (type) { return { type: type, count: counts[type] } })
}

  /** 批量批准/拒绝结算计数（纯函数）：api 层已 unwrapResult，回调拿到的是
   * {approved|rejected, failed} 本身——再取 payload.result 会恒为 {}（吐司恒报 0/0）。 */
  function learningBatchCounts(payload) {
    var r = payload || {}
    return {
      approved: Array.isArray(r.approved) ? r.approved.length : 0,
      rejected: Array.isArray(r.rejected) ? r.rejected.length : 0,
      failed: Array.isArray(r.failed) ? r.failed.length : 0,
    }
  }

  /** 真实写入条数（imported+updated）；被判重复/拒绝的条目不算「已写入」。 */
  function importWriteCount(totals) {
    var t = totals || {}
    return (Number(t.imported) || 0) + (Number(t.updated) || 0)
  }

  /**
   * 分片预演的 rejected.index 是「片内下标」，聚合后需重定位为原始文件位置；
   * chunkEntriesPreservingLinks 只切数组不改对象，用条目对象引用反查原始下标。
   */
  function rebaseRejectedIndexes(rejected, chunk, indexByEntry) {
    var list = Array.isArray(rejected) ? rejected : []
    return list.map(function (r) {
      var item = chunk && chunk[r && r.index]
      var original = item !== undefined && indexByEntry && indexByEntry.get(item)
      return Object.assign({}, r, { index: original === undefined ? r.index : original })
    })
  }

  function entryDetailRows(entry) {
    var e = entry || {}
    var rows = [
      { key: 'createdAt', value: e.created || '' },
      { key: 'updatedAt', value: e.updated || '' },
    ]
    if (e.source) rows.push({ key: 'sourceLabel', value: e.source })
    rows.push({ key: 'originLabel', value: originOf(e) })
    if (e.expires) rows.push({ key: 'expiresOn', value: e.expires })
    if (e.last_access) rows.push({ key: 'lastAccessLabel', value: e.last_access })
    if (typeof e.hit_count === 'number') rows.push({ key: 'hitCountLabel', value: String(e.hit_count) })
    if (e.supersedes) rows.push({ key: 'supersedesLabel', value: e.supersedes })
    if (e.superseded_by) rows.push({ key: 'supersededByLabel', value: e.superseded_by })
    return rows
  }

  function relativeTime(iso, now, lang) {
    var then = new Date(iso).getTime()
    if (isNaN(then)) return String(iso || '')
    var zh = lang === 'zh'
    // null/undefined 表示「用当前时间」：Number(null)===0 会骗过 isFinite 守卫，
    // 把近期条目当成 1970 年之后的未来时间而永远显示绝对日期。
    var nowMs = now == null ? Date.now() : Number(now)
    if (!Number.isFinite(nowMs)) nowMs = Date.now()
    function dateLabel(ms) {
      var d = new Date(ms)
      var sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
      if (zh) return (sameYear ? '' : d.getFullYear() + ' 年 ') + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
      return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
    }
    // 未来时间（时钟偏差/手工改时间）不做「刚刚」夹取，直接显示日期，避免误导。
    if (then > nowMs + 60_000) return dateLabel(then)
    var diff = Math.max(0, nowMs - then)
    var min = Math.floor(diff / 60_000)
    if (min < 1) return zh ? '刚刚' : 'just now'
    var hr = Math.floor(min / 60)
    var day = Math.floor(hr / 24)
    if (min < 60) return zh ? min + ' 分钟前' : min + ' min ago'
    if (hr < 24) return zh ? hr + ' 小时前' : hr + ' h ago'
    if (day < 7) return zh ? day + ' 天前' : day + ' d ago'
    return dateLabel(then)
  }

  function formatBytes(n) {
    var b = Number(n) || 0
    if (b < 1024) return b + ' B'
    var kb = b / 1024
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB'
    var mb = kb / 1024
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB'
  }

  var helpers = { validateDraft: validateDraft, buildCreatePayload: buildCreatePayload, clampPageToTotal: clampPageToTotal, todayUtcIso: todayUtcIso, localDateStamp: localDateStamp, cwdCompareKey: cwdCompareKey, canonicalWorkspaceValue: canonicalWorkspaceValue, platformIsWindows: platformIsWindows, groupEntries: groupEntries, nextToken: nextToken, entriesParams: entriesParams, buildEntriesQuery: buildEntriesQuery, workspaceOptions: workspaceOptions, errorKeyFor: errorKeyFor, shouldQueueToast: shouldQueueToast, toastRemainingMs: toastRemainingMs, shouldResumeToast: shouldResumeToast, settingsSignature: settingsSignature, shouldAutoRefresh: shouldAutoRefresh, partitionSettled: partitionSettled, idSetOf: idSetOf, settleBulkDelete: settleBulkDelete, parseTags: parseTags, unwrapResult: unwrapResult, settingsStatusNext: settingsStatusNext, savedToastKey: savedToastKey, exportParams: exportParams, defaultViewSelection: defaultViewSelection, sectionCountsExact: sectionCountsExact, chunkEntries: chunkEntries, chunkEntriesPreservingLinks: chunkEntriesPreservingLinks, parseImportText: parseImportText, validateImportDoc: validateImportDoc, importSummary: importSummary, importWriteCount: importWriteCount, rebaseRejectedIndexes: rebaseRejectedIndexes, aggregateImportPlans: aggregateImportPlans, shouldFocusToastAction: shouldFocusToastAction, categoryChipCount: categoryChipCount, importRejectText: importRejectText, pageSlice: pageSlice, duplicatePlanSummary: duplicatePlanSummary, auditCounts: auditCounts, learningBatchCounts: learningBatchCounts, entryDetailRows: entryDetailRows, relativeTime: relativeTime, formatBytes: formatBytes, isExpired: isExpired, statusOf: statusOf, originOf: originOf, statusQueryFlags: statusQueryFlags }

  // ===== node 测试导出（CJS） =====
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers
    return
  }

  // ===== 浏览器模块注册 =====

  var API_BASE = '/plugins/dsh-memory'
  var NS = 'dsh-memory'
  var PAGE_SIZE = 50
  var UNDO_MS = 6000
  // 回环请求超时：宿主事件循环被大导入等阻塞或连接半开时，面板不能永久转圈/禁用按钮。
  var REQUEST_TIMEOUT_MS = 15000
// 导入/恢复备份可能很大（1500 条约 1.4MB），预检上限与服务端写路由一致（32MB），
// 否则用户会看到「请求数据过大」而实际备份完全可用。请求超时对导入单独放宽。
var IMPORT_MAX_BYTES = 32 * 1024 * 1024
var IMPORT_TIMEOUT_MS = 180000
// 导出/备份要序列化全库（大库可达数十 MB），15s 默认超时不够；独立放宽到 120s。
var EXPORT_TIMEOUT_MS = 120000
// 查重是宿主同步全库计算（8k 库约 1.4s，30k 外推数秒），默认 15s 余量不足；
// 独立放宽到 120s，避免大库查重被误报超时（第十轮审计 C5）。
var SIMILAR_TIMEOUT_MS = 120000
  var IMPORT_CHUNK_SIZE = 300
var IMPORT_PREVIEW_CHUNK = 800

function newImportRunId() {
  return 'imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

  var TOAST_QUEUE_MAX = 3

  var ZH = {
    nav: '记忆',
    title: '记忆',
    versionLabel: '插件版本 ',
    subtitle: '跨会话长期记忆 · 全局与工作区',
    searchPlaceholder: '搜索记忆…',
    tagFilterPlaceholder: '标签过滤',
    tagFilterHint: '按标签精确过滤（大小写不敏感）',
    searchHint: '按 / 快速搜索',
    newMemory: '新建记忆',
    scopeGlobal: '全局',
    scopeWorkspace: '工作区',
    scopeAll: '全局＋当前工作区',
    statsUnit: '条记忆',
    statsScope: '全局 {g} · 工作区 {w}',
    categoryAll: '全部',
    empty: '暂无记忆',
    emptyTitle: '记忆库还是空的',
    emptyHint: '对话中说「记住…」，或点这里写下第一条。',
    emptyScopeTitle: '该工作区暂无记忆',
    emptyScopeHint: '可以在这里新建，或切换到其他作用域查看。',
    noResults: '没有匹配的记忆',
    noResultsHint: '试试其他关键词，或清除筛选条件。',
    clearFilters: '清除筛选',
    clearSearch: '清空搜索',
    deleting: '删除中…',
    edit: '编辑',
    del: '删除',
    save: '保存',
    cancel: '取消',
    close: '关闭',
    contentLabel: '内容（一条事实）',
    contentCount: '{n} 字',
    editorHint: 'Ctrl/⌘ + Enter 快速保存',
    categoryLabel: '分类',
    tagsLabel: '标签（逗号分隔，最多 12 个）',
    tagsCount: '标签 {n}/{max}',
    tagsLimit: '已达上限，超出部分不会保存',
    scopeLabel: '作用域',
    catPreference: '偏好',
    catFact: '事实',
    catDecision: '决策',
    editorCreate: '新建记忆',
    editorEdit: '编辑记忆',
    deleteTitle: '删除这条记忆？',
    bulkDeleteTitle: '删除这 {n} 条记忆？',
    deleteHint: '删除后 6 秒内可在底部提示中撤销。',
    saved: '已保存',
    revivedSaved: '已恢复为活跃（原为归档/过期）',
    closeToast: '关闭提示',
    deduplicated: '已有相同记忆，未重复写入',
    similarSaved: '已保存；检测到 {n} 条相似记忆（{id}），建议核对是否重复',
    deleted: '已删除',
    deletedN: '已删除 {n} 条',
    deletedPartial: '已删除 {n} 条，{m} 条失败',
    deleteFailed: '删除失败',
    undo: '撤销',
    undone: '已恢复 {n} 条记忆',
    undoFailed: '恢复失败',
    bulkSelected: '已选 {n} 条',
    bulkDelete: '删除所选',
    clearSelection: '取消选择',
    selectEntry: '选择这条记忆',
    selectEntryLabel: '选择这条记忆：{c}',
    clearTag: '清空标签过滤',
    loadError: '加载失败',
    listError: '列表加载失败',
    retry: '重试',
    loading: '加载中…',
    errEmptyContent: '内容不能为空',
    errBadCategory: '分类无效',
    errNotFound: '未找到该记忆（可能已被删除）',
    errSecret: '检测到疑似机密，已拒绝写入',
    errInvalid: '输入无效',
    errNoWorkspace: '没有可用的工作区目录',
    errUnauthorized: '凭证无效',
    errLoopback: '仅允许本机访问',
    errInvalidJson: '请求数据无效',
    errBodyTooLarge: '文件过大（超过 32 MB），请拆分后导入',
    errInternal: '操作失败，请稍后重试',
    errJoin: '：',
    labelSep: '：',
    errRefreshed: '凭证已刷新，请重试',
    errTimeout: '请求超时，请重试',
    errNetwork: '网络异常，请检查连接后重试',
    errBadResponse: '响应格式异常，请重试',
    errStaleSelection: '所选记忆已不在当前列表，已清除选择',
    pagePrev: '上一页',
    pageNext: '下一页',
    pageInfo: '第 {page} 页',
    copyId: '复制 id',
    copied: '已复制 id',
    copyFailed: '复制失败，请手动选择',
    createdAt: '创建于',
    updatedAt: '更新于',
    sourceLabel: '来源会话',
    originLabel: '来源',
    originFilterLabel: '来源筛选',
    originAll: '全部来源',
    originAuto: '主动沉淀',
    originManual: '显式要求',
    originEditHint: '显式要求＝你在对话中明确让记；主动沉淀＝agent 自行沉淀，便于审阅撤销。',
    statusFilterLabel: '状态筛选',
    statusActive: '活跃',
    statusSuperseded: '被取代',
    statusExpired: '已过期',
    statusArchived: '已归档',
    statusPinned: '已钉选',
    statusAll: '全部状态',
    hiddenHint: '另有 {n} 条匹配被隐藏（被取代 {s} / 已过期 {e} / 已归档 {a}）',
    hiddenViewAll: '查看全部状态',
    injectedLabel: '已注入',
    injectedTitle: '已注入到系统提示（全局＋当前工作区上下文）',
    pin: '钉选',
    unpin: '取消钉选',
    archive: '归档',
    restore: '恢复',
    pinnedMsg: '已钉选，注入时优先',
    unpinnedMsg: '已取消钉选',
    archivedMsg: '已归档（默认隐藏，可恢复）',
    restoredMsg: '已恢复',
    pinnedLabel: '钉选常驻',
    pinnedHint: '钉选的记忆在注入预算内最先召回，且不受软衰减影响',
    expiresLabel: '过期日（可选）',
    expiresOn: '过期日',
    expiresHint: '到期后默认隐藏，不删除；留空表示永不过期（按 UTC 日判定）',
    expiresClear: '清除',
    errBadExpires: '过期日需为 YYYY-MM-DD 格式的有效日期',
    errExpiresPast: '过期日不能早于今天（按 UTC 日）；过去日期会让记忆保存后立即隐藏',
    lastAccessLabel: '最近命中',
    hitCountLabel: '命中次数',
    supersedesLabel: '取代了',
    supersededByLabel: '被取代于',
    viewSuccessor: '查看后继',
    jumpToSuccessor: '搜索后继记忆',
    jumpToEntry: '跳转到该记忆',
    autoExtractHintLabel: '自动提取提示',
    autoExtractHintDesc: '会话数轮未写入记忆时，提醒 agent 沉淀值得长期保留的内容（零额外模型调用）',
    decayEnabledLabel: '软衰减排序',
    decayEnabledDesc: '长期未命中的记忆降低排序权重（永不过滤、不删除，钉选豁免）',
    tagSearch: '按此标签过滤',
    workspaceUnknown: '未知工作区',
    unknownWorkspaceHint: '有工作区路径未知（索引损坏），无法在面板中浏览；可用「导出」查看全部记忆，或手工修复数据目录下的 workspaces/index.json。',
    entriesUnit: '条',
    workspaceTarget: '写入工作区',
    export: '导出',
    import: '导入',
    refreshList: '刷新列表',
    refresh: '刷新',
    viewLabel: '视图',
    exporting: '正在导出…',
    exportDone: '已导出 {n} 条记忆',
    importTitle: '导入记忆',
    importNew: '新增',
    importDup: '重复跳过',
    importRej: '拒绝',
    importUpdated: '更新',
    importMergeLabel: '按 id 合并已存在条目（更新内容，保留创建时间）',
    importRejHint: '被拒绝的条目（机密/无效/缺工作区）不会写入。',
    importConfirm: '确认导入',
    importRepaired: '修复取代指针 {n} 处',
    exportSkipped: '另有 {n} 个损坏文件未被导出',
    importAllDup: '全部条目均已存在，无需导入。',
    importingProgress: '正在导入 {d}/{t}…',
    previewingProgress: '正在预演 {d}/{t}…',
    importPartialFail: '已写入 {d}/{t} 条后中断，可重试导入（已存在条目会去重/合并）',
    stopImport: '停止导入',
    importStopped: '已停止导入：已写入 {d}/{t} 条',
    imported: '导入完成',
    audit: '查重',
    auditTitle: '相似记忆查重',
    auditHint: '扫描当前作用域内活跃记忆的相似度（≥50%）。可让较新条目取代较旧条目（保留历史），或忽略以保留两条。',
    auditRunning: '正在查重相似记忆…',
    auditEmpty: '未发现相似记忆',
    auditScore: '相似度',
    auditOlder: '旧',
    auditNewer: '新',
    auditSupersede: '新取代旧',
    auditDismiss: '忽略',
    auditSuperseded: '已取代旧条目',
    auditCount: '共 {n} 对相似记忆',
    errDuplicate: '目标作用域已有相同内容的记忆',
    errImportDoc: '不是有效的 dsh-memory 导出文件（format/version/entries 不符）',
    errImportJson: '导入文件不是有效的 JSON',
    errReadFile: '读取导入文件失败',
    errIo: '写入失败，未做任何变更，请检查磁盘空间或权限后重试',
    errBusy: '另一个进程正在写入，请稍后重试',
    tabMemories: '记忆',
    tabSettings: '设置',
    learningTitle: '学习',
    learningPendingCount: '待确认 {n}',
    learningPendingBadge: '待确认',
    learningAutoBadge: '自动',
    learningReason: '原因：',
    learningApprove: '批准',
    learningReject: '拒绝',
    learningArchive: '归档',
    learningArchivedMsg: '已归档自动写入',
    learningApproved: '已批准并写入记忆',
    learningRejected: '已拒绝该候选',
    learningSkillBadge: '技能待批',
    learningSkillApprovedBadge: '技能',
    learningSkillRow: '{name}：{trigger}',
    learningSkillRollback: '回滚上一版',
    learningSkillApprovedMsg: '技能已批准并进入索引：{name}',
    learningSkillRejectedMsg: '已拒绝技能候选：{name}',
    learningSkillRolledBackMsg: '已回滚技能：{name}',
    learningBatchHint: '共 {n} 条待确认候选',
    learningApproveAll: '全部批准',
    learningRejectAll: '全部拒绝',
    learningBatchApproved: '已批量批准 {n} 条（失败 {m} 条）',
    learningBatchRejected: '已批量拒绝 {n} 条（失败 {m} 条）',
    learningShowAll: '显示全部 {n} 条',
    learningCollapse: '收起',
    learningConflict: '疑似冲突 {n}',
    groupLearning: '学习',
    autoLearnLabel: '自动写入额度',
    autoLearnDesc: '每会话自动沉淀候选上限（0=关闭自动，仅手动添加）',
    conflictAlertLabel: '疑似冲突提醒',
    conflictAlertDesc: '待确认候选与旧记忆疑似冲突时给出提示',
    digestLabel: '确定性周报',
    digestDesc: '每周聚合审计事件注入一次（零 LLM，可关）',
    digestWeekdayLabel: '周报星期',
    digestWeekdayDesc: '每周哪天生成并注入周报',
    weekday1: '周一', weekday2: '周二', weekday3: '周三', weekday4: '周四', weekday5: '周五', weekday6: '周六', weekday7: '周日',
    learningDigestBadge: '周报',
    learningAuditTitle: '最近审计',
    auditAutoSaved: '自动写入',
    auditPendingCreated: '新候选',
    auditPendingApproved: '批准',
    auditPendingRejected: '拒绝',
    auditDuplicatesMerged: '合并重复',
    auditArchived: '归档',
    auditRestored: '恢复',
    auditSkill: '技能',
    auditDigest: '周报生成',
    duplicates: '合并重复',
    duplicatesTitle: '合并重复记忆',
    duplicatesHint: '仅合并「同作用域 + 规范化正文 + 关键元数据完全一致」的精确重复：保留最早一条，其余归档（可恢复）并写审计。相似/冲突或元数据不同只报告，不自动合并。',
    duplicatesEmpty: '没有可合并的精确重复组',
    duplicatesSummary: '重复组 {g} / 可合并 {m} / 仅报告 {r}',
    duplicatesMergeable: '可合并',
    duplicatesReportOnly: '元数据不同（仅报告）',
    duplicatesCount: '{n} 条同文',
    duplicatesKeeper: '保留：{id}',
    duplicatesMismatch: '元数据（分类/标签/来源/钉选/过期日）不一致，需人工处理，不自动合并。',
    duplicatesMerge: '合并 {n} 组',
    duplicatesMerged: '已合并 {n} 组（归档 {m} 条，可恢复）',
    bulkArchive: '归档所选',
    bulkRestore: '恢复所选',
    bulkArchived: '已归档 {n} 条',
    bulkRestored: '已恢复 {n} 条',
    recallResidentTitle: '常驻（画像，只读）：pinned 与用户纠正形成的 constraint',
    recallIndexTitle: '索引层（单行摘要，完整正文用 memory_search）',
    recallLayers: '常驻 {r} 条 / 索引 {i} 条',
    recallOmittedReasons: '未注入原因：预算不足 {b} 条 / 单条过长 {o} 条',
    recallIndexBadge: '索引',
    settingsSubtitle: '注入 · 隐私 · 存储 · 面板',
    groupInjection: '注入与召回',
    groupPrivacy: '隐私护栏',
    groupStorage: '存储与备份',
    groupPanel: '面板偏好',
    autoInjectLabel: '自动注入记忆',
    autoInjectDesc: '装配系统提示时召回记忆（关闭后工具仍可用）',
    budgetLabel: '注入字符预算',
    budgetDesc: '超出预算的条目改用 memory_search 获取',
    recallTitle: '召回预览',
    recallRefresh: '刷新',
    recallLoading: '加载中…',
    recallHint: '反映已保存的设置；调整预算或开关后点「刷新」查看效果。',
    recallSummary: '注入 {injected} 条 · 未注入 {omitted} 条 · 占用 {used}/{budget} 字符',
    recallAutoOff: '（自动注入已关闭，以下为开启时的预览）',
    priorityNote: '注入顺序：钉选最先，其余 偏好 → 决策 → 事实（同级新者优先，软衰减影响排序）',
    privacyLabel: '机密拦截 · 始终启用',
    privacyDesc: '密码 / 密钥 / token 永不写入记忆，此护栏不可关闭。',
    dataRootLabel: '数据目录',
    storageUsageLabel: '存储占用',
    storageEntries: '{n} 条记忆',
    autoBackupLabel: '自动备份',
    autoBackupDesc: '每天自动导出全量记忆到 backups/ 目录',
    retentionLabel: '备份保留份数',
    retentionDesc: '超出时自动删除最旧的备份（仅删备份，不删记忆）',
    lastBackupLabel: '上次备份',
    backupCount: '{n} 份备份',
    neverBackup: '尚未备份',
    backupNow: '立即备份',
    backingUp: '正在备份…',
    backupDone: '备份完成',
    defaultViewLabel: '默认视图',
    pageSizeLabel: '每页条数',
    animationsLabel: '界面动效',
    animationsDesc: '吐司滑入、弹窗淡入、骨架屏微光等反馈动效',
    relativeTimeLabel: '相对时间',
    relativeTimeDesc: '显示「N 小时前」而非绝对时间',
    viewModeLabel: '列表密度',
    viewModeDesc: '舒适＝索引行（分类/标签/元信息全量）；紧凑＝单行高密度表格，一屏看更多',
    viewComfortable: '舒适',
    viewCompact: '紧凑',
    viewAll: '全局＋当前工作区',
    viewGlobal: '仅全局',
    viewWorkspace: '当前工作区',
    resetDefaults: '恢复默认',
    resetDone: '已恢复默认设置',
    settingsSaved: '设置已保存',
    settingsUnsaved: '有未保存的修改',
    settingsRetry: '重试保存',
    saving: '保存中…',
    copyPath: '复制路径',
    pathCopied: '已复制路径',
    enabledNote: '插件总开关 enabled 由 profile 配置管理（关闭会卸载整个插件）。',
  }
  var EN = {
    nav: 'Memory',
    title: 'Memory',
    versionLabel: 'Plugin version ',
    subtitle: 'Cross-session long-term memory · global & workspace',
    searchPlaceholder: 'Search memories…',
    tagFilterPlaceholder: 'Filter by tag',
    tagFilterHint: 'Filter by exact tag (case-insensitive)',
    searchHint: 'Press / to search',
    newMemory: 'New memory',
    scopeGlobal: 'Global',
    scopeWorkspace: 'Workspace',
    scopeAll: 'Global + current workspace',
    statsUnit: 'memories',
    statsScope: 'Global {g} · Workspace {w}',
    categoryAll: 'All',
    empty: 'No memories yet',
    emptyTitle: 'Your memory vault is empty',
    emptyHint: 'Say “remember…” in chat, or write the first one here.',
    emptyScopeTitle: 'No memories in this workspace',
    emptyScopeHint: 'Create one here, or switch to another scope.',
    noResults: 'No matching memories',
    noResultsHint: 'Try different keywords, or clear the filters.',
    clearFilters: 'Clear filters',
    clearSearch: 'Clear search',
    deleting: 'Deleting…',
    edit: 'Edit',
    del: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    contentLabel: 'Content (one fact)',
    contentCount: '{n} chars',
    editorHint: 'Ctrl/⌘ + Enter to save',
    categoryLabel: 'Category',
    tagsLabel: 'Tags (comma-separated, max 12)',
    tagsCount: 'Tags {n}/{max}',
    tagsLimit: 'Limit reached; extra tags will not be saved',
    scopeLabel: 'Scope',
    catPreference: 'Preference',
    catFact: 'Fact',
    catDecision: 'Decision',
    editorCreate: 'New memory',
    editorEdit: 'Edit memory',
    deleteTitle: 'Delete this memory?',
    bulkDeleteTitle: 'Delete these {n} memories?',
    deleteHint: 'You can undo from the toast within 6 seconds.',
    saved: 'Saved',
    revivedSaved: 'Restored to active (was archived/expired)',
    closeToast: 'Dismiss notification',
    deduplicated: 'Identical memory exists; nothing added',
    similarSaved: 'Saved; {n} similar memory found ({id}) — review for duplicates',
    deleted: 'Deleted',
    deletedN: 'Deleted {n}',
    deletedPartial: 'Deleted {n}, {m} failed',
    deleteFailed: 'Delete failed',
    undo: 'Undo',
    undone: 'Restored {n} memories',
    undoFailed: 'Restore failed',
    bulkSelected: '{n} selected',
    bulkDelete: 'Delete selected',
    clearSelection: 'Clear selection',
    selectEntry: 'Select this memory',
    selectEntryLabel: 'Select this memory: {c}',
    clearTag: 'Clear tag filter',
    loadError: 'Failed to load',
    listError: 'Failed to load entries',
    retry: 'Retry',
    loading: 'Loading…',
    errEmptyContent: 'Content must not be empty',
    errBadCategory: 'Invalid category',
    errNotFound: 'Memory not found (it may have been deleted)',
    errSecret: 'Suspected credential detected; write rejected',
    errInvalid: 'Invalid input',
    errNoWorkspace: 'No workspace directory available',
    errUnauthorized: 'Invalid credentials',
    errLoopback: 'Loopback access only',
    errInvalidJson: 'Invalid request data',
    errBodyTooLarge: 'File too large (over 32 MB); split it before importing',
    errInternal: 'Operation failed; please retry',
    errJoin: ': ',
    labelSep: ': ',
    errRefreshed: 'Credentials refreshed; please retry',
    errTimeout: 'Request timed out; please retry',
    errNetwork: 'Network error; check your connection and retry',
    errBadResponse: 'Unexpected response; please retry',
    errStaleSelection: 'Selected memories are no longer in this list; selection cleared',
    pagePrev: 'Previous',
    pageNext: 'Next',
    pageInfo: 'Page {page}',
    copyId: 'Copy id',
    copied: 'Id copied',
    copyFailed: 'Copy failed; select manually',
    createdAt: 'Created',
    updatedAt: 'Updated',
    sourceLabel: 'Source session',
    originLabel: 'Origin',
    originFilterLabel: 'Filter by origin',
    originAll: 'All origins',
    originAuto: 'Auto',
    originManual: 'Requested',
    originEditHint: 'Requested = you explicitly asked to remember; Auto = agent-initiated, reviewable and revocable.',
    statusFilterLabel: 'Filter by status',
    statusActive: 'Active',
    statusSuperseded: 'Superseded',
    statusExpired: 'Expired',
    statusArchived: 'Archived',
    statusPinned: 'Pinned',
    statusAll: 'All statuses',
    hiddenHint: '{n} more matches hidden (superseded {s} / expired {e} / archived {a})',
    hiddenViewAll: 'View all statuses',
    injectedLabel: 'Injected',
    injectedTitle: 'Injected into the system prompt (global + current workspace context)',
    pin: 'Pin',
    unpin: 'Unpin',
    archive: 'Archive',
    restore: 'Restore',
    pinnedMsg: 'Pinned; recalled first',
    unpinnedMsg: 'Unpinned',
    archivedMsg: 'Archived (hidden by default; restorable)',
    restoredMsg: 'Restored',
    pinnedLabel: 'Pin to top',
    pinnedHint: 'Pinned memories are recalled first within the injection budget and ignore soft decay',
    expiresLabel: 'Expires (optional)',
    expiresOn: 'Expires on',
    expiresHint: 'Hidden (not deleted) after this date (UTC day); empty means never expires',
    expiresClear: 'Clear',
    errBadExpires: 'Expires must be a valid date in YYYY-MM-DD format',
    errExpiresPast: 'Expiry cannot be before today (UTC day); a past date hides the memory immediately after saving',
    lastAccessLabel: 'Last hit',
    hitCountLabel: 'Hit count',
    supersedesLabel: 'Supersedes',
    supersededByLabel: 'Superseded by',
    viewSuccessor: 'View successor',
    jumpToSuccessor: 'Search for the successor memory',
    jumpToEntry: 'Jump to this memory',
    autoExtractHintLabel: 'Auto-extraction hints',
    autoExtractHintDesc: 'After several turns without a memory write, remind the agent to save durable facts (no extra model calls)',
    decayEnabledLabel: 'Soft decay ranking',
    decayEnabledDesc: 'Long-unused memories rank lower (never filtered or deleted; pinned exempt)',
    tagSearch: 'Filter by this tag',
    workspaceUnknown: 'Unknown workspace',
    unknownWorkspaceHint: 'Some workspace paths are unknown (corrupt index) and cannot be browsed here. Use Export to see all memories, or repair workspaces/index.json in the data directory by hand.',
    entriesUnit: 'entries',
    workspaceTarget: 'Writes to workspace',
    export: 'Export',
    import: 'Import',
    refreshList: 'Refresh list',
    refresh: 'Refresh',
    viewLabel: 'View',
    exporting: 'Exporting…',
    exportDone: 'Exported {n} memories',
    importTitle: 'Import memories',
    importNew: 'New',
    importDup: 'Duplicates skipped',
    importRej: 'Rejected',
    importUpdated: 'Updated',
    importMergeLabel: 'Merge existing by id (update content, keep created time)',
    importRejHint: 'Rejected entries (credentials/invalid/no workspace) are not written.',
    importConfirm: 'Import',
    importRepaired: 'repaired {n} supersede pointer(s)',
    exportSkipped: '{n} damaged file(s) were not exported',
    importAllDup: 'All entries already exist; nothing to import.',
    importingProgress: 'Importing {d}/{t}…',
    previewingProgress: 'Previewing {d}/{t}…',
    importPartialFail: 'Interrupted after writing {d}/{t} entries; retry is safe (existing entries are deduplicated/merged)',
    stopImport: 'Stop import',
    importStopped: 'Import stopped: wrote {d}/{t} entries',
    imported: 'Import complete',
    audit: 'Audit',
    auditTitle: 'Similar memory audit',
    auditHint: 'Scans active memories in the current scope for similarity (≥50%). Supersede the older with the newer (history kept), or dismiss to keep both.',
    auditRunning: 'Scanning for similar memories…',
    auditEmpty: 'No similar memories found',
    auditScore: 'Similarity',
    auditOlder: 'Older',
    auditNewer: 'Newer',
    auditSupersede: 'Supersede older',
    auditDismiss: 'Dismiss',
    auditSuperseded: 'Older entry superseded',
    auditCount: '{n} similar pairs',
    errDuplicate: 'Identical memory already exists in the target scope',
    errImportDoc: 'Not a valid dsh-memory export file (format/version/entries mismatch)',
    errImportJson: 'Import file is not valid JSON',
    errReadFile: 'Failed to read the import file',
    errIo: 'Write failed; no changes were made. Check disk space or permissions and retry',
    errBusy: 'Another process is writing; please retry shortly',
    tabMemories: 'Memories',
    tabSettings: 'Settings',
    learningTitle: 'Learning',
    learningPendingCount: '{n} pending',
    learningPendingBadge: 'Pending',
    learningAutoBadge: 'Auto',
    learningReason: 'reason: ',
    learningApprove: 'Approve',
    learningReject: 'Reject',
    learningArchive: 'Archive',
    learningArchivedMsg: 'Auto-save archived',
    learningApproved: 'Approved and saved',
    learningRejected: 'Candidate rejected',
    learningSkillBadge: 'Skill pending',
    learningSkillApprovedBadge: 'Skill',
    learningSkillRow: '{name}: {trigger}',
    learningSkillRollback: 'Roll back one version',
    learningSkillApprovedMsg: 'Skill approved and indexed: {name}',
    learningSkillRejectedMsg: 'Skill candidate rejected: {name}',
    learningSkillRolledBackMsg: 'Skill rolled back: {name}',
    learningBatchHint: '{n} candidates pending',
    learningApproveAll: 'Approve all',
    learningRejectAll: 'Reject all',
    learningBatchApproved: 'Approved {n} candidates ({m} failed)',
    learningBatchRejected: 'Rejected {n} candidates ({m} failed)',
    learningShowAll: 'Show all {n}',
    learningCollapse: 'Collapse',
    learningConflict: '{n} possible conflicts',
    groupLearning: 'Learning',
    autoLearnLabel: 'Auto-write quota',
    autoLearnDesc: 'Max auto-saved candidates per session (0 = off, manual only)',
    conflictAlertLabel: 'Conflict alerts',
    conflictAlertDesc: 'Alert when a pending candidate may conflict with existing memory',
    digestLabel: 'Deterministic weekly digest',
    digestDesc: 'Aggregate audit events once a week (zero LLM, can disable)',
    digestWeekdayLabel: 'Digest weekday',
    digestWeekdayDesc: 'Which weekday to generate and inject the digest',
    weekday1: 'Mon', weekday2: 'Tue', weekday3: 'Wed', weekday4: 'Thu', weekday5: 'Fri', weekday6: 'Sat', weekday7: 'Sun',
    learningDigestBadge: 'Digest',
    learningAuditTitle: 'Recent audit',
    auditAutoSaved: 'auto-saved',
    auditPendingCreated: 'new candidates',
    auditPendingApproved: 'approved',
    auditPendingRejected: 'rejected',
    auditDuplicatesMerged: 'duplicates merged',
    auditArchived: 'archived',
    auditRestored: 'restored',
    auditSkill: 'skill',
    auditDigest: 'digest emitted',
    duplicates: 'Duplicates',
    duplicatesTitle: 'Merge duplicate memories',
    duplicatesHint: 'Only exact duplicates with identical scope, normalized content and key metadata are merged: the earliest entry is kept, the rest are archived (reversible) with an audit record. Similar/conflicting or metadata-different entries are reported only.',
    duplicatesEmpty: 'No exact duplicate groups to merge',
    duplicatesSummary: '{g} groups / {m} mergeable / {r} report-only',
    duplicatesMergeable: 'Mergeable',
    duplicatesReportOnly: 'Metadata differs (report only)',
    duplicatesCount: '{n} same-text entries',
    duplicatesKeeper: 'Keep: {id}',
    duplicatesMismatch: 'Metadata (category/tags/origin/pinned/expires) differs; needs manual handling, never auto-merged.',
    duplicatesMerge: 'Merge {n} groups',
    duplicatesMerged: 'Merged {n} groups ({m} archived, reversible)',
    bulkArchive: 'Archive selected',
    bulkRestore: 'Restore selected',
    bulkArchived: '{n} archived',
    bulkRestored: '{n} restored',
    recallResidentTitle: 'Resident (profile, read-only): pinned and user-correction constraints',
    recallIndexTitle: 'Index layer (one-line summaries; use memory_search for full text)',
    recallLayers: '{r} resident / {i} index',
    recallOmittedReasons: 'Not injected: {b} over budget / {o} single entry too long',
    recallIndexBadge: 'index',
    settingsSubtitle: 'Injection · Privacy · Storage · Panel',
    groupInjection: 'Injection & recall',
    groupPrivacy: 'Privacy guard',
    groupStorage: 'Storage & backup',
    groupPanel: 'Panel preferences',
    autoInjectLabel: 'Auto-inject memories',
    autoInjectDesc: 'Recall memories when assembling the system prompt (tools still work when off)',
    budgetLabel: 'Injection character budget',
    budgetDesc: 'Entries beyond the budget stay reachable via memory_search',
    recallTitle: 'Recall preview',
    recallRefresh: 'Refresh',
    recallLoading: 'Loading…',
    recallHint: 'Reflects saved settings; click Refresh after changing the budget or toggles.',
    recallSummary: '{injected} injected · {omitted} omitted · {used}/{budget} chars',
    recallAutoOff: '(auto-inject is off; preview shown as if on)',
    priorityNote: 'Injection order: pinned first, then preference → decision → fact (newest first; soft decay affects ranking)',
    privacyLabel: 'Credential block · always on',
    privacyDesc: 'Passwords / keys / tokens are never stored. This guard cannot be disabled.',
    dataRootLabel: 'Data directory',
    storageUsageLabel: 'Storage usage',
    storageEntries: '{n} memories',
    autoBackupLabel: 'Automatic backup',
    autoBackupDesc: 'Export all memories to backups/ daily',
    retentionLabel: 'Backups to keep',
    retentionDesc: 'Oldest backups are pruned beyond this count (backups only, never memories)',
    lastBackupLabel: 'Last backup',
    backupCount: '{n} backups',
    neverBackup: 'No backup yet',
    backupNow: 'Back up now',
    backingUp: 'Backing up…',
    backupDone: 'Backup complete',
    defaultViewLabel: 'Default view',
    pageSizeLabel: 'Entries per page',
    animationsLabel: 'Animations',
    animationsDesc: 'Toast slide-in, dialog fade, skeleton shimmer and other feedback motion',
    relativeTimeLabel: 'Relative time',
    relativeTimeDesc: 'Show “N hours ago” instead of absolute timestamps',
    viewModeLabel: 'List density',
    viewModeDesc: 'Comfortable = index rows (category/tags/metadata); Compact = one-line dense table for more rows per screen',
    viewComfortable: 'Comfortable',
    viewCompact: 'Compact',
    viewAll: 'Global + current workspace',
    viewGlobal: 'Global only',
    viewWorkspace: 'Current workspace',
    resetDefaults: 'Reset to defaults',
    resetDone: 'Settings reset to defaults',
    settingsSaved: 'Settings saved',
    settingsUnsaved: 'Unsaved changes',
    settingsRetry: 'Retry save',
    saving: 'Saving…',
    copyPath: 'Copy path',
    pathCopied: 'Path copied',
    enabledNote: 'The master switch enabled is managed in the profile config (disabling it unloads the whole plugin).',
  }

  var CSS = [
    // ---- 设计令牌：宿主主题令牌 + 三枚可辨识的分类色（低饱和，只做功能识别） ----
    '.dm_page,.dm_select_pop{--dm-bg:var(--dsw-alias-bg-base,#f6f8fc);--dm-surface:var(--dsw-alias-bg-layer-1,#ffffff);--dm-raised:color-mix(in srgb,var(--dm-ink) 3.5%,var(--dm-bg));--dm-inset:color-mix(in srgb,var(--dm-ink) 2.5%,var(--dm-surface));--dm-ink:var(--dsw-alias-label-primary,#141821);--dm-ink2:var(--dsw-alias-label-secondary,#4b5565);--dm-ink3:var(--dsw-alias-label-tertiary,#6b7280);--dm-line:var(--dsw-alias-border-l1,#dbe2ee);--dm-line2:var(--dsw-alias-border-l2,#c6d2e4);--dm-primary:var(--dsw-alias-state-business-primary,#2154ce);--dm-primary2:var(--dsw-alias-state-business-primary,#2154ce);--dm-on-primary:var(--dsw-alias-label-on-color,#ffffff);--dm-accent-soft:color-mix(in srgb,var(--dm-primary) 10%,transparent);--dm-accent-line:color-mix(in srgb,var(--dm-primary) 38%,transparent);--dm-pref:#a15c07;--dm-pref-soft:color-mix(in srgb,#d97706 13%,transparent);--dm-fact:#2358a8;--dm-fact-soft:color-mix(in srgb,#2563eb 11%,transparent);--dm-dec:#0f6b4a;--dm-dec-soft:color-mix(in srgb,#059669 11%,transparent);--dm-danger:var(--dsw-alias-state-error-primary,#bf0f0f);--dm-danger-soft:color-mix(in srgb,#dc2626 10%,transparent);--dm-success:var(--dsw-alias-state-success-primary,#137036);--dm-success-soft:color-mix(in srgb,#059669 10%,transparent);--dm-mono:var(--ds-font-family-code,ui-monospace,"Cascadia Mono",Consolas,monospace);--dm-shadow:0 1px 2px rgba(16,25,45,.05);--dm-pop:0 14px 40px -18px rgba(16,25,45,.32),0 2px 6px rgba(16,25,45,.06);--dm-overlay-shadow:0 28px 80px -32px rgba(16,25,45,.5),0 2px 8px rgba(16,25,45,.07);--dm-ring:0 0 0 3px color-mix(in srgb,var(--dm-primary) 20%,transparent);}',
    '.dm_page{height:100%;overflow-y:auto;box-sizing:border-box;color:var(--dm-ink);font-size:13px;line-height:1.55;background-color:var(--dm-bg);background-image:none;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 20%,transparent) transparent;}',
    'body[data-ds-dark-theme] .dm_page,body[data-ds-dark-theme] .dm_select_pop{--dm-bg:var(--dsw-alias-bg-base,#0f1115);--dm-surface:var(--dsw-alias-bg-layer-1,#171a21);--dm-ink:var(--dsw-alias-label-primary,#e8eaf0);--dm-ink2:var(--dsw-alias-label-secondary,#a8aebd);--dm-ink3:var(--dsw-alias-label-tertiary,#8b93a7);--dm-line:var(--dsw-alias-border-l1,rgba(232,234,240,.08));--dm-line2:var(--dsw-alias-border-l2,rgba(232,234,240,.16));--dm-pref:#e4b357;--dm-pref-soft:rgba(228,179,87,.14);--dm-fact:#86a9e6;--dm-fact-soft:rgba(134,169,230,.14);--dm-dec:#67c79a;--dm-dec-soft:rgba(103,199,154,.14);--dm-danger:var(--dsw-alias-state-error-primary,#f87171);--dm-danger-soft:rgba(248,113,113,.13);--dm-success:var(--dsw-alias-state-success-primary,#34d399);--dm-success-soft:rgba(52,211,153,.13);--dm-shadow:0 1px 2px rgba(0,0,0,.45);--dm-pop:0 18px 44px -20px rgba(0,0,0,.85),0 2px 8px rgba(0,0,0,.45);--dm-overlay-shadow:0 32px 90px -36px rgba(0,0,0,.9),0 2px 8px rgba(0,0,0,.45);}',
    '.dm_page::-webkit-scrollbar{width:10px;height:10px;}',
    '.dm_page::-webkit-scrollbar-track{background:transparent;}',
    '.dm_page::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 18%,transparent);border-radius:8px;border:3px solid transparent;background-clip:content-box;}',
    '.dm_page::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dm-ink) 34%,transparent);border:3px solid transparent;background-clip:content-box;}',
    '.dm_page ::selection{background:color-mix(in srgb,var(--dm-primary) 24%,transparent);}',
    // ---- 版心 / 页头：强调色只用在品牌标记与主操作 ----
    '.dm_inner{max-width:1080px;margin:0 auto;padding:0 32px 72px;}',
    '.dm_header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-top:26px;margin-bottom:0;}',
    '.dm_brand{display:flex;gap:13px;align-items:center;min-width:0;}',
    '.dm_brand_medal{flex-shrink:0;width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--dm-primary);background:var(--dm-accent-soft);border:1px solid var(--dm-accent-line);box-shadow:none;padding:0;}',
    '.dm_title_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.dm_title{margin:0;font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1.2;}',
    '.dm_version{font:500 10.5px/1 var(--dm-mono);color:var(--dm-ink3);letter-spacing:.02em;border:1px solid var(--dm-line2);border-radius:99px;padding:3px 8px;white-space:nowrap;}',
    '.dm_subtitle{color:var(--dm-ink3);margin-top:4px;font-size:12.5px;}',
    '.dm_cta{height:34px;padding:0 15px;border-radius:7px;font-size:12.5px;font-weight:600;flex-shrink:0;}',
    '.dm_sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;}',
    // ---- 标签页 ----
    '.dm_tabs{display:flex;gap:26px;margin:20px 0 0;border-bottom:1px solid var(--dm-line);}',
    '.dm_tab{display:inline-flex;align-items:center;gap:7px;border:none;background:transparent;color:var(--dm-ink3);font:inherit;font-size:13px;font-weight:500;padding:0 0 10px;cursor:pointer;position:relative;transition:color .13s;}',
    '.dm_tab:hover{color:var(--dm-ink);}',
    '.dm_tab:focus-visible{outline:none;box-shadow:var(--dm-ring);border-radius:4px;}',
    '.dm_tab_active{color:var(--dm-ink);font-weight:600;}',
    '.dm_tab_active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px;background:var(--dm-primary);}',
    '.dm_tab_n{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);background:var(--dm-raised);border:1px solid var(--dm-line);border-radius:99px;padding:1px 7px;}',
    '.dm_tab_active .dm_tab_n{color:var(--dm-primary);background:var(--dm-accent-soft);border-color:var(--dm-accent-line);}',
    // ---- 概览面板：总数 + 分类/状态筛选 chips（有边界，可点击） ----
    '.dm_stats{display:flex;flex-direction:column;gap:12px;background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:10px;padding:16px 18px 14px;margin:16px 0 14px;box-shadow:none;}',
    '.dm_stats_head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;}',
    '.dm_stats_total{display:flex;align-items:baseline;gap:8px;}',
    '.dm_stats_num{font-size:32px;font-weight:650;line-height:.95;letter-spacing:-.03em;color:var(--dm-ink);font-variant-numeric:tabular-nums;}',
    '.dm_stats_unit{font-size:11.5px;color:var(--dm-ink3);letter-spacing:.04em;}',
    '.dm_stats_div{width:1px;height:30px;background:var(--dm-line2);}',
    '.dm_stats_scope{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);letter-spacing:.02em;white-space:nowrap;margin-left:auto;padding:4px 9px;border:1px solid var(--dm-line);border-radius:99px;background:var(--dm-raised);}',
    '.dm_stats_dist{flex:1;min-width:240px;display:flex;flex-direction:column;justify-content:flex-end;gap:0;}',
    '.dm_stats_body{display:flex;flex-direction:column;gap:8px;}',
    '.dm_dist_bar{display:flex;gap:2px;height:9px;border-radius:5px;overflow:hidden;background:var(--dm-raised);}',
    '.dm_dist_seg{min-width:4px;border-radius:2px;opacity:.9;}',
    '.dm_dist_seg_preference{background:var(--dm-pref);}',
    '.dm_dist_seg_fact{background:var(--dm-fact);}',
    '.dm_dist_seg_decision{background:var(--dm-dec);}',
    '.dm_chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
    '.dm_chips .dm_filter_label{min-width:auto;}',
    '.dm_chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dm-line);background:transparent;color:var(--dm-ink2);border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit;font-size:12px;font-weight:500;transition:color .13s,background-color .13s,border-color .13s;}',
    '.dm_chip:hover{border-color:color-mix(in srgb,var(--dm-chip-c,var(--dm-primary)) 45%,var(--dm-line));color:var(--dm-ink);background:var(--dm-raised);}',
    '.dm_chip:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_chip[aria-pressed="true"]{background:var(--dm-chip-soft,var(--dm-accent-soft));border-color:color-mix(in srgb,var(--dm-chip-c,var(--dm-primary)) 55%,transparent);color:color-mix(in srgb,var(--dm-chip-c,var(--dm-primary)) 88%,var(--dm-ink));font-weight:600;}',
    '.dm_chip svg{width:13px;height:13px;flex-shrink:0;color:var(--dm-chip-c,currentColor);opacity:.9;}',
    '.dm_chip:not([aria-pressed="true"]) svg{opacity:.7;}',
    '.dm_chip_n{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);background:color-mix(in srgb,var(--dm-ink) 5%,transparent);border-radius:99px;padding:0 5px;min-width:16px;text-align:center;}',
    '.dm_chip[aria-pressed="true"] .dm_chip_n{color:inherit;background:color-mix(in srgb,var(--dm-ink) 8%,transparent);}',
    '.dm_chips_status{margin-top:1px;}',
    '.dm_filter_label{font:500 10px var(--dm-mono);letter-spacing:.06em;color:var(--dm-ink3);padding-right:2px;text-transform:uppercase;}',
    '.dm_stats_clear{border:1px solid var(--dm-line);background:transparent;color:var(--dm-ink3);border-radius:6px;font:inherit;font-size:11.5px;padding:3px 9px;cursor:pointer;margin-left:auto;}',
    '.dm_stats_clear:hover{color:var(--dm-ink);border-color:var(--dm-line2);background:var(--dm-raised);}',
    // ---- 工具栏（吸顶）：独立面板，搜索优先，操作分组 ----
    // top 必须为 0：Chromium 会把滚动容器 padding-top 叠加进 sticky 停驻位。
    '.dm_toolbar_wrap{position:sticky;top:0;z-index:30;margin:0 -32px 6px;padding:10px 32px;background:var(--dm-bg);background-image:none;border-bottom:1px solid var(--dm-line);backdrop-filter:none;}',
    '.dm_toolbar{display:flex;gap:4px;flex-wrap:wrap;align-items:center;background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:10px;padding:6px 6px;}',
    '.dm_searchwrap{position:relative;flex:1 1 140px;min-width:120px;max-width:300px;order:-1;}',
    '.dm_search_icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--dm-ink3);pointer-events:none;display:flex;}',
    '.dm_search{width:100%;height:32px;box-sizing:border-box;border:1px solid var(--dm-line);border-radius:6px;background:var(--dm-bg);color:var(--dm-ink);padding:0 30px 0 31px;font:inherit;font-size:12.5px;transition:border-color .13s,background-color .13s,box-shadow .13s;}',
    '.dm_search::placeholder{color:var(--dm-ink3);}',
    '.dm_search:hover{background:var(--dm-raised);}',
    '.dm_search:focus{outline:none;border-color:var(--dm-primary);background:var(--dm-surface);box-shadow:var(--dm-ring);}',
    '.dm_search_clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:22px;height:22px;border:none;border-radius:4px;background:transparent;color:var(--dm-ink3);cursor:pointer;display:flex;align-items:center;justify-content:center;}',
    '.dm_search_clear:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_select_trigger{display:inline-flex;align-items:center;gap:7px;height:32px;width:100%;box-sizing:border-box;border:1px solid var(--dm-line);border-radius:6px;background:transparent;color:var(--dm-ink2);padding:0 8px 0 10px;font:inherit;font-size:12.5px;cursor:pointer;max-width:320px;transition:color .13s,background-color .13s,border-color .13s;}',
    '.dm_select_trigger:hover{color:var(--dm-ink);background:var(--dm-raised);border-color:var(--dm-line2);}',
    '.dm_select_trigger:focus-visible{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_select_open{border-color:var(--dm-accent-line);background:var(--dm-surface);color:var(--dm-ink);}',
    '.dm_select_disabled{opacity:.42;cursor:default;}',
    '.dm_select_val_icon{display:flex;color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_select_value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}',
    '.dm_select_chev{display:flex;color:var(--dm-ink3);flex-shrink:0;transition:transform .18s;}',
    '.dm_select_open .dm_select_chev{transform:rotate(180deg);color:var(--dm-ink2);}',
    '.dm_select_pop{position:fixed;z-index:1200;box-sizing:border-box;background:var(--dm-surface);border:1px solid var(--dm-line2);border-radius:8px;box-shadow:var(--dm-pop);padding:5px;max-height:320px;overflow-y:auto;animation:dm_fade .12s ease;transform-origin:top center;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 20%,transparent) transparent;}',
    '.dm_select_pop::-webkit-scrollbar{width:8px;}',
    '.dm_select_pop::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 18%,transparent);border-radius:8px;}',
    '.dm_select_up{transform-origin:bottom center;}',
    '.dm_select_opt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;color:var(--dm-ink);transition:background-color .1s,color .1s;}',
    '.dm_select_opt_active{background:color-mix(in srgb,var(--dm-ink) 6%,transparent);}',
    '.dm_select_opt_sel{color:var(--dm-ink);font-weight:600;background:var(--dm-accent-soft);}',
    '.dm_select_opt_sel.dm_select_opt_active{background:color-mix(in srgb,var(--dm-primary) 16%,transparent);}',
    '.dm_select_opt_disabled{opacity:.4;cursor:default;}',
    '.dm_select_opt_icon{display:flex;color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_select_opt_sel .dm_select_opt_icon{color:var(--dm-primary);}',
    '.dm_select_opt_spacer{width:14px;}',
    '.dm_select_opt_label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dm_select_opt_hint{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_select_opt_check{color:var(--dm-primary);flex-shrink:0;}',
    '.dm_tagwrap{position:relative;display:inline-flex;align-items:center;}',
    '.dm_taginput{height:32px;width:84px;padding:0 26px 0 9px;border:1px solid var(--dm-line);border-radius:6px;background:transparent;color:var(--dm-ink);font:inherit;font-size:12.5px;}',
    '.dm_taginput::placeholder{color:var(--dm-ink3);}',
    '.dm_taginput:hover{background:var(--dm-raised);}',
    '.dm_taginput:focus{outline:none;border-color:var(--dm-primary);background:var(--dm-surface);box-shadow:var(--dm-ring);}',
    '.dm_tagclear{position:absolute;right:4px;width:20px;height:20px;border:none;border-radius:4px;background:transparent;color:var(--dm-ink3);cursor:pointer;display:flex;align-items:center;justify-content:center;}',
    '.dm_tagclear:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_toolbtn{height:32px;border-color:transparent;background:transparent;padding:0 6px;font-size:12.5px;}',
    '.dm_toolbtn:hover{border-color:var(--dm-line);background:var(--dm-raised);}',
    '.dm_viewtoggle{display:inline-flex;gap:3px;border:1px solid var(--dm-line);border-radius:6px;padding:2px 4px 2px 8px;background:var(--dm-raised);margin-left:auto;flex-shrink:0;align-items:center;}',
    '.dm_viewtoggle_label{font:500 10px var(--dm-mono);color:var(--dm-ink3);letter-spacing:.04em;white-space:nowrap;margin-right:2px;}',
    '.dm_viewbtn{height:24px;min-width:34px;padding:0 7px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--dm-ink3);cursor:pointer;font:inherit;font-size:11.5px;font-weight:500;line-height:1;white-space:nowrap;}',
    '.dm_viewbtn:hover{color:var(--dm-ink);background:var(--dm-surface);}',
    '.dm_viewbtn:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_viewbtn_on{background:var(--dm-surface);border-color:var(--dm-line2);color:var(--dm-primary);box-shadow:var(--dm-shadow);}',
    '.dm_viewbtn:disabled{opacity:.45;cursor:default;}',
    // ---- 通用按钮 ----
    '.dm_btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dm-line2);background:var(--dm-surface);color:var(--dm-ink2);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;font-size:12.5px;line-height:1.2;transition:color .13s,background-color .13s,border-color .13s;}',
    '.dm_btn:hover{color:var(--dm-ink);border-color:color-mix(in srgb,var(--dm-ink) 26%,var(--dm-line2));background:color-mix(in srgb,var(--dm-ink) 4%,var(--dm-surface));}',
    '.dm_btn:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_btn:disabled{opacity:.42;cursor:default;}',
    '.dm_btn_primary{background:var(--dm-primary);border-color:transparent;color:var(--dm-on-primary);font-weight:600;}',
    '.dm_btn_primary:hover{color:var(--dm-on-primary);background:color-mix(in srgb,var(--dm-primary) 90%,#000);border-color:transparent;}',
    '.dm_btn_danger{color:var(--dm-danger);}',
    '.dm_btn_danger:hover{color:var(--dm-danger);border-color:color-mix(in srgb,var(--dm-danger) 45%,var(--dm-line2));background:var(--dm-danger-soft);}',
    '.dm_btn_danger_solid{background:var(--dm-danger);border-color:transparent;color:#fff;font-weight:600;}',
    '.dm_btn_danger_solid:hover{color:#fff;background:color-mix(in srgb,var(--dm-danger) 90%,#000);}',
    '.dm_btn_ghost{border-color:transparent;background:transparent;}',
    '.dm_btn_mini{padding:3px 8px;font-size:11.5px;border-radius:5px;}',
    // ---- 分组容器 + 索引行：面板内细线分隔，分类色只做左侧细轨与标签 ----
    '.dm_group{background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:10px;overflow:hidden;margin-bottom:16px;}',
    '.dm_group_body{display:block;}',
    '.dm_section_title{display:flex;align-items:center;gap:9px;padding:11px 16px;margin:0;background:var(--dm-raised);border-bottom:1px solid var(--dm-line);font-size:11.5px;font-weight:600;color:var(--dm-ink2);letter-spacing:.05em;}',
    '.dm_section_title svg{opacity:.85;}',
    '.dm_section_n{font:500 10px var(--dm-mono);font-weight:500;color:var(--dm-ink3);letter-spacing:.02em;background:transparent;border:1px solid var(--dm-line);border-radius:99px;padding:1px 7px;}',
    '.dm_card{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;column-gap:12px;align-items:start;border:0;border-bottom:1px solid var(--dm-line);border-radius:0;padding:13px 16px 13px 15px;margin:0;background:transparent;transition:background-color .12s ease;}',
    '.dm_card::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:0 2px 2px 0;background:var(--dm-cat,var(--dm-primary));opacity:.7;}',
    '.dm_card:last-child{border-bottom:0;}',
    '.dm_card:hover{background:color-mix(in srgb,var(--dm-ink) 4.5%,var(--dm-surface));}',
    '.dm_card_selected{background:color-mix(in srgb,var(--dm-primary) 6%,var(--dm-surface));}',
    '.dm_card_selected::before{opacity:1;width:3px;}',
    '.dm_rail{display:none;}',
    '.dm_medal{display:none;}',
    '.dm_check{display:flex;align-items:flex-start;padding-top:2px;flex-shrink:0;}',
    // 常驻低透明度（U4）：批量选择入口可发现，不必先 hover 才看见复选框；hover/选中/选择态提至不透明。
    '.dm_check input{width:14px;height:14px;margin:0;accent-color:var(--dm-primary);cursor:pointer;opacity:.4;transition:opacity .12s;}',
    '.dm_card:hover .dm_check input,.dm_check input:checked,.dm_selecting .dm_check input,.dm_check input:focus-visible{opacity:1;}',
    '@media (hover:none){.dm_check input{opacity:1;}}',
    '.dm_card_main{min-width:0;flex:1;}',
    '.dm_card_top{display:flex;align-items:center;gap:0;flex-wrap:wrap;min-height:18px;font-size:11.5px;color:var(--dm-ink3);}',
    '.dm_card_top > * + *{margin-left:9px;}',
    '.dm_card_top > * + *::before{content:"·";margin-right:8px;color:var(--dm-ink3);opacity:.6;}',
    '.dm_badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.01em;padding:2px 8px;border-radius:5px;color:color-mix(in srgb,var(--dm-cat) 85%,var(--dm-ink));background:var(--dm-cat-soft,var(--dm-fact-soft));border:1px solid color-mix(in srgb,var(--dm-cat) 22%,transparent);}',
    '.dm_badge::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--dm-cat,var(--dm-primary));}',
    '.dm_badge svg{display:none;}',
    '.dm_scope_chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dm-ink3);}',
    '.dm_time{font:500 11px var(--dm-mono);color:var(--dm-ink3);margin-left:auto;font-variant-numeric:tabular-nums;cursor:default;}',
    '.dm_time::before{content:"";margin-right:0;}',
    '.dm_content{white-space:pre-wrap;word-break:break-word;margin:7px 0 8px;line-height:1.65;font-size:13.5px;color:var(--dm-ink);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;border-radius:3px;}',
    '.dm_content:hover{color:var(--dm-ink);}',
    '.dm_content:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_content_open{display:block;-webkit-line-clamp:unset;cursor:default;}',
    '.dm_details{display:grid;grid-template-columns:88px minmax(0,1fr);gap:7px 12px;font-size:11.5px;color:var(--dm-ink2);margin:9px 0 11px;padding:11px 13px;background:var(--dm-inset);border:1px solid var(--dm-line);border-radius:7px;}',
    '.dm_details_row{display:contents;}',
    '.dm_details > div:not(.dm_details_row){grid-column:1/-1;}',
    '.dm_details_k{color:var(--dm-ink3);}',
    '.dm_details_v{word-break:break-all;}',
    '.dm_details_link{display:inline-flex;align-items:center;gap:3px;border:none;background:none;padding:0;font:inherit;color:var(--dm-ink2);cursor:pointer;word-break:break-all;text-decoration:underline;text-decoration-color:var(--dm-line2);text-underline-offset:2px;}',
    '.dm_details_link:hover{color:var(--dm-ink);text-decoration-color:var(--dm-ink3);}',
    '.dm_card_foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:0;}',
    '.dm_tag{border:1px solid transparent;background:var(--dm-raised);color:var(--dm-ink2);font:inherit;font-size:11px;padding:1.5px 7px;border-radius:4px;cursor:pointer;transition:color .13s,background-color .13s,border-color .13s;}',
    '.dm_tag:hover{color:var(--dm-ink);background:var(--dm-inset);border-color:var(--dm-line2);}',
    '.dm_tag:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_id{font:400 10.5px var(--dm-mono);color:var(--dm-ink3);opacity:.8;margin-left:auto;word-break:break-all;}',
    '.dm_card_actions{display:flex;flex-direction:row;gap:2px;flex-shrink:0;margin-top:-3px;opacity:.72;transition:opacity .12s ease;}',
    '.dm_card:hover .dm_card_actions,.dm_card:focus-within .dm_card_actions,.dm_card_selected .dm_card_actions{opacity:1;}',
    '@media (hover:none){.dm_card_actions{opacity:1;}}',
    '.dm_card_actions .dm_btn{padding:4px 7px;border-color:transparent;background:transparent;color:var(--dm-ink3);border-radius:5px;gap:4px;font-size:11px;}',
    '.dm_card_actions .dm_btn:hover{border-color:var(--dm-line2);background:var(--dm-surface);color:var(--dm-ink);}',
    '.dm_card_actions .dm_btn_danger:hover{background:var(--dm-danger-soft);border-color:transparent;color:var(--dm-danger);}',
    '.dm_act_label{display:inline;white-space:nowrap;font-weight:500;}',
    '.dm_origin{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:400;padding:0;border-radius:0;color:var(--dm-ink3);}',
    '.dm_origin svg{display:none;}',
    '.dm_origin_auto{color:var(--dm-ink3);background:none;}',
    '.dm_origin_manual{color:var(--dm-ink3);background:none;}',
    '.dm_status{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:99px;color:var(--dm-ink3);background:color-mix(in srgb,var(--dm-ink) 6%,transparent);}',
    '.dm_status svg{display:none;}',
    '.dm_status_expired{color:var(--dm-danger);background:var(--dm-danger-soft);}',
    '.dm_successor{display:inline-flex;align-items:center;gap:3px;border:none;background:transparent;color:var(--dm-primary);font:inherit;font-size:11px;font-weight:500;padding:0;border-radius:0;cursor:pointer;}',
    '.dm_successor:hover{text-decoration:underline;text-underline-offset:2px;}',
    '.dm_pinned_mark{display:inline-flex;align-items:center;color:var(--dm-pref);background:var(--dm-pref-soft);border-radius:99px;padding:1px 6px 1px 4px;font-size:10.5px;font-weight:600;}',
    '.dm_injected_mark{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:500;color:var(--dm-success);}',
    '.dm_card_muted{opacity:.68;}',
    '.dm_card_muted:hover{opacity:1;}',
    '.dm_btn_pinned{color:var(--dm-pref);}',
    // ---- 紧凑视图（列表密度=compact）：单行高密度表格，一屏看更多 ----
    '.dm_compact .dm_header{margin-top:18px;}',
    '.dm_compact .dm_title{font-size:21px;}',
    '.dm_compact .dm_subtitle{font-size:12px;}',
    '.dm_compact .dm_stats{padding:12px 16px 10px;gap:9px;margin:12px 0 10px;}',
    '.dm_compact .dm_stats_head{gap:12px;}',
    '.dm_compact .dm_stats_num{font-size:24px;}',
    '.dm_compact .dm_dist_bar{height:7px;}',
    '.dm_compact .dm_toolbar_wrap{padding:8px 32px;}',
    '.dm_compact .dm_section_title{padding:8px 14px;}',
    '.dm_compact .dm_card{padding:8px 14px 8px 13px;grid-template-columns:16px minmax(0,1fr) auto;column-gap:10px;align-items:center;}',
    '.dm_compact .dm_card::before{top:7px;bottom:7px;}',
    '.dm_compact .dm_check{padding-top:0;}',
    '.dm_compact .dm_card_top{min-height:16px;}',
    '.dm_compact .dm_origin,.dm_compact .dm_injected_mark,.dm_compact .dm_scope_chip{display:none;}',
    '.dm_compact .dm_time{font-size:10.5px;}',
    '.dm_compact .dm_content{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;-webkit-line-clamp:unset;margin:3px 0 0;font-size:13px;line-height:1.45;}',
    '.dm_compact .dm_card_foot{display:none;}',
    '.dm_compact .dm_card_actions{margin-top:0;gap:0;}',
    '.dm_compact .dm_card_actions .dm_btn{padding:4px;}',
    '.dm_compact .dm_act_label{display:none;}',
    '.dm_compact .dm_card_expanded .dm_content{white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:unset;-webkit-box-orient:vertical;}',
    '.dm_compact .dm_card_expanded .dm_card_foot{display:flex;margin-top:5px;}',
    '.dm_compact .dm_card_expanded .dm_details{margin:7px 0 8px;}',
    '.dm_compact .dm_empty{padding:40px 20px;}',
    // ---- 加载 / 空态 / 错误 ----
    '.dm_skel{background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:10px;padding:18px 16px;margin-bottom:16px;}',
    '.dm_skel_line{height:10px;border-radius:3px;background:var(--dm-raised);margin-bottom:10px;animation:dm_breathe 1.8s ease-in-out infinite;}',
    '.dm_empty{border:1px solid var(--dm-line);border-radius:10px;padding:56px 24px;text-align:center;color:var(--dm-ink2);background:var(--dm-surface);}',
    '.dm_empty_art{display:block;margin:0 auto 14px;color:var(--dm-ink3);opacity:.55;}',
    '.dm_empty_title{font-size:14px;font-weight:600;color:var(--dm-ink);letter-spacing:-.01em;}',
    '.dm_empty_hint{margin-top:6px;font-size:12.5px;color:var(--dm-ink3);max-width:44ch;margin-left:auto;margin-right:auto;line-height:1.6;}',
    '.dm_hidden_hint{display:flex;align-items:flex-start;gap:9px;margin:14px 0 6px;padding:9px 12px;border:1px solid var(--dm-line);border-radius:7px;background:var(--dm-raised);color:var(--dm-ink2);font-size:12px;line-height:1.55;}',
    // 刷新失败但已有列表时的可关闭错误横幅（U5）：保留阅读上下文，不整块替换为错误态。
    '.dm_listerror{display:flex;align-items:flex-start;gap:9px;margin:14px 0 6px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--dm-danger) 30%,transparent);border-radius:7px;background:var(--dm-danger-soft);color:var(--dm-ink2);font-size:12px;line-height:1.55;}',
    '.dm_hidden_hint svg{opacity:.8;flex-shrink:0;margin-top:1px;}',
    // ---- 翻页 ----
    '.dm_pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:18px 0 8px;}',
    '.dm_pager .dm_btn{height:29px;padding:0 10px;border-color:var(--dm-line);}',
    '.dm_pageinfo{font:500 11px var(--dm-mono);color:var(--dm-ink3);background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:99px;padding:3px 10px;font-variant-numeric:tabular-nums;}',
    // ---- 批量选择浮栏 ----
    '.dm_selbar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:900;display:flex;gap:7px;align-items:center;background:var(--dm-surface);border:1px solid var(--dm-line2);border-radius:8px;padding:8px 9px 8px 13px;box-shadow:var(--dm-pop);animation:dm_rise .18s ease;max-width:calc(100vw - 32px);}',
    '.dm_selbar_n{font-size:12.5px;font-weight:600;color:var(--dm-ink);white-space:nowrap;margin-right:3px;}',
    // ---- 弹窗 ----
    '.dm_overlay{position:fixed;inset:0;background:color-mix(in srgb,#0b0e17 42%,transparent);display:flex;align-items:center;justify-content:center;z-index:1000;animation:dm_fade .14s ease;}',
    'body[data-ds-dark-theme] .dm_overlay{background:rgba(0,0,0,.62);}',
    '.dm_dialog{background:var(--dm-surface);color:var(--dm-ink);border:1px solid var(--dm-line2);border-radius:12px;padding:22px 24px 18px;width:min(600px,calc(100vw - 40px));max-height:84vh;overflow-y:auto;box-shadow:var(--dm-overlay-shadow);box-sizing:border-box;animation:dm_fade .14s ease;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 20%,transparent) transparent;}',
    '.dm_dialog::-webkit-scrollbar{width:8px;}',
    '.dm_dialog::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 18%,transparent);border-radius:4px;}',
    '.dm_dialog_head{display:flex;align-items:center;gap:11px;margin:0 0 18px;padding-bottom:15px;border-bottom:1px solid var(--dm-line);}',
    '.dm_dialog_medal{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;flex-shrink:0;background:var(--dm-accent-soft);border:1px solid var(--dm-accent-line);color:var(--dm-primary);}',
    '.dm_dialog_medal_danger{background:var(--dm-danger-soft);border-color:color-mix(in srgb,var(--dm-danger) 30%,transparent);color:var(--dm-danger);}',
    '.dm_dialog_title{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em;}',
    '.dm_field{margin-bottom:16px;}',
    '.dm_label{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--dm-ink2);letter-spacing:.02em;margin-bottom:7px;}',
    '.dm_label svg{display:none;}',
    '.dm_textarea{width:100%;min-height:132px;resize:vertical;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:7px;background:var(--dm-bg);color:var(--dm-ink);padding:11px 12px;font:inherit;font-size:13px;line-height:1.65;transition:border-color .13s,box-shadow .13s;}',
    '.dm_input{width:100%;height:34px;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:7px;background:var(--dm-bg);color:var(--dm-ink);padding:0 10px;font:inherit;font-size:13px;transition:border-color .13s,box-shadow .13s;}',
    '.dm_textarea:hover,.dm_input:hover{border-color:color-mix(in srgb,var(--dm-ink) 24%,var(--dm-line2));}',
    '.dm_textarea:focus,.dm_input:focus,.dm_dialog .dm_select_trigger:focus-visible{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);background:var(--dm-surface);}',
    '.dm_dialog .dm_selectwrap{display:block;width:100%;}',
    '.dm_dialog .dm_select_trigger{max-width:none;height:34px;border:1px solid var(--dm-line2);border-radius:7px;background:var(--dm-bg);padding:0 9px 0 10px;}',
    '.dm_charcount{text-align:right;font:500 10.5px var(--dm-mono);color:var(--dm-ink3);margin-top:5px;font-variant-numeric:tabular-nums;}',
    '.dm_charcount_limit{color:var(--dm-danger);}',
    '.dm_catgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}',
    '.dm_catopt{display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--dm-line2);border-radius:7px;background:transparent;color:var(--dm-ink2);padding:8px 6px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:500;transition:color .13s,background-color .13s,border-color .13s;}',
    '.dm_catopt::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dm-cat);}',
    '.dm_catopt svg{display:none;}',
    '.dm_catopt:hover{color:var(--dm-ink);border-color:color-mix(in srgb,var(--dm-cat) 45%,var(--dm-line2));background:var(--dm-raised);}',
    '.dm_catopt:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_catopt[aria-checked="true"]{background:var(--dm-cat-soft);border-color:color-mix(in srgb,var(--dm-cat) 55%,transparent);color:color-mix(in srgb,var(--dm-cat) 85%,var(--dm-ink));font-weight:600;}',
    '.dm_dialog_footer{display:flex;justify-content:flex-end;gap:8px;margin:20px -24px -18px;padding:14px 24px 16px;border-top:1px solid var(--dm-line);align-items:center;position:sticky;bottom:-18px;background:var(--dm-surface);border-radius:0 0 12px 12px;}',
    '.dm_dialog_footer .dm_hint{margin-right:auto;}',
    '.dm_delete_preview{border:1px solid var(--dm-line);border-radius:7px;padding:12px 14px;margin:12px 0 10px;white-space:pre-wrap;word-break:break-word;background:var(--dm-inset);max-height:36vh;overflow-y:auto;font-size:12.5px;line-height:1.6;}',
    '.dm_hint{color:var(--dm-ink3);font-size:11.5px;line-height:1.55;}',
    '.dm_import_tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:0;margin:12px 0 14px;border:1px solid var(--dm-line);border-radius:7px;overflow:hidden;background:var(--dm-inset);}',
    '.dm_tile{border:0;border-left:1px solid var(--dm-line);border-radius:0;padding:12px 13px;background:none;text-align:left;}',
    '.dm_tile:first-child{border-left:0;}',
    '.dm_tile_num{font-size:21px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--dm-ink);}',
    '.dm_tile_label{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);margin-top:4px;letter-spacing:.02em;}',
    '.dm_import_merge{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:12.5px;color:var(--dm-ink2);cursor:pointer;}',
    '.dm_audit_list{display:flex;flex-direction:column;gap:0;}',
    '.dm_audit_pair{border:1px solid var(--dm-line);border-radius:8px;padding:13px 14px;background:var(--dm-surface);margin-bottom:10px;}',
    '.dm_audit_pair:last-child{margin-bottom:0;}',
    '.dm_audit_score{font:600 11px var(--dm-mono);color:var(--dm-primary);background:var(--dm-accent-soft);border:1px solid var(--dm-accent-line);border-radius:99px;display:inline-block;padding:1px 8px;margin-bottom:9px;}',
    '.dm_audit_side{display:flex;gap:9px;align-items:flex-start;margin-bottom:6px;}',
    '.dm_audit_tag{flex-shrink:0;font:600 10px var(--dm-mono);padding:2px 6px;border-radius:4px;background:var(--dm-raised);color:var(--dm-ink3);letter-spacing:.03em;}',
    '.dm_audit_tag_new{background:var(--dm-accent-soft);color:var(--dm-primary);}',
    '.dm_audit_content{font-size:12.5px;line-height:1.55;color:var(--dm-ink2);word-break:break-word;}',
    '.dm_audit_actions{display:flex;justify-content:flex-end;gap:6px;margin-top:9px;}',
    // ---- 学习分区：待确认候选 / 最近自动写入（细线行，无装饰） ----
    '.dm_learn_row{display:flex;align-items:flex-start;gap:12px;padding:11px 16px;border-bottom:1px solid var(--dm-line);}',
    '.dm_learn_row:last-child{border-bottom:0;}',
    '.dm_learn_main{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
    '.dm_learn_badge{flex-shrink:0;font:600 10px var(--dm-mono);color:var(--dm-primary);background:var(--dm-accent-soft);border:1px solid var(--dm-accent-line);border-radius:99px;padding:1px 7px;}',
    // 正文默认截断（2 行）：长候选/周报不再把工具栏与记忆列表挤出首屏；点击展开完整内容。
    '.dm_learn_text{font-size:13px;line-height:1.55;color:var(--dm-ink);word-break:break-word;flex:1;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}',
    '.dm_learn_row_auto .dm_learn_text{-webkit-line-clamp:1;}',
    '.dm_learn_text_open{display:block;-webkit-line-clamp:unset;overflow:visible;}',
    '.dm_learn_link,.dm_learn_expand{cursor:pointer;}',
    '.dm_learn_link:hover,.dm_learn_expand:hover{color:var(--dm-primary);}',
    '.dm_learn_link:focus-visible,.dm_learn_expand:focus-visible{outline:none;box-shadow:var(--dm-ring);border-radius:4px;}',
    '.dm_learn_reason{font:500 10.5px var(--dm-mono);color:var(--dm-ink3);}',
    '.dm_learn_conflict{flex-shrink:0;font:600 10px var(--dm-mono);color:var(--dm-danger);background:var(--dm-danger-soft);border:1px solid color-mix(in srgb,var(--dm-danger) 30%,transparent);border-radius:99px;padding:1px 7px;}',
    '.dm_learn_time{font:500 11px var(--dm-mono);color:var(--dm-ink3);white-space:nowrap;}',
    '.dm_learn_actions{display:flex;gap:6px;flex-shrink:0;}',
    '.dm_recall{margin-top:14px;border:1px solid var(--dm-line);border-radius:8px;padding:14px;background:var(--dm-inset);}',
    '.dm_recall_head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;}',
    '.dm_recall_head .dm_label{margin:0;font-size:11.5px;}',
    '.dm_recall_list{display:flex;flex-direction:column;gap:7px;margin-top:10px;max-height:240px;overflow-y:auto;scrollbar-width:thin;}',
    '.dm_recall_item{display:flex;gap:10px;align-items:flex-start;font-size:12px;line-height:1.5;}',
    '.dm_recall_cat{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;font:600 10px var(--dm-mono);letter-spacing:.02em;color:var(--dm-ink3);padding-top:2px;min-width:36px;}',
    '.dm_recall_cat::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dm-cat,var(--dm-primary));flex-shrink:0;}',
    '.dm_recall_content{color:var(--dm-ink2);word-break:break-word;}',
    // ---- 吐司 ----
    '.dm_toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1100;display:flex;gap:9px;align-items:center;min-width:260px;max-width:min(560px,90vw);background:var(--dm-surface);color:var(--dm-ink);border:1px solid var(--dm-line2);border-left:3px solid var(--dm-success);border-radius:8px;padding:10px 12px;box-shadow:var(--dm-pop);animation:dm_rise .18s ease;overflow:hidden;}',
    '.dm_toast_raised{bottom:82px;}',
    '.dm_toast_info{border-left-color:var(--dm-ink3);}',
    '.dm_toast_error{border-left-color:var(--dm-danger);}',
    '.dm_toast_icon{width:18px;height:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--dm-ink3);}',
    '.dm_toast_ok .dm_toast_icon{color:var(--dm-success);}',
    '.dm_toast_error .dm_toast_icon{color:var(--dm-danger);}',
    '.dm_toast_info .dm_toast_icon{color:var(--dm-ink2);}',
    '.dm_toast_text{flex:1;font-size:12.5px;line-height:1.5;color:var(--dm-ink);}',
    '.dm_toast_action{border:none;background:transparent;color:var(--dm-primary);font:inherit;font-size:12.5px;font-weight:600;padding:3px 7px;margin-right:2px;border-radius:4px;cursor:pointer;flex-shrink:0;transition:background-color .13s;}',
    '.dm_toast_action:hover{background:var(--dm-accent-soft);}',
    '.dm_toast_close{border:none;background:transparent;color:var(--dm-ink3);width:20px;height:20px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.dm_toast_close:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_toast_bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--dm-success);animation:dm_bar linear forwards;}',
    '.dm_toast_info .dm_toast_bar{background:var(--dm-ink3);}',
    '.dm_toast_error .dm_toast_bar{background:var(--dm-danger);}',
    '.dm_nav_icon{display:block;}',
    // ---- 设置页：分组面板 + 细线行 + 单强调色图标 ----
    '.dm_settings{display:flex;flex-direction:column;max-width:100%;padding-top:16px;}',
    '.dm_setgroup{background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:10px;padding:0;margin:0 0 16px;overflow:hidden;}',
    '.dm_setgroup_head{display:flex;align-items:center;gap:10px;margin:0;padding:12px 16px;background:var(--dm-raised);border-bottom:1px solid var(--dm-line);}',
    '.dm_setgroup_icon{display:flex;width:26px;height:26px;border-radius:6px;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dm-primary) 14%,transparent);color:var(--dm-primary);border:1px solid var(--dm-accent-line);flex-shrink:0;}',
    '.dm_setgroup_title{margin:0;font-size:13px;font-weight:600;color:var(--dm-ink);letter-spacing:0;}',
    '.dm_setgroup_body{display:block;}',
    '.dm_setgroup_body > :first-child{border-top:0;}',
    '.dm_setrow{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;padding:12px 16px;border-top:1px solid var(--dm-line);}',
    '.dm_setgroup_body > .dm_setrow:first-child{border-top:0;}',
    '.dm_setrow_text{flex:1;min-width:0;}',
    '.dm_setrow_label{font-size:13px;font-weight:500;color:var(--dm-ink);}',
    '.dm_setrow_desc{font-size:11.5px;color:var(--dm-ink3);margin-top:3px;line-height:1.55;max-width:56ch;}',
    '.dm_setrow_ctrl{flex-shrink:0;display:flex;align-items:center;gap:8px;}',
    '.dm_setnote{font-size:11.5px;color:var(--dm-ink3);padding:11px 16px;border:0;border-top:1px solid var(--dm-line);border-radius:0;margin:0;display:flex;gap:8px;align-items:flex-start;line-height:1.55;background:var(--dm-inset);}',
    '.dm_setnote svg{opacity:.75;flex-shrink:0;margin-top:1px;}',
    '.dm_guard{display:flex;gap:11px;align-items:flex-start;padding:13px 16px;border-radius:0;background:var(--dm-success-soft);border:0;border-top:1px solid var(--dm-line);margin:0;}',
    '.dm_guard_icon{color:var(--dm-success);flex-shrink:0;display:flex;padding-top:1px;}',
    '.dm_guard_title{font-size:12.5px;font-weight:600;color:var(--dm-ink);}',
    '.dm_guard_desc{font-size:11.5px;color:var(--dm-ink3);margin-top:2px;line-height:1.55;}',
    '.dm_pathrow{display:flex;gap:8px;align-items:center;}',
    '.dm_path{font:400 11px var(--dm-mono);color:var(--dm-ink2);background:var(--dm-inset);border:1px solid var(--dm-line);border-radius:5px;padding:5px 9px;flex:1;word-break:break-all;min-width:0;}',
    '.dm_backupmeta{font-size:11.5px;color:var(--dm-ink3);display:flex;gap:14px;flex-wrap:wrap;margin:0;padding:11px 16px;border-top:1px solid var(--dm-line);align-items:center;}',
    '.dm_setfooter{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px;padding:14px 2px 0;border-top:1px solid var(--dm-line);}',
    '.dm_savestate{font:500 11px var(--dm-mono);color:var(--dm-ink3);display:flex;gap:6px;align-items:center;}',
    '.dm_linkbtn{border:none;background:transparent;color:var(--dm-primary);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0;}',
    '.dm_no_anim *,.dm_no_anim *::before,.dm_no_anim *::after{animation:none !important;transition:none !important;}',
    // ---- 开关 / 滑杆 / 数字 ----
    '.dm_switch{position:relative;width:36px;height:21px;border:none;border-radius:11px;background:color-mix(in srgb,var(--dm-ink) 20%,transparent);cursor:pointer;padding:0;transition:background-color .15s;flex-shrink:0;}',
    '.dm_switch:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_switch_on{background:var(--dm-primary);}',
    '.dm_switch:disabled{opacity:.42;cursor:default;}',
    '.dm_switch_knob{position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s;}',
    '.dm_switch_on .dm_switch_knob{transform:translateX(15px);}',
    '.dm_slider_row{display:flex;align-items:center;gap:12px;}',
    '.dm_range{width:180px;height:14px;accent-color:var(--dm-primary);cursor:pointer;}',
    '.dm_slider_val{font:500 11.5px var(--dm-mono);color:var(--dm-ink);font-variant-numeric:tabular-nums;min-width:52px;text-align:right;}',
    '.dm_numinput{width:68px;height:30px;border:1px solid var(--dm-line2);border-radius:6px;background:var(--dm-bg);color:var(--dm-ink);padding:0 7px;font:inherit;font-size:12px;text-align:center;}',
    '.dm_numinput:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);background:var(--dm-surface);}',
    '.dm_setselect .dm_select_trigger{height:30px;max-width:240px;border:1px solid var(--dm-line2);background:var(--dm-bg);}',
    // ---- 日期 / 钉选 ----
    '.dm_expiresrow{display:flex;gap:8px;align-items:center;}',
    '.dm_dateinput{max-width:220px;color-scheme:light;}',
    'body[data-ds-dark-theme] .dm_dateinput{color-scheme:dark;}',
    '.dm_pinrow{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
    // ---- 动画：只保留功能性反馈 ----
    '@keyframes dm_fade{from{opacity:0;}to{opacity:1;}}',
    '@keyframes dm_rise{from{opacity:0;transform:translate(-50%,10px);}to{opacity:1;transform:translate(-50%,0);}}',
    '@keyframes dm_bar{from{width:100%;}to{width:0%;}}',
    '@keyframes dm_breathe{0%,100%{opacity:1;}50%{opacity:.5;}}',
    // 旧视觉引用的 keyframes 保留定义（样式已不再引用），避免外部快照断言报缺失。
    '@keyframes dm_enter{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}',
    '@keyframes dm_pop{from{opacity:0;transform:scale(.96) translateY(6px);}to{opacity:1;transform:scale(1) translateY(0);}}',
    '@keyframes dm_pulse{0%,100%{opacity:.5;transform:scale(1);}50%{opacity:.12;transform:scale(1.06);}}',
    '@keyframes dm_float{from{transform:translateY(0);}to{transform:translateY(-5px);}}',
    '@keyframes dm_pop_in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
    '@keyframes dm_pop_in_up{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}',
    // ---- 响应式与动效偏好 ----
    '@media (max-width:760px){.dm_inner{padding:0 18px 56px;}.dm_toolbar_wrap{margin:0 -18px;padding:8px 18px;}.dm_header{flex-direction:column;align-items:stretch;gap:12px;}.dm_cta{width:100%;justify-content:center;}.dm_stats{padding:14px;}.dm_stats_div{display:none;}.dm_card{grid-template-columns:18px minmax(0,1fr);}.dm_card_actions{grid-column:2;justify-content:flex-end;margin-top:6px;}.dm_import_tiles{grid-template-columns:repeat(2,1fr);}}',
    '@media (prefers-reduced-motion:reduce){.dm_page *,.dm_page *::before,.dm_page *::after,.dm_toast,.dm_selbar,.dm_overlay,.dm_dialog,.dm_select_pop{animation:none !important;transition:none !important;}}',
    'body.dm-no-anim .dm_select_pop{animation:none !important;}',
    // 禁用态必须压过 :hover 的提亮/变色（busy 时主按钮不应显得可点）。
    '.dm_btn:disabled:hover{filter:none;transform:none;}',
    '.dm_btn_primary:disabled:hover{filter:none;transform:none;}',
    '.dm_select_disabled:hover{border-color:var(--dm-line);background:transparent;}',
  ].join('\n')

  global.__ModuleLoader__.load({
    id: 'dsh-memory',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useLayoutEffect = React.useLayoutEffect
      var useRef = React.useRef
      var useCallback = React.useCallback
      var ReactDOM = require('react-dom')
      var selectSeq = 0

      // ===== 图标（内联 SVG，stroke=currentColor） =====
      var ICONS = {
        search: ['M21 21l-4.35-4.35', 'M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z'],
        plus: ['M12 5v14', 'M5 12h14'],
        export: ['M12 3v12', 'M8 11l4 4 4-4', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
        import: ['M12 15V3', 'M8 7l4-4 4 4', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
        edit: ['M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17v3z', 'M13.5 6.5l3 3'],
        trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7', 'M10 11v6', 'M14 11v6'],
        copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
        check: ['M5 13l4 4L19 7'],
        x: ['M6 6l12 12', 'M18 6L6 18'],
        chevL: ['M15 6l-6 6 6 6'],
        chevR: ['M9 6l6 6-6 6'],
        chevD: ['M6 9l6 6 6-6'],
        globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a13.5 13.5 0 0 1 0 18', 'M12 3a13.5 13.5 0 0 0 0 18'],
        folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],
        clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
        undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
        alert: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
        star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z'],
        info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8h.01', 'M12 11v5'],
        checkCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12.5l2.5 2.5 4.5-5'],
        tag: ['M20.6 13.4L11 3.8A2 2 0 0 0 9.6 3H5a2 2 0 0 0-2 2v4.6c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.8z', 'M7.5 7.5h.01'],
        layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
        lock: ['M6 10V8a6 6 0 0 1 12 0v2', 'M5 10h14v10H5z', 'M12 14v3'],
        database: ['M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3z', 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
        sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
        viewList: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
        viewCompact: ['M3 5h18', 'M3 9h18', 'M3 13h18', 'M3 17h18', 'M3 21h18'],
        pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],
        archive: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
        zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
        link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
      }

      function Icon(props) {
        var paths = ICONS[props.name] || ICONS.info
        var size = props.size || 16
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: props.strokeWidth || 1.8,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, className: props.className, style: props.style,
        }, paths.map(function (d, i) { return h('path', { key: i, d: d }) }))
      }

      var CATEGORY_META = {
        preference: { icon: 'star', cat: 'var(--dm-pref)', soft: 'var(--dm-pref-soft)', label: 'catPreference' },
        fact: { icon: 'info', cat: 'var(--dm-fact)', soft: 'var(--dm-fact-soft)', label: 'catFact' },
        decision: { icon: 'checkCircle', cat: 'var(--dm-dec)', soft: 'var(--dm-dec-soft)', label: 'catDecision' },
      }

      var STATUS_CHIPS = [
        { key: 'all', icon: 'layers', c: 'var(--dm-ink2)', label: 'statusAll' },
        { key: 'active', icon: 'checkCircle', c: 'var(--dm-primary)', label: 'statusActive' },
        { key: 'superseded', icon: 'link', c: 'var(--dm-ink3)', label: 'statusSuperseded' },
        { key: 'expired', icon: 'clock', c: 'var(--dm-danger)', label: 'statusExpired' },
        { key: 'archived', icon: 'archive', c: 'var(--dm-ink2)', label: 'statusArchived' },
        { key: 'pinned', icon: 'pin', c: 'var(--dm-pref)', label: 'statusPinned' },
      ]
      // 详情行中按原文展示（不做时间格式化）的 key；originLabel 单独走文案映射。
      var DETAIL_TEXT_KEYS = { sourceLabel: 1, expiresOn: 1, hitCountLabel: 1, supersedesLabel: 1, supersededByLabel: 1 }

      function catVars(category) {
        var meta = CATEGORY_META[category] || CATEGORY_META.fact
        return { '--dm-cat': meta.cat, '--dm-cat-soft': meta.soft }
      }

      function uiLang() {
        var lang = (document.documentElement && document.documentElement.lang) || ''
        return lang.indexOf('zh') === 0 ? 'zh' : 'en'
      }

      function formatTime(iso) {
        if (!iso) return ''
        var date = new Date(iso)
        if (isNaN(date.getTime())) return String(iso)
        return date.toLocaleString(uiLang() === 'zh' ? 'zh-CN' : 'en-US')
      }

      // 兼容旧调用点：标签解析与导出统一走模块级 parseTags（宿主同口径）。
      function splitTags(text) {
        return parseTags(text)
      }

      function legacyCopy(text) {
        // 临时 textarea 会抢焦点、移除后焦点掉 body：先记住触发元素，复制完归还。
        var previous = document.activeElement
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        var ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        ta.remove()
        if (previous && previous.focus && document.contains(previous)) {
          try { previous.focus() } catch { /* 归还失败不影响复制结果 */ }
        }
        return ok
      }

      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).catch(function () {
            return legacyCopy(text) ? undefined : Promise.reject(new Error('copy failed'))
          })
        }
        return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy unsupported'))
      }

      function errorText(err, t) {
        var key = errorKeyFor(err)
        if (key) return t(key)
        return String((err && err.message) || err)
      }

      // ===== API（同源 fetch + token 生命周期） =====
      // abortRef：页面级取消（卸载时 abort 全部在途请求），与超时信号合并使用。
      function createApi(tokenRef, abortRef) {
        function request(path, options) {
          var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options)
          var timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS
          delete opts.timeoutMs
          // 超时即中止：超时/网络失败统一转成带 code 的错误，交给 errorText 本地化。
          var timeoutSignal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(timeoutMs) : null
          var pageSignal = abortRef && abortRef.current ? abortRef.current.signal : null
          var release = function () {}
          if (timeoutSignal && pageSignal) {
            // 合并超时与页面取消：任一触发即中止；请求结束后摘除监听，避免泄漏。
            var merged = new AbortController()
            var onAbort = function () { merged.abort() }
            timeoutSignal.addEventListener('abort', onAbort)
            pageSignal.addEventListener('abort', onAbort)
            if (timeoutSignal.aborted || pageSignal.aborted) merged.abort()
            release = function () {
              timeoutSignal.removeEventListener('abort', onAbort)
              pageSignal.removeEventListener('abort', onAbort)
            }
            opts.signal = merged.signal
          } else if (timeoutSignal || pageSignal) {
            opts.signal = timeoutSignal || pageSignal
          }
          return fetch(path, opts).catch(function (err) {
            var timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
            var wrapped = new Error(timedOut ? 'timeout' : 'network')
            wrapped.code = timedOut ? 'timeout' : 'network'
            wrapped.cause = err
            throw wrapped
          }).then(function (res) {
            return res.json().catch(function () { return null }).then(function (payload) {
              tokenRef.current = nextToken(tokenRef.current, { status: res.status, payload: payload })
              if (!res.ok) {
                var err = new Error((payload && (payload.error || payload.code)) || ('HTTP ' + res.status))
                err.status = res.status
                err.code = payload && payload.code
                throw err
              }
              // 200 但非 JSON（代理/半截响应）：显式报错，避免下游 TypeError 被当正文展示。
              if (payload === null) {
                var bad = new Error('bad-response')
                bad.code = 'bad-response'
                bad.status = res.status
                throw bad
              }
              return payload
            })
          }).then(function (payload) {
            release()
            return payload
          }, function (err) {
            release()
            throw err
          })
        }
        function post(path, input, timeoutMs) {
          return request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RPC-Key': tokenRef.current },
            body: JSON.stringify(input || {}),
            timeoutMs: timeoutMs,
          })
        }
        return {
          status: function () { return request(API_BASE + '/status') },
          workspaces: function () { return request(API_BASE + '/workspaces') },
          cwd: function (sessionId) { return request(API_BASE + '/cwd?sessionId=' + encodeURIComponent(sessionId || '')) },
          entries: function (params) { return request(API_BASE + '/entries' + buildEntriesQuery(params)) },
          stats: function (params) { return request(API_BASE + '/stats' + buildEntriesQuery(params)) },
          similar: function (params) { return request(API_BASE + '/similar' + buildEntriesQuery(params), { timeoutMs: SIMILAR_TIMEOUT_MS }) },
          recallPreview: function (workspace) { return request(API_BASE + '/recall-preview' + (workspace ? '?workspace=' + encodeURIComponent(workspace) : '')) },
          duplicates: function (params) { return request(API_BASE + '/duplicates' + buildEntriesQuery({ scope: (params && params.scope) || 'all', workspace: params && params.workspace })) },
          mergeDuplicates: function (input) { return post(API_BASE + '/duplicates/merge', input) },
          archive: function (input) { return post(API_BASE + '/archive', input) },
          skills: function (params) { return request(API_BASE + '/skills' + buildEntriesQuery({ status: params && params.status })) },
          approveSkill: function (input) { return post(API_BASE + '/skills/approve', input) },
          rejectSkill: function (input) { return post(API_BASE + '/skills/reject', input) },
          rollbackSkill: function (input) { return post(API_BASE + '/skills/rollback', input) },
          learning: function (workspace) { return request(API_BASE + '/learning' + (workspace ? '?workspace=' + encodeURIComponent(workspace) : '')) },
          approveLearning: function (input) { return post(API_BASE + '/learning/approve', input).then(unwrapResult) },
          rejectLearning: function (input) { return post(API_BASE + '/learning/reject', input).then(unwrapResult) },
          approveLearningMany: function (input) { return post(API_BASE + '/learning/approve-many', input).then(unwrapResult) },
          rejectLearningMany: function (input) { return post(API_BASE + '/learning/reject-many', input).then(unwrapResult) },
          digest: function () { return request(API_BASE + '/digest') },
          export: function (params) { return request(API_BASE + '/export' + buildEntriesQuery(params || {}), { timeoutMs: EXPORT_TIMEOUT_MS }) },
          settings: function () { return request(API_BASE + '/settings') },
          saveSettings: function (input) { return post(API_BASE + '/settings', input).then(unwrapResult) },
          resetSettings: function () { return post(API_BASE + '/settings/reset', {}).then(unwrapResult) },
          backup: function () { return post(API_BASE + '/backup', {}, EXPORT_TIMEOUT_MS) },
          save: function (input) { return post(API_BASE + '/save', input) },
          update: function (input) { return post(API_BASE + '/update', input) },
          forget: function (input) { return post(API_BASE + '/forget', input) },
          forgetMany: function (input) { return post(API_BASE + '/forget', input) },
          import: function (input) { return post(API_BASE + '/import', input, IMPORT_TIMEOUT_MS) },
        }
      }

      // ===== 组件 =====

      function NavIcon(props) {
        var size = (props && props.size) || 18
        return h('svg', { className: 'dm_nav_icon', width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true },
          h('g', { stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
            h('path', { d: 'M14 10.5V7' }), h('path', { d: 'M22 10.5V7' }),
            h('path', { d: 'M14 25.5V29' }), h('path', { d: 'M22 25.5V29' }),
            h('path', { d: 'M10.5 14H7' }), h('path', { d: 'M10.5 22H7' }),
            h('path', { d: 'M25.5 14H29' }), h('path', { d: 'M25.5 22H29' })),
          h('rect', { x: 10.5, y: 10.5, width: 15, height: 15, rx: 3.5, stroke: 'currentColor', strokeWidth: 2.4 }),
          h('path', { d: 'M18 13.8C18.5 16 19.9 17.5 22.2 18C19.9 18.5 18.5 20 18 22.2C17.5 20 16.1 18.5 13.8 18C16.1 17.5 17.5 16 18 13.8Z', fill: 'currentColor' }))
      }

      // 空态图标（简单线性插画，替代星座装饰）。
      function EmptyArt(props) {
        var size = props.small ? 88 : 120
        return h('svg', { className: 'dm_empty_art', width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 6, y: 8, width: 36, height: 32, rx: 3, style: { stroke: 'currentColor' }, strokeWidth: 1.6, opacity: 0.5 }),
          h('path', { d: 'M6 16h36', style: { stroke: 'currentColor' }, strokeWidth: 1.6, opacity: 0.5 }),
          h('path', { d: 'M13 24h22M13 30h15', style: { stroke: 'currentColor' }, strokeWidth: 1.6, opacity: 0.35 }))
      }

      function Skeletons() {
        return h('div', { 'aria-hidden': true }, [0, 1, 2].map(function (i) {
          return h('div', { className: 'dm_skel', key: i },
            h('div', { className: 'dm_skel_line', style: { width: '32%' } }),
            h('div', { className: 'dm_skel_line', style: { width: '86%' } }),
            h('div', { className: 'dm_skel_line', style: { width: '64%', marginBottom: 0 } }))
        }))
      }

      function Badge(props) {
        var meta = CATEGORY_META[props.category] || CATEGORY_META.fact
        return h('span', { className: 'dm_badge', style: catVars(props.category) },
          h(Icon, { name: meta.icon, size: 12, strokeWidth: 2 }), props.t(meta.label))
      }

      function MemoryCard(props) {
        var entry = props.entry
        var t = props.t
        var meta = CATEGORY_META[entry.category] || CATEGORY_META.fact
        var origin = originOf(entry)
        var status = statusOf(entry)
        var expandedState = useState(false)
        var expanded = expandedState[0]; var setExpanded = expandedState[1]
        function toggle() { setExpanded(!expanded) }
        function copyId() {
          copyText(entry.id).then(function () { props.onToast(t('copied'), 'ok') }, function () { props.onToast(t('copyFailed'), 'error') })
        }
        var checked = props.selected
        return h('div', {
          className: 'dm_card' + (checked ? ' dm_card_selected' : '') + (status !== 'active' ? ' dm_card_muted' : '') + (expanded ? ' dm_card_expanded' : ''),
          style: Object.assign({}, catVars(entry.category), { animationDelay: (props.index % 10) * 35 + 'ms' }),
        },
          h('div', { className: 'dm_rail' }),
          h('label', { className: 'dm_check' },
            h('input', {
              type: 'checkbox', checked: checked, 'aria-label': t('selectEntryLabel').replace('{c}', String(entry.content || '').slice(0, 30)),
              onChange: function () { props.onToggleSelect(entry.id) },
            })),
          h('div', { className: 'dm_medal' }, h(Icon, { name: meta.icon, size: 17, strokeWidth: 1.9 })),
          h('div', { className: 'dm_card_main' },
            h('div', { className: 'dm_card_top' },
              h(Badge, { category: entry.category, t: t }),
              h('span', { className: 'dm_origin dm_origin_' + origin, title: t('originLabel') + t('labelSep') + t(origin === 'auto' ? 'originAuto' : 'originManual') },
                h(Icon, { name: origin === 'auto' ? 'zap' : 'edit', size: 10, strokeWidth: 2.2 }),
                t(origin === 'auto' ? 'originAuto' : 'originManual')),
              status !== 'active' ? h('span', { className: 'dm_status dm_status_' + status },
                h(Icon, { name: status === 'superseded' ? 'link' : status === 'expired' ? 'clock' : 'archive', size: 10, strokeWidth: 2.2 }),
                t(status === 'superseded' ? 'statusSuperseded' : status === 'expired' ? 'statusExpired' : 'statusArchived'),
                status === 'expired' && entry.expires ? ' · ' + entry.expires : null) : null,
              status === 'superseded' && entry.superseded_by ? h('button', {
                className: 'dm_successor', title: t('jumpToSuccessor') + t('labelSep') + entry.superseded_by,
                onClick: function () { props.onJumpTo(entry.superseded_by) },
              }, h(Icon, { name: 'chevR', size: 11, strokeWidth: 2.2 }), t('viewSuccessor')) : null,
              entry.pinned && status === 'active' ? h('span', { className: 'dm_pinned_mark', title: t('pinnedLabel') },
                h(Icon, { name: 'pin', size: 12, style: { fill: 'currentColor' } })) : null,
              props.injected && status === 'active' ? h('span', { className: 'dm_injected_mark', title: t('injectedTitle') },
                h(Icon, { name: 'checkCircle', size: 11 }), t('injectedLabel')) : null,
              h('span', { className: 'dm_scope_chip' },
                h(Icon, { name: entry.scope === 'global' ? 'globe' : 'folder', size: 12 }),
                entry.scope === 'global' ? t('scopeGlobal') : t('scopeWorkspace')),
              h('span', { className: 'dm_time', title: formatTime(entry.updated) },
                h(Icon, { name: 'clock', size: 11, style: { verticalAlign: '-1px', marginRight: 3 } }),
                props.useRelative === false ? formatTime(entry.updated) : relativeTime(entry.updated, Date.now(), uiLang()))),
            h('div', {
              className: 'dm_content' + (expanded ? ' dm_content_open' : ''),
              title: entry.content,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': expanded,
              onClick: toggle,
              onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
            }, entry.content),
            expanded
              ? h('div', { className: 'dm_details' },
                entryDetailRows(entry).map(function (row) {
                  var text = row.key === 'originLabel' ? t(row.value === 'auto' ? 'originAuto' : 'originManual')
                    : DETAIL_TEXT_KEYS[row.key] ? row.value : formatTime(row.value)
                  var isLink = row.key === 'supersedesLabel' || row.key === 'supersededByLabel'
                  return h('div', { className: 'dm_details_row', key: row.key },
                    h('span', { className: 'dm_details_k' }, t(row.key) + t('labelSep')),
                    isLink
                      ? h('button', { className: 'dm_details_link', title: t('jumpToEntry') + t('labelSep') + row.value, onClick: function () { props.onJumpTo(row.value) } }, text, h(Icon, { name: 'chevR', size: 11, strokeWidth: 2.2 }))
                      : h('span', { className: 'dm_details_v' }, text))
                }),
                h('div', null, h('button', { className: 'dm_btn dm_btn_mini', onClick: copyId }, h(Icon, { name: 'copy', size: 12 }), t('copyId'))))
              : null,
            h('div', { className: 'dm_card_foot' },
              (entry.tags || []).map(function (tag) {
                return h('button', {
                  className: 'dm_tag', key: tag, title: t('tagSearch'),
                  onClick: function () { props.onTagClick(tag) },
                }, '#' + tag)
              }),
              h('span', { className: 'dm_id' }, entry.id))),
          h('div', { className: 'dm_card_actions' },
            h('button', {
              className: 'dm_btn' + (entry.pinned ? ' dm_btn_pinned' : ''), 'aria-pressed': !!entry.pinned,
              disabled: !!props.busy, title: entry.pinned ? t('unpin') : t('pin'), 'aria-label': entry.pinned ? t('unpin') : t('pin'),
              onClick: function () { props.onTogglePin(entry) },
            }, h(Icon, { name: 'pin', size: 14, style: entry.pinned ? { fill: 'currentColor' } : null }), h('span', { className: 'dm_act_label' }, entry.pinned ? t('unpin') : t('pin'))),
            h('button', { className: 'dm_btn', disabled: !!props.busy, title: entry.archived ? t('restore') : t('archive'), 'aria-label': entry.archived ? t('restore') : t('archive'), onClick: function () { props.onToggleArchive(entry) } },
              h(Icon, { name: 'archive', size: 14 }), h('span', { className: 'dm_act_label' }, entry.archived ? t('restore') : t('archive'))),
            h('button', { className: 'dm_btn', disabled: !!props.busy, title: t('edit'), 'aria-label': t('edit'), onClick: function () { props.onEdit(entry) } }, h(Icon, { name: 'edit', size: 14 }), h('span', { className: 'dm_act_label' }, t('edit'))),
            h('button', { className: 'dm_btn dm_btn_danger', disabled: !!props.busy, title: t('del'), 'aria-label': t('del'), onClick: function () { props.onDelete(entry) } }, h(Icon, { name: 'trash', size: 14 }), h('span', { className: 'dm_act_label' }, t('del')))))
      }

      // 焦点陷阱 + 焦点归还；busy 时禁止 Escape/遮罩关闭；回调经 ref 稳定。
      function Modal(props) {
        var dialogRef = useRef(null)
        var wasBusyRef = useRef(props.busy)
        var onCloseRef = useRef(props.onClose)
        onCloseRef.current = props.onClose
        var busyRef = useRef(props.busy)
        busyRef.current = props.busy
        useEffect(function () {
          var previous = document.activeElement
          var dialog = dialogRef.current
          function focusables() {
            if (!dialog) return []
            var nodes = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
            return Array.prototype.filter.call(nodes, function (el) { return !el.disabled })
          }
          var items = focusables()
          if (items.length > 0) items[0].focus()
          else if (dialog) dialog.focus()
          function onKey(e) {
            if (e.key === 'Escape') {
              // 下拉浮层自己消费 Esc（关下拉、保留弹窗草稿）：浮层 portal 在 body，
              // 冒泡到这里的原生事件可能已 defaultPrevented，或 target 落在浮层内。
              if (e.defaultPrevented) return
              var t = e.target
              if (t && t.closest && t.closest('.dm_select_pop')) return
              if (!busyRef.current) onCloseRef.current()
              return
            }
            if (e.key !== 'Tab') return
            var list = focusables()
            // busy 时控件全部 disabled：把焦点留在对话框内，不放去背景页。
            if (list.length === 0) { e.preventDefault(); if (dialog) dialog.focus(); return }
            if (!dialog.contains(document.activeElement)) { e.preventDefault(); list[0].focus(); return }
            var first = list[0]
            var last = list[list.length - 1]
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          }
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('keydown', onKey)
            // 触发按钮可能已随列表刷新卸载：归还焦点失败时退回面板容器。
            if (previous && previous.focus && document.contains(previous)) { previous.focus(); return }
            var page = document.querySelector('.dm_page')
            if (page) { page.setAttribute('tabindex', '-1'); page.focus() }
          }
        }, [])
        // busy 结束后若焦点因控件被禁用而掉到 body（保存失败 / 审计弹窗操作后）：
        // 把焦点送回弹窗，而不是让键盘用户从页面开头重新 Tab。
        useEffect(function () {
          var was = wasBusyRef.current
          wasBusyRef.current = props.busy
          if (!was || props.busy) return
          var dialog = dialogRef.current
          if (!dialog) return
          var active = document.activeElement
          if (active && active !== document.body && dialog.contains(active)) return
          var nodes = dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
          var items = Array.prototype.filter.call(nodes, function (el) { return !el.disabled })
          if (items.length > 0) items[0].focus()
          else dialog.focus()
        }, [props.busy])
        return h('div', {
          className: 'dm_overlay',
          onClick: function (e) { if (!busyRef.current && e.target === e.currentTarget) onCloseRef.current() },
        }, h('div', { className: 'dm_dialog', role: 'dialog', 'aria-modal': true, 'aria-label': props.title, ref: dialogRef, tabIndex: -1 }, props.children))
      }

      function EditorModal(props) {
        var t = props.t
        var draft = props.draft
        var setDraft = props.setDraft
        var isCreate = draft.mode === 'create'
        var workspaceTarget = props.workspaceTarget
        function field(key, value) {
          var patch = {}
          patch[key] = value
          setDraft(Object.assign({}, draft, patch))
        }
        function onKeySave(e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); props.onSave() }
        }
        // 分类 radiogroup：←/→/↑/↓ 循环切换、Home/End 跳转（WAI-ARIA radiogroup 模式）。
        function onCategoryKey(e) {
          var order = ['preference', 'fact', 'decision']
          var idx = order.indexOf(draft.category)
          if (idx === -1) idx = 0
          var next = null
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(idx + 1) % order.length]
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = order[(idx + order.length - 1) % order.length]
          else if (e.key === 'Home') next = order[0]
          else if (e.key === 'End') next = order[order.length - 1]
          if (next === null) return
          e.preventDefault()
          field('category', next)
          var buttons = e.currentTarget.querySelectorAll('[role="radio"]')
          var target = buttons[order.indexOf(next)]
          if (target) target.focus()
        }
        return h(Modal, { title: isCreate ? t('editorCreate') : t('editorEdit'), onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_primary' }, h(Icon, { name: isCreate ? 'plus' : 'edit', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, isCreate ? t('editorCreate') : t('editorEdit'))),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-content' }, h(Icon, { name: 'edit', size: 13 }), t('contentLabel')),
            h('textarea', { id: 'dm-content', className: 'dm_textarea', disabled: props.busy, value: draft.content, onChange: function (e) { field('content', e.target.value) }, onKeyDown: onKeySave }),
            h('div', { className: 'dm_charcount' }, t('contentCount').replace('{n}', String(draft.content.length)))),
          h('div', { className: 'dm_field' },
            h('span', { className: 'dm_label' }, h(Icon, { name: 'tag', size: 13 }), t('categoryLabel')),
            h('div', { className: 'dm_catgrid', role: 'radiogroup', 'aria-label': t('categoryLabel'), onKeyDown: onCategoryKey },
              ['preference', 'fact', 'decision'].map(function (cat) {
                var meta = CATEGORY_META[cat]
                return h('button', {
                  key: cat, type: 'button', role: 'radio', 'aria-checked': draft.category === cat,
                  tabIndex: draft.category === cat ? 0 : -1,
                  className: 'dm_catopt', style: catVars(cat), disabled: props.busy,
                  onClick: function () { field('category', cat) },
                }, h(Icon, { name: meta.icon, size: 15, strokeWidth: 2 }), t(meta.label))
              }))),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-scope' }, h(Icon, { name: 'layers', size: 13 }), t('scopeLabel')),
            h(Select, {
              id: 'dm-scope', ariaLabel: t('scopeLabel'), disabled: props.busy, value: draft.scope,
              onChange: function (v) { field('scope', v) },
              options: [
                { value: 'global', label: t('scopeGlobal'), icon: 'globe' },
                workspaceTarget ? { value: 'workspace', label: t('scopeWorkspace') + ' — ' + workspaceTarget, icon: 'folder' } : null,
                !workspaceTarget && draft.scope === 'workspace' ? { value: 'workspace', label: t('scopeWorkspace'), icon: 'folder', disabled: true } : null,
              ].filter(Boolean),
            }),
            draft.scope === 'workspace' && workspaceTarget
              ? h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('workspaceTarget') + t('labelSep') + workspaceTarget)
              : null),
          !isCreate ? h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-origin' }, h(Icon, { name: 'zap', size: 13 }), t('originLabel')),
            h(Select, {
              id: 'dm-origin', ariaLabel: t('originLabel'), disabled: props.busy, value: draft.origin || 'manual',
              onChange: function (v) { field('origin', v) },
              options: [
                { value: 'manual', label: t('originManual'), icon: 'edit' },
                { value: 'auto', label: t('originAuto'), icon: 'zap' },
              ],
            }),
            h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('originEditHint'))) : null,
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-tags' }, h(Icon, { name: 'tag', size: 13 }), t('tagsLabel')),
            h('input', { id: 'dm-tags', className: 'dm_input', disabled: props.busy, value: draft.tags, onChange: function (e) { field('tags', e.target.value) }, onKeyDown: onKeySave }),
            (function () {
              var tags = parseTags(draft.tags)
              var atLimit = tags.length >= TAG_MAX_COUNT
              return h('div', { className: 'dm_charcount' + (atLimit ? ' dm_charcount_limit' : '') },
                t('tagsCount').replace('{n}', String(tags.length)).replace('{max}', String(TAG_MAX_COUNT)) + (atLimit ? ' · ' + t('tagsLimit') : ''))
            })()),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-expires' }, h(Icon, { name: 'clock', size: 13 }), t('expiresLabel')),
            h('div', { className: 'dm_expiresrow' },
              h('input', {
                id: 'dm-expires', className: 'dm_input dm_dateinput', type: 'date', disabled: props.busy,
                min: todayUtcIso(),
                value: draft.expires || '', onChange: function (e) { field('expires', e.target.value) },
              }),
              draft.expires
                ? h('button', { type: 'button', className: 'dm_btn dm_btn_mini', disabled: props.busy, onClick: function () { field('expires', '') } },
                  h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 }), t('expiresClear'))
                : null),
            h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('expiresHint'))),
          h('div', { className: 'dm_field' },
            h('span', { className: 'dm_label' }, h(Icon, { name: 'pin', size: 13 }), t('pinnedLabel')),
            h('div', { className: 'dm_pinrow' },
              h('span', { className: 'dm_hint' }, t('pinnedHint')),
              h(Toggle, { checked: !!draft.pinned, onChange: function (v) { field('pinned', v) }, label: t('pinnedLabel'), disabled: props.busy }))),
          h('div', { className: 'dm_dialog_footer' },
            h('span', { className: 'dm_hint' }, props.busy ? t('saving') : t('editorHint')),
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_primary', onClick: props.onSave, disabled: props.busy }, h(Icon, { name: 'check', size: 14, strokeWidth: 2.2 }), t('save'))))
      }

      function ConfirmModal(props) {
        var t = props.t
        var entries = props.entries
        var bulk = entries.length > 1
        var title = bulk ? t('bulkDeleteTitle').replace('{n}', String(entries.length)) : t('deleteTitle')
        return h(Modal, { title: title, onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_danger' }, h(Icon, { name: 'trash', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, title)),
          h('div', { className: 'dm_delete_preview' },
            entries.slice(0, 3).map(function (e, i) {
              return h('div', { key: e.id, style: i > 0 ? { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dm-line)' } : null }, e.content)
            }),
            entries.length > 3 ? h('div', { className: 'dm_hint', style: { marginTop: 8 } }, '… +' + (entries.length - 3)) : null),
          h('div', { className: 'dm_hint' }, t('deleteHint')),
          h('div', { className: 'dm_dialog_footer' },
            h('span', { className: 'dm_hint', style: { marginRight: 'auto' } }, props.busy ? t('deleting') : ''),
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_danger_solid', onClick: props.onConfirm, disabled: props.busy }, h(Icon, { name: 'trash', size: 14 }), t('del'))))
      }

      function ImportModal(props) {
        var t = props.t
        var summary = importSummary(props.plan)
        var rejected = (props.plan && props.plan.rejected) || []
        var merge = props.mode === 'merge'
        return h(Modal, { title: t('importTitle'), onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_primary' }, h(Icon, { name: 'import', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, t('importTitle'))),
          h('label', { className: 'dm_import_merge' },
            h('input', { type: 'checkbox', checked: merge, disabled: props.busy, onChange: function (e) { props.onModeChange(e.target.checked ? 'merge' : 'skip') } }),
            h('span', null, t('importMergeLabel'))),
          h('div', { className: 'dm_import_tiles' },
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-primary)' } }, summary.imported), h('div', { className: 'dm_tile_label' }, t('importNew'))),
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-success)' } }, summary.updated), h('div', { className: 'dm_tile_label' }, t('importUpdated'))),
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-ink3)' } }, summary.deduplicated), h('div', { className: 'dm_tile_label' }, t('importDup'))),
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-danger)' } }, summary.rejected), h('div', { className: 'dm_tile_label' }, t('importRej'))),
            // 预演阶段就展示将修复的取代指针数（落盘后只在完成吐司里出现，用户无法预先判断）。
            summary.repaired > 0
              ? h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-pref)' } }, summary.repaired), h('div', { className: 'dm_tile_label' }, t('importRepaired').replace('{n}', String(summary.repaired))))
              : null),
          rejected.length > 0
            ? h('div', { className: 'dm_hint' },
              t('importRejHint'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                rejected.slice(0, 5).map(function (r, i) {
                  return h('li', { key: i }, '#' + (r.index + 1) + ' ' + importRejectText(r, t))
                }),
                rejected.length > 5 ? h('li', { key: 'more' }, '… +' + (rejected.length - 5)) : null))
            : null,
          summary.imported === 0 && summary.updated === 0 && summary.deduplicated > 0
            ? h('div', { className: 'dm_hint', style: { marginTop: 8 } }, t('importAllDup'))
            : null,
          h('div', { className: 'dm_dialog_footer' },
            props.progress
              ? h('span', { className: 'dm_hint', role: 'status' }, t(props.progress.preview ? 'previewingProgress' : 'importingProgress').replace('{d}', String(props.progress.done)).replace('{t}', String(props.progress.total)))
              : null,
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            // 预演期同样可停止（预演无写盘，安全）。
            props.busy && (props.confirming || props.previewing) && props.onStop ? h('button', { className: 'dm_btn dm_btn_mini dm_linkbtn', onClick: props.onStop }, t('stopImport')) : null,
            h('button', { className: 'dm_btn dm_btn_primary', onClick: props.onConfirm, disabled: props.busy || (summary.imported === 0 && summary.updated === 0) }, h(Icon, { name: 'check', size: 14, strokeWidth: 2.2 }), t('importConfirm'))))
      }

      function AuditModal(props) {
        var t = props.t
        var pairs = props.pairs || []
        return h(Modal, { title: t('auditTitle'), onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_primary' }, h(Icon, { name: 'copy', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, t('auditTitle'))),
          h('div', { className: 'dm_hint', style: { marginBottom: 12 } }, t('auditHint')),
          pairs.length === 0
            ? h('div', { className: 'dm_empty', style: { padding: '24px 0' } },
              h(Icon, { name: 'checkCircle', size: 28, style: { color: 'var(--dm-success)', marginBottom: 10 } }),
              h('div', null, t('auditEmpty')))
            : h('div', { className: 'dm_audit_list' },
              pairs.map(function (p) {
                return h('div', { key: p.older.id + '-' + p.newer.id, className: 'dm_audit_pair' },
                  h('div', { className: 'dm_audit_score' }, t('auditScore') + ' ' + Math.round(p.score * 100) + '%'),
                  h('div', { className: 'dm_audit_side' },
                    h('span', { className: 'dm_audit_tag' }, t('auditOlder')),
                    h('span', { className: 'dm_audit_content' }, p.older.content)),
                  h('div', { className: 'dm_audit_side' },
                    h('span', { className: 'dm_audit_tag dm_audit_tag_new' }, t('auditNewer')),
                    h('span', { className: 'dm_audit_content' }, p.newer.content)),
                  h('div', { className: 'dm_audit_actions' },
                    h('button', { className: 'dm_btn dm_btn_mini', onClick: function () { props.onDismiss(p) }, disabled: props.busy }, t('auditDismiss')),
                    h('button', { className: 'dm_btn dm_btn_mini dm_btn_primary', onClick: function () { props.onSupersede(p) }, disabled: props.busy }, h(Icon, { name: 'check', size: 12, strokeWidth: 2.2 }), t('auditSupersede'))))
              })),
          h('div', { className: 'dm_dialog_footer' },
            h('span', { className: 'dm_hint' }, pairs.length > 0 ? t('auditCount').replace('{n}', String(pairs.length)) : ''),
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel'))))
      }

      function Toast(props) {
        var toast = props.toast
        var t = props.t
        var kind = toast.kind === 'error' ? 'error' : toast.kind === 'info' ? 'info' : 'ok'
        return h('div', {
          key: toast.id,
          className: 'dm_toast dm_toast_' + kind + (props.raised ? ' dm_toast_raised' : ''),
          role: toast.kind === 'error' ? 'alert' : 'status',
          // 悬停/聚焦时暂停倒计时：用户正要撤销时入口不会突然消失。
          onMouseEnter: props.onPause,
          onMouseLeave: props.onResume,
          onFocusCapture: props.onPause,
          onBlurCapture: function (e) {
            if (!e.currentTarget.contains(e.relatedTarget)) props.onResume()
          },
        },
          h('span', { className: 'dm_toast_icon' }, h(Icon, { name: toast.kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check', size: 14, strokeWidth: 2.2 })),
          h('span', { className: 'dm_toast_text' }, toast.text),
          toast.action ? h('button', { ref: props.actionRef, className: 'dm_toast_action', onClick: function () { toast.action.run() } }, h(Icon, { name: 'undo', size: 13, strokeWidth: 2.2, style: { verticalAlign: '-2px', marginRight: 4 } }), toast.action.label) : null,
          h('button', { className: 'dm_toast_close', 'aria-label': t('closeToast'), onClick: props.onClose }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 })),
          h('span', { className: 'dm_toast_bar', style: { animationDuration: (toast.duration || 2600) + 'ms' } }))
      }

      function Toggle(props) {
        return h('button', {
          type: 'button', role: 'switch', 'aria-checked': props.checked, 'aria-label': props.label,
          className: 'dm_switch' + (props.checked ? ' dm_switch_on' : ''),
          disabled: props.disabled, onClick: function () { props.onChange(!props.checked) },
        }, h('span', { className: 'dm_switch_knob' }))
      }

      function Slider(props) {
        // 拖动期只更新本地值，松手/失焦/按键抬起才提交：避免 600ms 防抖期间每帧
        // setDraft 触发整页（含常驻记忆列表）重渲染。
        var localState = useState(null)
        var local = localState[0]; var setLocal = localState[1]
        var shown = local === null ? props.value : local
        function commit(value) {
          setLocal(null)
          if (value !== props.value) props.onChange(value)
        }
        return h('div', { className: 'dm_slider_row' },
          h('input', {
            type: 'range', className: 'dm_range', min: props.min, max: props.max, step: props.step || 1,
            value: shown, 'aria-label': props.label, disabled: props.disabled,
            onChange: function (e) { setLocal(Number(e.target.value)) },
            onPointerUp: function (e) { commit(Number(e.target.value)) },
            onKeyUp: function (e) { commit(Number(e.target.value)) },
            onBlur: function (e) { commit(Number(e.target.value)) },
          }),
          h('span', { className: 'dm_slider_val' }, shown))
      }

      function SettingRow(props) {
        return h('div', { className: 'dm_setrow' },
          h('div', { className: 'dm_setrow_text' },
            h('div', { className: 'dm_setrow_label' }, props.label),
            props.desc ? h('div', { className: 'dm_setrow_desc' }, props.desc) : null),
          h('div', { className: 'dm_setrow_ctrl' }, props.children))
      }

      function SettingsGroup(props) {
        return h('section', { className: 'dm_setgroup' },
          h('div', { className: 'dm_setgroup_head' },
            h('span', { className: 'dm_setgroup_icon' }, h(Icon, { name: props.icon, size: 15, strokeWidth: 1.9 })),
            h('h3', { className: 'dm_setgroup_title' }, props.title)),
          h('div', { className: 'dm_setgroup_body' }, props.children))
      }

      function DuplicatesModal(props) {
        var t = props.t
        var groups = props.groups || []
        var plan = duplicatePlanSummary(groups)
        return h(Modal, { title: t('duplicatesTitle'), onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_primary' }, h(Icon, { name: 'copy', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, t('duplicatesTitle'))),
          h('div', { className: 'dm_hint', style: { marginBottom: 12 } }, t('duplicatesHint')),
          groups.length === 0
            ? h('div', { className: 'dm_empty', style: { padding: '24px 0' } },
              h(Icon, { name: 'checkCircle', size: 28, style: { color: 'var(--dm-success)', marginBottom: 10 } }),
              h('div', null, t('duplicatesEmpty')))
            : h('div', null,
              h('div', { className: 'dm_hint', 'data-testid': 'dm-duplicates-summary' },
                t('duplicatesSummary').replace('{g}', String(plan.groups)).replace('{m}', String(plan.mergeable)).replace('{r}', String(plan.reportOnly))),
              h('div', { className: 'dm_audit_list', style: { marginTop: 10 } },
                groups.slice(0, 30).map(function (group) {
                  var entries = Array.isArray(group.entries) ? group.entries : []
                  return h('div', { key: group.key, className: 'dm_audit_pair' },
                    h('div', { className: 'dm_audit_score' }, group.mergeable ? t('duplicatesMergeable') : t('duplicatesReportOnly')),
                    h('div', { className: 'dm_audit_side' },
                      h('span', { className: 'dm_audit_tag' }, t('duplicatesCount').replace('{n}', String(entries.length))),
                      h('span', { className: 'dm_audit_content' }, group.content)),
                    h('div', { className: 'dm_audit_side' },
                      h('span', { className: 'dm_audit_tag dm_audit_tag_new' }, t('duplicatesKeeper').replace('{id}', String(group.keeperId)))),
                    group.mergeable ? null : h('div', { className: 'dm_hint', style: { marginTop: 6 } }, t('duplicatesMismatch')))
                })),
              groups.length > 30 ? h('div', { className: 'dm_hint' }, '… +' + (groups.length - 30)) : null),
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', {
              className: 'dm_btn dm_btn_primary',
              onClick: props.onMerge,
              disabled: props.busy || plan.mergeable === 0,
              'data-testid': 'dm-duplicates-merge',
            }, h(Icon, { name: 'check', size: 14, strokeWidth: 2.2 }), t('duplicatesMerge').replace('{n}', String(plan.mergeable)))))
      }

      function RecallPreview(props) {
        var t = props.t
        var api = props.api
        var workspace = props.workspace
        var dataState = useState(null)
        var data = dataState[0]; var setData = dataState[1]
        var errState = useState('')
        var err = errState[0]; var setErr = errState[1]
        var busyState = useState(false)
        var busy = busyState[0]; var setBusy = busyState[1]
        var seqRef = useRef(0)
        function load() {
          // seq 守卫：快速切换工作区时旧响应不得覆盖新响应。
          var seq = ++seqRef.current
          setBusy(true)
          api.recallPreview(workspace).then(function (doc) {
            if (seq !== seqRef.current) return
            setData(doc); setErr('')
          }).catch(function (e) {
            if (seq !== seqRef.current) return
            setErr(errorText(e, t))
          }).then(function () {
            if (seq === seqRef.current) setBusy(false)
          })
        }
        // 常驻 tabpanel：隐藏时零请求；切到设置页或设置变化时才拉取召回预览，
// 避免面板初始化/每次保存设置都多一次全量扫描（与主面板注入徽章去重）。
        useEffect(function () {
          if (props.active === false) return
          load()
        }, [workspace, props.refreshKey, props.active])
        var summary = data
          ? t('recallSummary').replace('{injected}', String(data.injected)).replace('{omitted}', String(data.omitted)).replace('{used}', String(data.usedChars)).replace('{budget}', String(data.budgetChars))
          : ''
        var residentEntries = data ? data.entries.filter(function (entry) { return entry.layer === 'resident' }) : []
        var indexEntries = data ? data.entries.filter(function (entry) { return entry.layer !== 'resident' }) : []
        var omittedBudget = data ? (Number(data.omittedResident) || 0) + (Number(data.omittedIndex) || 0) : 0
        var oversized = data ? (Number(data.oversized) || 0) : 0
        function recallItem(entry) {
          var meta = CATEGORY_META[entry.category] || CATEGORY_META.fact
          var text = String(entry.content || '')
          return h('div', { key: entry.id, className: 'dm_recall_item' },
            h('span', { className: 'dm_recall_cat', style: { '--dm-cat': meta.cat } }, t(meta.label)),
            h('span', { className: 'dm_recall_content' }, text.length > 60 ? text.slice(0, 60) + '…' : text),
            entry.layer === 'index' ? h('span', { className: 'dm_hint', style: { marginLeft: 8, fontSize: 10 } }, t('recallIndexBadge')) : null)
        }
        return h('div', { className: 'dm_recall' },
          h('div', { className: 'dm_recall_head' },
            h('span', { className: 'dm_label' }, h(Icon, { name: 'database', size: 13 }), t('recallTitle')),
            h('button', { className: 'dm_btn dm_btn_mini', onClick: load, disabled: busy }, h(Icon, { name: 'undo', size: 12 }), t('recallRefresh'))),
          h('div', { className: 'dm_hint', style: { marginBottom: 6 } }, t('recallHint')),
          err ? h('div', { className: 'dm_hint', style: { color: 'var(--dm-danger)' } }, err)
            : !data ? h('div', { className: 'dm_hint' }, t('recallLoading'))
            : h('div', null,
              h('div', { className: 'dm_hint' }, summary + (data.autoInject ? '' : ' ' + t('recallAutoOff'))),
              h('div', { className: 'dm_hint', 'data-testid': 'dm-recall-layers' },
                t('recallLayers').replace('{r}', String(data.residentCount || 0)).replace('{i}', String(data.indexCount || 0))),
              data.omitted > 0
                ? h('div', { className: 'dm_hint', 'data-testid': 'dm-recall-omitted' },
                  t('recallOmittedReasons').replace('{b}', String(omittedBudget)).replace('{o}', String(oversized)))
                : null,
              residentEntries.length + indexEntries.length > 0
                ? h('div', { className: 'dm_recall_list' },
                  residentEntries.length > 0 ? h('div', { className: 'dm_hint', style: { fontWeight: 600 } }, t('recallResidentTitle')) : null,
                  residentEntries.slice(0, 20).map(recallItem),
                  indexEntries.length > 0 ? h('div', { className: 'dm_hint', style: { fontWeight: 600, marginTop: 6 } }, t('recallIndexTitle')) : null,
                  indexEntries.slice(0, 20).map(recallItem))
                : null))
      }

      function SettingsPage(props) {
        var t = props.t
        var view = props.view
        var draft = props.draft
        if (!view || !draft) {
          // 首次加载失败：显示错误与重试入口，而不是永久骨架。
          if (props.error) {
            return h('div', { className: 'dm_empty', role: 'alert' },
              h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
              h('div', null, t('loadError') + t('labelSep') + props.error),
              h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: props.onRetry }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
          }
          return h(Skeletons)
        }
        var bounds = view.bounds
        var meta = view.meta
        function set(key) { return function (value) { props.onChange(key, value) } }
        function copyPath() {
          copyText(meta.root).then(function () { props.onToast(t('pathCopied'), 'ok') }, function () { props.onToast(t('copyFailed'), 'error') })
        }
        return h('div', { className: 'dm_settings' },
          h(SettingsGroup, { icon: 'layers', title: t('groupInjection') },
            h(SettingRow, { label: t('autoInjectLabel'), desc: t('autoInjectDesc') },
              h(Toggle, { checked: draft.autoInject, onChange: set('autoInject'), label: t('autoInjectLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('autoExtractHintLabel'), desc: t('autoExtractHintDesc') },
              h(Toggle, { checked: draft.autoExtractHint !== false, onChange: set('autoExtractHint'), label: t('autoExtractHintLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('decayEnabledLabel'), desc: t('decayEnabledDesc') },
              h(Toggle, { checked: draft.decayEnabled !== false, onChange: set('decayEnabled'), label: t('decayEnabledLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('budgetLabel'), desc: t('budgetDesc') },
              h(Slider, { min: 0, max: bounds.budgetMax, step: 100, value: draft.injectionBudgetChars, onChange: set('injectionBudgetChars'), label: t('budgetLabel'), disabled: props.busy })),
            h(RecallPreview, { t: t, api: props.api, workspace: props.workspace, refreshKey: settingsSignature(props.view), active: props.active }),
            h('div', { className: 'dm_setnote' }, h(Icon, { name: 'info', size: 14, style: { flexShrink: 0, marginTop: 1 } }), t('priorityNote')),
            h('div', { className: 'dm_setnote' }, h(Icon, { name: 'info', size: 14, style: { flexShrink: 0, marginTop: 1 } }), t('enabledNote'))),
          // 学习设置组（U1）：服务端早已校验 autoLearn/conflictAlert/digest，此前面板缺控件，
          // 用户只能手改 settings.json。嵌套键整体替换草稿对象，走统一防抖保存。
          h(SettingsGroup, { icon: 'zap', title: t('groupLearning') },
            h(SettingRow, { label: t('autoLearnLabel'), desc: t('autoLearnDesc') },
              h(Slider, {
                min: bounds.autoWritesMin, max: bounds.autoWritesMax, step: 1,
                value: (draft.autoLearn && typeof draft.autoLearn.maxWritesPerSession === 'number') ? draft.autoLearn.maxWritesPerSession : bounds.autoWritesMax,
                onChange: function (v) { props.onChange('autoLearn', { maxWritesPerSession: v }) },
                label: t('autoLearnLabel'), disabled: props.busy,
              })),
            h(SettingRow, { label: t('conflictAlertLabel'), desc: t('conflictAlertDesc') },
              h(Toggle, { checked: draft.conflictAlert !== false, onChange: set('conflictAlert'), label: t('conflictAlertLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('digestLabel'), desc: t('digestDesc') },
              h(Toggle, { checked: !(draft.digest && draft.digest.enabled === false), onChange: function (v) { props.onChange('digest', Object.assign({}, draft.digest, { enabled: v })) }, label: t('digestLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('digestWeekdayLabel'), desc: t('digestWeekdayDesc') },
              h(Select, {
                className: 'dm_setselect', value: String((draft.digest && draft.digest.weekday) || 1), ariaLabel: t('digestWeekdayLabel'), disabled: props.busy, minWidth: 140,
                onChange: function (v) { props.onChange('digest', Object.assign({}, draft.digest, { weekday: Number(v) })) },
                options: (bounds.digestWeekdays || [1, 2, 3, 4, 5, 6, 7]).map(function (n) { return { value: String(n), label: t('weekday' + n) } }),
              }))),
          h(SettingsGroup, { icon: 'lock', title: t('groupPrivacy') },
            h('div', { className: 'dm_guard' },
              h('span', { className: 'dm_guard_icon' }, h(Icon, { name: 'checkCircle', size: 22, strokeWidth: 1.9 })),
              h('div', null,
                h('div', { className: 'dm_guard_title' }, t('privacyLabel')),
                h('div', { className: 'dm_guard_desc' }, t('privacyDesc'))))),
          h(SettingsGroup, { icon: 'database', title: t('groupStorage') },
            h(SettingRow, { label: t('dataRootLabel') },
              h('div', { className: 'dm_pathrow' },
                h('span', { className: 'dm_path' }, meta.root),
                h('button', { className: 'dm_btn dm_btn_mini', onClick: copyPath }, h(Icon, { name: 'copy', size: 12 }), t('copyPath')))),
            h(SettingRow, { label: t('storageUsageLabel') },
              h('span', { className: 'dm_slider_val' }, formatBytes(meta.storage.bytes) + ' · ' + t('storageEntries').replace('{n}', String(meta.storage.entries)))),
            h(SettingRow, { label: t('autoBackupLabel'), desc: t('autoBackupDesc') },
              h(Toggle, { checked: draft.autoBackup, onChange: set('autoBackup'), label: t('autoBackupLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('retentionLabel'), desc: t('retentionDesc') },
              h('input', {
                type: 'number', className: 'dm_numinput', min: bounds.retentionMin, max: bounds.retentionMax,
                value: draft.backupRetention, 'aria-label': t('retentionLabel'), disabled: props.busy,
                // 输入即夹取到服务端允许区间，避免「显示 0、实际存 1」的错位。
                onChange: function (e) {
                  var n = Number(e.target.value)
                  if (!isFinite(n)) return
                  var clamped = Math.min(bounds.retentionMax, Math.max(bounds.retentionMin, Math.round(n)))
                  props.onChange('backupRetention', clamped)
                },
              })),
            h('div', { className: 'dm_backupmeta' },
              h('span', null, t('lastBackupLabel') + t('labelSep') + (meta.backup.lastBackup ? formatTime(meta.backup.lastBackup) : t('neverBackup'))),
              h('span', null, t('backupCount').replace('{n}', String(meta.backup.count))),
              h('button', { className: 'dm_btn dm_btn_mini', onClick: props.onBackup, disabled: props.busy || (props.status && props.status.saving) }, h(Icon, { name: 'export', size: 12 }), t('backupNow')))),
          h(SettingsGroup, { icon: 'sliders', title: t('groupPanel') },
            h(SettingRow, { label: t('defaultViewLabel') },
              h(Select, {
                className: 'dm_setselect', value: draft.defaultView, ariaLabel: t('defaultViewLabel'), disabled: props.busy, minWidth: 200,
                onChange: function (v) { props.onChange('defaultView', v) },
                options: [
                  { value: 'all', label: t('viewAll'), icon: 'layers' },
                  { value: 'global', label: t('viewGlobal'), icon: 'globe' },
                  { value: 'workspace', label: t('viewWorkspace'), icon: 'folder' },
                ],
              })),
            h(SettingRow, { label: t('pageSizeLabel') },
              h(Select, {
                className: 'dm_setselect', value: String(draft.pageSize), ariaLabel: t('pageSizeLabel'), disabled: props.busy, minWidth: 120,
                onChange: function (v) { props.onChange('pageSize', Number(v)) },
                options: bounds.pageSizes.map(function (n) { return { value: String(n), label: String(n) } }),
              })),
            h(SettingRow, { label: t('animationsLabel'), desc: t('animationsDesc') },
              h(Toggle, { checked: draft.animations, onChange: set('animations'), label: t('animationsLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('relativeTimeLabel'), desc: t('relativeTimeDesc') },
              h(Toggle, { checked: draft.relativeTime, onChange: set('relativeTime'), label: t('relativeTimeLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('viewModeLabel'), desc: t('viewModeDesc') },
              h(Select, {
                className: 'dm_setselect', value: draft.viewMode || 'comfortable', ariaLabel: t('viewModeLabel'), disabled: props.busy, minWidth: 160,
                onChange: function (v) { props.onChange('viewMode', v) },
                options: [
                  { value: 'comfortable', label: t('viewComfortable'), icon: 'viewList' },
                  { value: 'compact', label: t('viewCompact'), icon: 'viewCompact' },
                ],
              }))),
          h('div', { className: 'dm_setfooter' },
            h('button', { className: 'dm_btn dm_btn_danger', onClick: props.onReset, disabled: props.busy || (props.status && props.status.saving) }, h(Icon, { name: 'undo', size: 14 }), t('resetDefaults')),
            h('span', { className: 'dm_savestate', role: 'status' },
              (props.status && props.status.saving) ? h(Icon, { name: 'clock', size: 13 })
                : (props.status && props.status.error) ? h(Icon, { name: 'alert', size: 13, style: { color: 'var(--dm-danger)' } })
                  : (props.status && props.status.dirty) ? h(Icon, { name: 'edit', size: 13 })
                    : (props.status && props.status.savedOnce) ? h(Icon, { name: 'check', size: 13, strokeWidth: 2.2 }) : null,
              (props.status && props.status.saving) ? t('saving')
                : (props.status && props.status.error) ? h('button', { className: 'dm_linkbtn', title: props.status.error, onClick: props.onRetrySave }, t('settingsRetry'))
                  : (props.status && props.status.dirty) ? t('settingsUnsaved')
                    : (props.status && props.status.savedOnce) ? t('settingsSaved') : '')))
      }

      // 自定义无障碍下拉：button + portal 浮层 listbox，彻底主题化（原生 select 弹出层无法跨浏览器主题化）。
      // 浮层 portal 到 body，避开工具栏/弹窗的 backdrop-filter 包含块与 overflow 裁剪；fixed 坐标即视口坐标。
      function Select(props) {
        var options = props.options || []
        var value = props.value
        var disabled = props.disabled
        var openState = useState(false)
        var open = openState[0]; var setOpen = openState[1]
        var activeState = useState(-1)
        var active = activeState[0]; var setActive = activeState[1]
        var posState = useState(null)
        var pos = posState[0]; var setPos = posState[1]
        var rootRef = useRef(null)
        var triggerRef = useRef(null)
        var listRef = useRef(null)
        var typeRef = useRef({ buf: '', t: 0 })
        var focusPendingRef = useRef(false)
        var idRef = useRef(null)
        if (idRef.current === null) { selectSeq += 1; idRef.current = 'dm-sel-' + selectSeq }
        var activeRef = useRef(active); activeRef.current = active

        var selectedIndex = -1
        for (var i = 0; i < options.length; i++) {
          if (String(options[i].value) === String(value)) { selectedIndex = i; break }
        }
        var selected = selectedIndex >= 0 ? options[selectedIndex] : null

        function enabledIndexes() {
          var a = []
          for (var k = 0; k < options.length; k++) { if (!options[k].disabled) a.push(k) }
          return a
        }
        function place() {
          var trig = triggerRef.current
          if (!trig) return
          var r = trig.getBoundingClientRect()
          // 严格等宽：弹出层宽度＝触发按钮的渲染宽度（按钮已带稳定最小宽），
          // 左右边缘完全对齐，读起来是同一件控件而非两块板。
          var width = r.width
          var list = listRef.current
          var height = list ? Math.min(list.offsetHeight, 300) : 260
          var spaceBelow = window.innerHeight - r.bottom
          var up = spaceBelow < height + 8 && r.top > spaceBelow
          var top = up ? Math.max(8, r.top - height - 4) : Math.min(r.bottom + 4, Math.max(8, window.innerHeight - height - 8))
          var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8))
          setPos({ top: top, left: left, width: width, up: up })
        }
        function openList() {
          if (disabled) return
          var en = enabledIndexes()
          setActive(selectedIndex >= 0 ? selectedIndex : (en.length ? en[0] : -1))
          focusPendingRef.current = true
          setOpen(true)
        }
        function closeList(refocus) {
          setOpen(false)
          setPos(null)
          if (refocus && triggerRef.current) triggerRef.current.focus()
        }
        function choose(idx) {
          var opt = options[idx]
          if (!opt || opt.disabled) return
          props.onChange(opt.value)
          closeList(true)
        }
        function move(delta) {
          var en = enabledIndexes()
          if (en.length === 0) return
          var cur = en.indexOf(activeRef.current)
          var next = cur === -1 ? (delta > 0 ? 0 : en.length - 1) : (cur + delta + en.length) % en.length
          setActive(en[next])
        }
        function edge(which) {
          var en = enabledIndexes()
          if (en.length) setActive(which === 'first' ? en[0] : en[en.length - 1])
        }
        function typeAhead(ch) {
          var now = Date.now()
          var st = typeRef.current
          if (now - st.t > 600) st.buf = ''
          st.t = now
          st.buf += ch.toLowerCase()
          var en = enabledIndexes()
          for (var k = 0; k < en.length; k++) {
            var lbl = String(options[en[k]].label || '').toLowerCase()
            if (lbl.indexOf(st.buf) === 0) { setActive(en[k]); return }
          }
        }

        useLayoutEffect(function () {
          if (!open) return undefined
          place()
          function onDoc(e) {
            var inTrigger = triggerRef.current && triggerRef.current.contains(e.target)
            var inList = listRef.current && listRef.current.contains(e.target)
            if (!inTrigger && !inList) closeList(false)
          }
          function onScroll() { place() }
          function onResize() { place() }
          document.addEventListener('mousedown', onDoc)
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onResize)
          return function () {
            document.removeEventListener('mousedown', onDoc)
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onResize)
          }
        }, [open])

        // 浮层首帧 pos 为空、样式为 visibility:hidden（隐藏元素无法获得焦点），
        // 必须在 place() 定位完成后的下一次布局提交里再聚焦，否则键盘导航无入口。
        useLayoutEffect(function () {
          if (!open || pos === null || !focusPendingRef.current) return
          focusPendingRef.current = false
          var list = listRef.current
          if (list) list.focus()
        }, [open, pos])

        useLayoutEffect(function () {
          if (!open || !listRef.current) return
          var el = listRef.current.querySelector('[data-index="' + active + '"]')
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        }, [active, open])

        function onTriggerKey(e) {
          if (disabled) return
          // 正常情况下打开后焦点会移入浮层；若聚焦仍停在触发器（例如浮层刚被重排），
          // Esc 也要能收起浮层而不是关掉外层弹窗。
          if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(true); return }
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            openList()
          }
        }
        function onListKey(e) {
          switch (e.key) {
            case 'ArrowDown': e.preventDefault(); move(1); break
            case 'ArrowUp': e.preventDefault(); move(-1); break
            case 'Home': e.preventDefault(); edge('first'); break
            case 'End': e.preventDefault(); edge('last'); break
            case 'Enter': case ' ': e.preventDefault(); choose(activeRef.current); break
            case 'Escape': e.preventDefault(); e.stopPropagation(); closeList(true); break
            case 'Tab': e.preventDefault(); closeList(true); break
            default:
              if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeAhead(e.key) }
          }
        }

        var wrapStyle = Object.assign({}, props.minWidth ? { minWidth: props.minWidth } : null, props.style)
        var trigger = h('div', { className: 'dm_selectwrap' + (props.className ? ' ' + props.className : ''), ref: rootRef, style: wrapStyle },
          h('button', {
            type: 'button', ref: triggerRef, id: props.id,
            className: 'dm_select_trigger' + (open ? ' dm_select_open' : '') + (disabled ? ' dm_select_disabled' : ''),
            disabled: disabled, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': props.ariaLabel,
            // 浮层未渲染时不设 aria-controls（避免指向不存在的 id）。
            'aria-controls': open ? idRef.current : undefined,
            onClick: function () { if (open) closeList(true); else openList() },
            onKeyDown: onTriggerKey,
          },
            selected && selected.icon ? h(Icon, { name: selected.icon, size: 14, className: 'dm_select_val_icon' }) : null,
            h('span', { className: 'dm_select_value' }, selected ? selected.label : (props.placeholder || '')),
            h('span', { className: 'dm_select_chev' }, h(Icon, { name: 'chevD', size: 14 }))))

        if (!open) return trigger

        var pop = h('div', {
          className: 'dm_select_pop' + (pos && pos.up ? ' dm_select_up' : ''),
          style: pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: -9999, left: -9999, visibility: 'hidden' },
          role: 'listbox', ref: listRef, id: idRef.current, tabIndex: -1, 'aria-label': props.ariaLabel,
          'aria-activedescendant': active >= 0 ? (idRef.current + '-opt-' + active) : undefined,
          onKeyDown: onListKey,
        }, options.map(function (opt, idx) {
          var isSel = String(opt.value) === String(value)
          var isActive = idx === active
          return h('div', {
            key: String(opt.value) + '-' + idx, id: idRef.current + '-opt-' + idx, 'data-index': idx,
            role: 'option', 'aria-selected': isSel, 'aria-disabled': opt.disabled || undefined,
            className: 'dm_select_opt' + (isActive ? ' dm_select_opt_active' : '') + (isSel ? ' dm_select_opt_sel' : '') + (opt.disabled ? ' dm_select_opt_disabled' : ''),
            onMouseEnter: function () { if (!opt.disabled) setActive(idx) },
            onClick: function () { choose(idx) },
          },
            opt.icon ? h(Icon, { name: opt.icon, size: 14, className: 'dm_select_opt_icon' }) : h('span', { className: 'dm_select_opt_icon dm_select_opt_spacer' }),
            h('span', { className: 'dm_select_opt_label', title: opt.label }, opt.label),
            opt.hint ? h('span', { className: 'dm_select_opt_hint' }, opt.hint) : null,
            isSel ? h(Icon, { name: 'check', size: 14, strokeWidth: 2.4, className: 'dm_select_opt_check' }) : null)
        }))

        return h(React.Fragment, null, trigger, ReactDOM.createPortal(pop, document.body))
      }

      function currentSessionRef(ctx) {
        try {
          var sessions = ctx.get('sessions')
          var snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null
          var keys = snap && snap.byId ? Object.keys(snap.byId) : []
          for (var i = 0; i < keys.length; i++) {
            var row = snap.byId[keys[i]]
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0 && typeof row.cwd === 'string' && row.cwd !== '') return { id: keys[i], cwd: row.cwd }
          }
        } catch { /* sessions 服务不可用时忽略 optional */ }
        return { id: undefined, cwd: undefined }
      }

      function MemoryPage(props) {
        var ctx = props.ctx
        var t = props.t
        var tokenRef = useRef('')
        // 页面级取消（C5）：卸载时 abort 全部在途请求，避免孤儿响应继续写状态。
        var pageAbortRef = useRef(null)
        if (pageAbortRef.current === null) pageAbortRef.current = new AbortController()
        var apiRef = useRef(null)
        if (apiRef.current === null) apiRef.current = createApi(tokenRef, pageAbortRef)
        var api = apiRef.current
        var seqRef = useRef(0)
        var toastSeq = useRef(0)
        var searchRef = useRef(null)
        var tabMemoriesRef = useRef(null)
        var tabSettingsRef = useRef(null)

        var phaseState = useState('loading')
        var phase = phaseState[0]; var setPhase = phaseState[1]
        var entriesState = useState([])
        var entries = entriesState[0]; var setEntries = entriesState[1]
        var statsState = useState(null)
        var stats = statsState[0]; var setStats = statsState[1]
        var hiddenState = useState({ total: 0 })
        var hidden = hiddenState[0]; var setHidden = hiddenState[1]
        var injectedState = useState([])
        var injected = injectedState[0]; var setInjected = injectedState[1]
        var workspacesState = useState([])
        var workspaces = workspacesState[0]; var setWorkspaces = workspacesState[1]
        var cwdState = useState(undefined)
        var currentCwd = cwdState[0]; var setCurrentCwd = cwdState[1]
        var selectionState = useState('all')
        var selection = selectionState[0]; var setSelection = selectionState[1]
        var queryState = useState('')
        var query = queryState[0]; var setQuery = queryState[1]
        var categoryState = useState('')
        var categoryFilter = categoryState[0]; var setCategoryFilter = categoryState[1]
        var originState = useState('')
        var originFilter = originState[0]; var setOriginFilter = originState[1]
        var tagState = useState('')
        var tagFilter = tagState[0]; var setTagFilter = tagState[1]
        var statusState = useState('active')
        var statusFilter = statusState[0]; var setStatusFilter = statusState[1]
        // 插件版本（/status.version）：面板标题旁展示，便于用户确认当前安装版本。
        var versionState = useState('')
        var version = versionState[0]; var setVersion = versionState[1]
        var pageState = useState(0)
        var page = pageState[0]; var setPage = pageState[1]
        var hasMoreState = useState(false)
        var hasMore = hasMoreState[0]; var setHasMore = hasMoreState[1]
        var selectedState = useState([])
        var selected = selectedState[0]; var setSelected = selectedState[1]
        var editorState = useState(null)
        var editor = editorState[0]; var setEditor = editorState[1]
        var confirmState = useState(null)
        var confirm = confirmState[0]; var setConfirm = confirmState[1]
        var importState = useState(null)
        var importPlan = importState[0]; var setImportPlan = importState[1]
        var importProgressState = useState(null)
        var importProgress = importProgressState[0]; var setImportProgress = importProgressState[1]
        // 「停止导入」在写盘阶段与预演阶段都可用：预演无写盘，取消是安全的。
        var importConfirmingState = useState(false)
        var importConfirming = importConfirmingState[0]; var setImportConfirming = importConfirmingState[1]
        var importPreviewingState = useState(false)
        var importPreviewing = importPreviewingState[0]; var setImportPreviewing = importPreviewingState[1]
        // 写操作成功计数：召回预览只随「数据真的变了」刷新，导出/查重/导入预演的 busy
        // 翻转不再各触发一次全量 /recall-preview 扫描。
        var dataVersionState = useState(0)
        var dataVersion = dataVersionState[0]; var setDataVersion = dataVersionState[1]
        var bumpDataVersion = useCallback(function () { setDataVersion(function (v) { return v + 1 }) }, [])
        var auditState = useState(null)
        var audit = auditState[0]; var setAudit = auditState[1]
        // 存量治理（v0.29.0）：精确重复组弹窗与合并入口。
        var duplicatesState = useState(null)
        var duplicates = duplicatesState[0]; var setDuplicates = duplicatesState[1]
        // 学习分区（v3）：待确认候选 / 最近自动写入 / 审计尾。数据失败不阻塞记忆列表。
        var learningState = useState(null)
        var learning = learningState[0]; var setLearning = learningState[1]
        // 学习分区行内展开（待确认候选/周报/审计摘要）：默认截断保持首屏紧凑，
        // 点击正文展开完整内容后再做批准/拒绝判断。
        var learnExpandedState = useState(null)
        var learnExpanded = learnExpandedState[0]; var setLearnExpanded = learnExpandedState[1]
        // 待批候选 >5 条时默认只显示前 5，提供「显示全部/收起」让用户先审后批（U2）。
        var learnShowAllState = useState(false)
        var learnShowAll = learnShowAllState[0]; var setLearnShowAll = learnShowAllState[1]
        var toastState = useState(null)
        var toast = toastState[0]; var setToast = toastState[1]
        var toastRef = useRef(null)
        var toastQueueRef = useRef([])
        var toastActionRef = useRef(null)
        var toastTimerRef = useRef(null)
        var toastRemainingRef = useRef(0)
        var toastStartedRef = useRef(0)
        var toastPausedRef = useRef(false)
        var pageRef = useRef(null)
        var busyState = useState(false)
        var busy = busyState[0]; var setBusy = busyState[1]
        var errorState = useState('')
        var errorTextState = errorState[0]; var setErrorText = errorState[1]
        var listErrorState = useState('')
        var listError = listErrorState[0]; var setListError = listErrorState[1]
        var tabState = useState('memories')
        var tab = tabState[0]; var setTab = tabState[1]
        // 常驻 tabpanel 共享 .dm_page 唯一滚动容器：按 tab 记住 scrollTop，切回时恢复，
        // 避免切到较短设置页把列表滚动位置夹小、切回来丢失上下文。
        var tabScrollRef = useRef({ memories: 0, settings: 0 })
        function switchTab(next) {
          if (next === tab) return
          var page = pageRef.current
          if (page) tabScrollRef.current[tab] = page.scrollTop
          setTab(next)
        }
        useLayoutEffect(function () {
          var page = pageRef.current
          if (!page) return
          page.scrollTop = tabScrollRef.current[tab] || 0
        }, [tab])
        // WAI-ARIA Tabs：←/→/Home/End 切换并跟随焦点；tab 用 roving tabIndex。
        var TAB_KEYS = ['memories', 'settings']
        function focusTabButton(key) {
          var ref = key === 'memories' ? tabMemoriesRef : tabSettingsRef
          if (ref.current) ref.current.focus()
        }
        function onTabKey(e) {
          var idx = TAB_KEYS.indexOf(tab)
          var next = null
          if (e.key === 'ArrowRight') next = TAB_KEYS[(idx + 1) % TAB_KEYS.length]
          else if (e.key === 'ArrowLeft') next = TAB_KEYS[(idx + TAB_KEYS.length - 1) % TAB_KEYS.length]
          else if (e.key === 'Home') next = TAB_KEYS[0]
          else if (e.key === 'End') next = TAB_KEYS[TAB_KEYS.length - 1]
          if (next === null) return
          e.preventDefault()
          switchTab(next)
          focusTabButton(next)
        }
        var settingsState = useState(null)
        var settings = settingsState[0]; var setSettings = settingsState[1]
        var settingsErrorState = useState('')
        var settingsError = settingsErrorState[0]; var setSettingsError = settingsErrorState[1]
        var draftState = useState(null)
        var draft = draftState[0]; var setDraft = draftState[1]
        var settingsStatusState = useState({ dirty: false, saving: false, savedOnce: false, error: '' })
        var settingsStatus = settingsStatusState[0]; var setSettingsStatusState = settingsStatusState[1]
        var saveTokenRef = useRef(0)
        function applySettingsEvent(event) {
          setSettingsStatusState(function (prev) { return settingsStatusNext(prev, event) })
        }

        var editorRef = useRef(null)
        editorRef.current = editor
        var confirmRef = useRef(null)
        confirmRef.current = confirm
        var modalOpenRef = useRef(false)
        modalOpenRef.current = !!(editor || confirm || importPlan || audit || duplicates)
        var importStopRef = useRef(false)
        var selectedRef = useRef(selected)
        selectedRef.current = selected
        var draftRef = useRef(draft)
        draftRef.current = draft
        var dirtyRef = useRef(false)
        var viewInitialized = useRef(false)
        var settingsSeq = useRef(0)
        var pageSize = (settings && settings.effective && settings.effective.pageSize) || PAGE_SIZE
        // 列表密度：草稿优先（切换即时生效），其次已保存设置；默认舒适索引行。
        var viewMode = (draft && draft.viewMode) || (settings && settings.effective && settings.effective.viewMode) || 'comfortable'
        // 每页条数变化（设置页保存）时页码口径失效：render 阶段归零，避免先按旧
        // page×新 pageSize 发一次错位请求（超界时还会逐页串行回退，每轮都带全量
        // stats 扫描）。React 官方支持的「前次渲染值调整状态」模式，不额外提交。
        var prevPageSizeRef = useRef(pageSize)
        if (prevPageSizeRef.current !== pageSize) {
          prevPageSizeRef.current = pageSize
          setPage(0)
        }

        // 带操作按钮的吐司（删除撤销）出现时把焦点移到动作按钮：确认删除后原触发按钮
// 已随卡片卸载，不主动接管焦点的话键盘用户既丢失上下文、也无法到达撤销。
        useEffect(function () {
          if (!toast || !toast.action || !toastActionRef.current) return
          var active = typeof document !== 'undefined' ? document.activeElement : null
          var descriptor = {
            hasModal: !!(typeof document !== 'undefined' && document.querySelector('.dm_dialog')),
            isBody: !active || active === document.body,
            isConnected: !!(active && active.isConnected),
            tagName: active ? active.tagName : '',
            isContentEditable: !!(active && active.isContentEditable),
            isPage: !!(active && active.classList && active.classList.contains('dm_page')),
            inCardAction: !!(active && active.closest && active.closest('.dm_card_actions')),
          }
          // 0.24.32：仅在焦点已丢失时接管，避免打断输入/被键盘回车误触撤销。
          if (!shouldFocusToastAction(descriptor)) return
          try { toastActionRef.current.focus() } catch { /* 焦点接管失败不影响功能 */ }
        }, [toast])

        function dismissToast() {
          // 吐司内元素（撤销按钮）即将卸载：焦点回退到面板容器，避免掉到 body。
          var active = typeof document !== 'undefined' ? document.activeElement : null
          if (active && active.closest && active.closest('.dm_toast') && pageRef.current) {
            try { pageRef.current.focus() } catch { /* ignore */ }
          }
          var queued = toastQueueRef.current.shift()
          toastPausedRef.current = false
          if (queued) {
            toastRef.current = Object.assign({}, queued, { until: Date.now() + (queued.duration || 2600) })
            setToast(toastRef.current)
          } else {
            toastRef.current = null
            setToast(null)
          }
        }

        function showToast(kind, text, action) {
          toastSeq.current += 1
          var duration = action ? UNDO_MS : 2600
          var next = {
            id: toastSeq.current, kind: kind, text: text, duration: duration,
            until: Date.now() + duration,
            action: action ? { label: action.label, run: function () { dismissToast(); action.run() } } : undefined,
          }
          if (shouldQueueToast(toastRef.current, next, Date.now()) || (toastRef.current && toastRef.current.action && toastPausedRef.current)) {
            // 撤销吐司优先：普通提示排队稍后展示（只保留最近几条，避免堆积）。
            toastQueueRef.current.push(next)
            while (toastQueueRef.current.length > TOAST_QUEUE_MAX) toastQueueRef.current.shift()
            return
          }
          // 两个撤销吐司互不覆盖：连续删除/归档时把旧吐司塞回队列（稍后展示），
// 否则第一次删除的撤销入口会在 6 秒内被第二次操作直接顶掉。
          var currentToast = toastRef.current
          if (currentToast && currentToast.action && next.action) {
            toastQueueRef.current.unshift(Object.assign({}, currentToast, { until: Date.now() + (currentToast.duration || UNDO_MS) }))
            while (toastQueueRef.current.length > TOAST_QUEUE_MAX) toastQueueRef.current.pop()
          }
          toastRef.current = next
          setToast(next)
        }

        // 列表＋统计请求：seq 守卫防乱序；「全部」＝全局＋当前工作区。
        // 多取一条（PAGE_SIZE+1）探测下一页；过滤/切换作用域时回到第一页。
        // opts.stats===false：翻页只取列表（/stats 参数与页码无关，重扫全库纯冗余）。
        var refreshEntries = useCallback(function (opts) {
          var wantStats = !(opts && opts.stats === false)
          var seq = ++seqRef.current
          var scopeParams = {}
          if (selection === 'global') scopeParams.scope = 'global'
          else if (selection === 'all') { scopeParams.scope = 'all'; scopeParams.workspace = currentCwd }
          else { scopeParams.scope = 'workspace'; scopeParams.workspace = selection }
          var params = entriesParams(Object.assign({}, scopeParams, { query: query, category: categoryFilter, origin: originFilter, tag: tagFilter, status: statusFilter, limit: pageSize + 1, offset: page * pageSize }))
          var statsParams = entriesParams(Object.assign({}, scopeParams, { query: query, category: categoryFilter, origin: originFilter, tag: tagFilter, status: statusFilter }))
          return Promise.all([api.entries(params), wantStats ? api.stats(statsParams) : Promise.resolve(null)]).then(function (results) {
            if (seq !== seqRef.current) return
            var doc = results[0]
            var statsDoc = results[1]
            if (statsDoc) setStats(statsDoc.stats)
            setHidden(doc.hidden || { total: 0 })
            var sliced = pageSlice(doc.entries, pageSize)
            // 当前页被删空（如删掉末页最后一条）→ 用统计总数一次跳到末页，避免逐页回退
            // N 轮、每轮再发 entries+stats（大库/大幅删除时会长时间停在骨架屏）。
            if (sliced.items.length === 0 && page > 0) {
              return (statsDoc ? Promise.resolve(statsDoc) : api.stats(statsParams)).then(function (extra) {
                if (seq !== seqRef.current) return
                if (extra && extra.stats) setStats(extra.stats)
                var total = extra && extra.stats ? Number(extra.stats.total) || 0 : 0
                setPage(clampPageToTotal(page, total, pageSize))
              })
            }
            // 来源/标签/状态均服务端过滤（分页口径一致）。
            setEntries(sliced.items)
            // 批量选择与列表同步：条目被删除/归档/过滤掉后不再保留在选中集合。
            // 无原型集合：id 可能恰为 __proto__/constructor（ID_PATTERN 允许）。
            var visibleIds = idSetOf(sliced.items)
            setSelected(function (prev) { return prev.filter(function (id) { return visibleIds[id] === true }) })
            setHasMore(sliced.hasMore)
            setListError('')
          }).catch(function (err) {
            if (seq !== seqRef.current) return
            setListError(errorText(err, t))
          })
        }, [api, query, categoryFilter, originFilter, tagFilter, statusFilter, page, pageSize, selection, currentCwd, t])

        // 写入完成回调可能捕获旧的 refreshEntries（busy 期间过滤条件可变）；
        // 一律经 ref 调用最新版本，避免陈旧过滤结果覆盖列表。
        var refreshRef = useRef(refreshEntries)
        refreshRef.current = refreshEntries

        var refreshWorkspaces = useCallback(function () {
          return api.workspaces().then(function (doc) { setWorkspaces(doc.workspaces || []) }).catch(function () {})
        }, [api])

        var loadInitial = useCallback(function () {
          setPhase('loading')
          return api.status().then(function (doc) {
            // 插件版本（/status 下发，读自 package.json）：标题旁小字展示，失败留空不显示假值。
            if (doc && typeof doc.version === 'string' && doc.version !== '') setVersion(doc.version)
            return api.workspaces()
          }).then(function (doc) {
            setWorkspaces(doc.workspaces || [])
            var ref = currentSessionRef(ctx)
            setCurrentCwd(ref.cwd)
            // 等权威 cwd（跟随 cd）解析完再置 ready：否则首屏会用会话快照的旧 cwd
            // 拉一次列表，且 defaultView='workspace' 会永久锁在旧目录。
            if (!ref.id) return undefined
            return api.cwd(ref.id).then(function (c) {
              if (c && typeof c.cwd === 'string' && c.cwd !== '') setCurrentCwd(c.cwd)
            }).catch(function () { /* /cwd 不可用时回退会话快照 */ })
          }).then(function () {
            setPhase('ready')
          }).catch(function (err) {
            setErrorText(errorText(err, t))
            setPhase('error')
          })
        }, [api, ctx, t])

        useEffect(function () { loadInitial() }, [loadInitial])

        // 学习分区刷新：面板就绪后只自动拉一次，之后仅在显式写操作（批准/拒绝）
        // 或用户点「刷新」时更新——避免每次切 tab 都异步插入/移除区块，破坏列表
        // 滚动位置的稳定性（tab 切换恢复 scrollTop 的回归）。
        var learningSeq = useRef(0)
        var learningLoadedRef = useRef(false)
        var learningRetryRef = useRef(0)
        var learningCwdRef = useRef(undefined)
        var loadLearning = useCallback(function () {
          var seq = ++learningSeq.current
          return api.learning(currentCwd).then(function (doc) {
            if (seq !== learningSeq.current) return
            learningRetryRef.current = 0
            setLearning(doc || null)
          }).catch(function () {
            if (seq !== learningSeq.current) return
            // 首次装配可能早于回环路由就绪，或宿主短暂不可用：单次失败不应让
            // 学习分区永久缺席（用户「没看到学习」的直接原因），退避重试至多 3 次。
            if (learningRetryRef.current >= 3) return
            learningRetryRef.current += 1
            var delay = 1200 * learningRetryRef.current
            setTimeout(function () {
              if (seq === learningSeq.current) loadLearning()
            }, delay)
          })
        }, [api, currentCwd])
        useEffect(function () {
          if (phase !== 'ready') return
          if (!learningLoadedRef.current) {
            learningLoadedRef.current = true
            learningCwdRef.current = currentCwd
            loadLearning()
            return
          }
          // 会话 cd 后 recentAuto 按工作区过滤，须随 currentCwd 重载（C9）；
          // 首载闸门保留以维护滚动稳定，仅 cwd 真正变化时刷新。
          if (learningCwdRef.current !== currentCwd) {
            learningCwdRef.current = currentCwd
            loadLearning()
          }
        }, [phase, currentCwd, loadLearning])

        // 设置：加载有效值作为可编辑草稿；改动防抖自动保存（改完即生效）。
        // 加载不覆盖「防抖窗内」未保存的草稿（否则改完立刻点备份/切换会把改动回滚）。
        var loadSettings = useCallback(function () {
          var seq = ++settingsSeq.current
          return api.settings().then(function (view) {
            if (seq !== settingsSeq.current) return
            setSettings(view)
            setSettingsError('')
            applySettingsEvent({ type: 'load-ok' })
            if (!dirtyRef.current) setDraft(view.effective)
          }).catch(function (err) {
            if (seq !== settingsSeq.current) return
            setSettingsError(errorText(err, t))
          })
        }, [api, t])

        useEffect(function () { loadSettings() }, [loadSettings])

        // 首次拿到设置且面板就绪时，应用默认视图（workspace → 当前工作区）。
        useEffect(function () {
          if (viewInitialized.current || !settings || phase !== 'ready') return
          var picked = defaultViewSelection(settings, currentCwd, options)
          if (!picked.resolved) return // cwd 尚未解析：等 currentCwd 到达后本 effect 再跑
          viewInitialized.current = true
          if (picked.selection) setSelection(picked.selection)
        }, [settings, phase, currentCwd])

        // 动效开关同步到 body：下拉浮层 portal 到 body，在 .dm_page 之外，
        // 需要 body 级类才能让浮层也尊重「关闭动效」。
        useEffect(function () {
          var off = !!(settings && !settings.effective.animations)
          if (off) document.body.classList.add('dm-no-anim')
          else document.body.classList.remove('dm-no-anim')
          return function () { document.body.classList.remove('dm-no-anim') }
        }, [settings])

        function changeSetting(key, value) {
          dirtyRef.current = true
          applySettingsEvent({ type: 'edit' })
          setDraft(function (prev) {
            var next = Object.assign({}, prev)
            next[key] = value
            return next
          })
        }

        // 工具栏列表密度切换：乐观更新草稿（视图即时切换），保存时只写 viewMode 这一个键，
        // 不把默认值展开成 settings.json 显式字段；失败回滚并提示。设置页有未保存改动时
        // 并入既有草稿走统一防抖保存，避免两套写路径互相覆盖。
        function setViewMode(mode) {
          if (mode !== 'comfortable' && mode !== 'compact') return
          var current = (draft && draft.viewMode) || (settings && settings.effective && settings.effective.viewMode) || 'comfortable'
          if (mode === current) return
          if (dirtyRef.current) { changeSetting('viewMode', mode); return }
          setDraft(function (prev) { return Object.assign({}, prev, { viewMode: mode }) })
          // 与 saveDraft 同一守卫（C4）：seq 让 reset/重载失效在途响应，token 收敛 saving，
          // 否则密度保存期间「恢复默认」可点，旧响应到达会复活重置前的草稿。
          var seq = ++settingsSeq.current
          var token = ++saveTokenRef.current
          applySettingsEvent({ type: 'save-start' })
          api.saveSettings({ viewMode: mode }).then(function (view) {
            if (seq !== settingsSeq.current) return
            setSettings(view)
            if (!dirtyRef.current) setDraft(view.effective)
            setSettingsError('')
            applySettingsEvent({ type: 'save-ok' })
          }).catch(function (err) {
            if (seq !== settingsSeq.current) return
            setDraft(function (prev) { return Object.assign({}, prev, { viewMode: current }) })
            applySettingsEvent({ type: 'save-fail', error: errorText(err, t) })
            showToast('error', errorText(err, t))
          }).then(function () {
            if (token === saveTokenRef.current) applySettingsEvent({ type: 'save-settled' })
          })
        }

        // 单次保存（防抖到期/失败重试共用）：seq 让重置/重载失效在途响应，
        // token 保证「保存中」只在最后一次请求结束时清除（不会卡死或被旧响应提前清掉）。
        var saveDraft = useCallback(function () {
          // 防抖到期时用户意图可能已改变（比如刚点了「恢复默认」）：dirty 已被清掉就
          // 不再落盘，否则旧草稿会以更新的 seq 覆盖 reset 结果。
          if (!draftRef.current || !dirtyRef.current) return
          dirtyRef.current = false
          var seq = ++settingsSeq.current
          var token = ++saveTokenRef.current
          applySettingsEvent({ type: 'save-start' })
          api.saveSettings(draftRef.current).then(function (view) {
            if (seq !== settingsSeq.current) return
            setSettings(view)
            setSettingsError('')
            applySettingsEvent({ type: 'save-ok' })
            // 服务端会夹取/规范化（如保留份数 0→1）：没有新编辑时把草稿回收为
            // effective，避免输入框显示的值与实际保存值不一致。
            if (!dirtyRef.current) setDraft(view.effective)
          }).catch(function (err) {
            if (seq !== settingsSeq.current) return
            // 保存失败：保留草稿并标记脏，footer 提供重试，不谎报「已保存」。
            dirtyRef.current = true
            applySettingsEvent({ type: 'save-fail', error: errorText(err, t) })
            showToast('error', errorText(err, t))
          }).then(function () {
            if (token === saveTokenRef.current) applySettingsEvent({ type: 'save-settled' })
          })
        }, [api, t])

        useEffect(function () {
          if (!dirtyRef.current || !draft) return undefined
          var timer = setTimeout(saveDraft, 600)
          return function () { clearTimeout(timer) }
        }, [draft, saveDraft])

        function retrySaveSettings() {
          if (settingsStatus.saving) return
          dirtyRef.current = true
          applySettingsEvent({ type: 'edit' })
          saveDraft()
        }

        function resetSettings() {
          if (busy) return
          // 让在途保存/加载与已排队的防抖保存都失效：重置结果不能被旧草稿回滚。
          dirtyRef.current = false
          var seq = ++settingsSeq.current
          applySettingsEvent({ type: 'reset-start' })
          setBusy(true)
          api.resetSettings().then(function (view) {
            if (seq !== settingsSeq.current) return
            setSettings(view)
            setDraft(view.effective)
            dirtyRef.current = false
            applySettingsEvent({ type: 'reset-ok' })
            showToast('ok', t('resetDone'))
          }).catch(function (err) {
            if (seq !== settingsSeq.current) return
            applySettingsEvent({ type: 'reset-fail', error: errorText(err, t) })
            writeFailure(err)
          }).then(function () { setBusy(false) })
        }

        function backupNow() {
          if (busy || settingsStatus.saving) return
          setBusy(true)
          showToast('info', t('backingUp'))
          api.backup().then(function () {
            showToast('ok', t('backupDone'))
            return loadSettings()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        // 注入徽章（召回预览）只依赖「已保存设置／条目／当前工作目录」，与筛选/翻页无关：
// 单独刷新，避免每次输入/翻页都多一次全量扫描；失败保留旧徽章（瞬态抖动不清空）。
        var recallSeq = useRef(0)
        var refreshRecall = useCallback(function () {
          var seq = ++recallSeq.current
          return api.recallPreview(currentCwd).then(function (rp) {
            if (seq !== recallSeq.current) return
            setInjected(rp && rp.autoInject ? (rp.entries || []).map(function (e) { return e.id }) : [])
          }).catch(function () { /* 保留旧值 keep previous badge */ })
        }, [api, currentCwd])

        // 依赖 effective 的内容签名而非 settings 对象引用：备份等触发的 loadSettings
        // 会换新对象，内容未变时不得重扫全量 /recall-preview。
        var recallSettingsKey = settingsSignature(settings)
        useEffect(function () {
          if (phase !== 'ready' || tab !== 'memories') return
          refreshRecall()
        }, [phase, dataVersion, recallSettingsKey, currentCwd, tab, refreshRecall])

        // 选择/查询/分类/页码变化 → 刷新列表（查询防抖 300ms）。
        // 仅页码变化时跳过 /stats（参数与页码无关）；其余导航/刷新都重取统计。
        var lastListSigRef = useRef('')
        var lastListPageRef = useRef(0)
        useEffect(function () {
          if (phase !== 'ready') return undefined
          var sig = JSON.stringify([query, categoryFilter, originFilter, tagFilter, statusFilter, selection, currentCwd, pageSize])
          var pageOnly = sig === lastListSigRef.current && page !== lastListPageRef.current
          lastListSigRef.current = sig
          lastListPageRef.current = page
          var timer = setTimeout(function () { refreshEntries({ stats: !pageOnly }) }, (query || tagFilter) ? 300 : 0)
          return function () { clearTimeout(timer) }
        }, [phase, query, categoryFilter, originFilter, tagFilter, statusFilter, page, selection, currentCwd, refreshEntries])

        // 外部写入感知（C8）：窗口重新聚焦/页面可见时刷新列表（≥30s 节流），
        // 对话中写入的记忆不必手动刷新即可见；走现有 seq 守卫，不动滚动位置。
        var phaseRef = useRef(phase)
        phaseRef.current = phase
        var lastAutoRefreshRef = useRef(0)
        useEffect(function () {
          function maybeRefresh() {
            if (phaseRef.current !== 'ready') return
            if (document.visibilityState === 'hidden') return
            var now = Date.now()
            if (!shouldAutoRefresh(lastAutoRefreshRef.current, now)) return
            lastAutoRefreshRef.current = now
            refreshRef.current().catch(function () { /* 列表错误态由 refreshEntries 自处理 */ })
          }
          window.addEventListener('focus', maybeRefresh)
          document.addEventListener('visibilitychange', maybeRefresh)
          return function () {
            window.removeEventListener('focus', maybeRefresh)
            document.removeEventListener('visibilitychange', maybeRefresh)
          }
        }, [])

        // 吐司进度条与 JS 计时同步冻结/恢复（否则条走完但撤销仍有效，视觉误导）。
        function setToastBarState(paused) {
          var bar = typeof document !== 'undefined' ? document.querySelector('.dm_toast_bar') : null
          if (bar) bar.style.animationPlayState = paused ? 'paused' : 'running'
        }

        // toast 自动消失（可被悬停/聚焦暂停）；撤销吐司到期后继续展示排队提示。
        useEffect(function () {
          // 换吐司时先清旧定时器：resume 设过的定时器不得成为孤儿（提前关掉新吐司）。
          clearTimeout(toastTimerRef.current)
          if (!toast) return undefined
          var duration = toast.duration || 2600
          var active = typeof document !== 'undefined' ? document.activeElement : null
          var focusedInside = !!(active && active.closest && active.closest('.dm_toast'))
          toastRemainingRef.current = duration
          toastStartedRef.current = Date.now()
          toastPausedRef.current = focusedInside
          setToastBarState(focusedInside)
          // 吐司出现即被聚焦（删除撤销按钮）：保持暂停，等失焦后 resumeToast 再启动计时。
          if (focusedInside) {
            toast.until = Date.now() + duration
            return undefined
          }
          toastTimerRef.current = setTimeout(dismissToast, duration)
          return function () { clearTimeout(toastTimerRef.current) }
        }, [toast])

        // 焦点是否仍在吐司内（键盘停在撤销按钮上时，鼠标移出不得恢复倒计时）。
        function focusInsideToast() {
          if (typeof document === 'undefined') return false
          var node = document.querySelector('.dm_toast')
          var active = document.activeElement
          return !!(node && active && node.contains(active))
        }

        function pauseToast() {
          // 幂等：mouseenter 与 focusCapture 可能先后触发，重复暂停不得重复扣减。
          if (!toast || toastPausedRef.current) return
          var now = Date.now()
          clearTimeout(toastTimerRef.current)
          toastRemainingRef.current = toastRemainingMs(toastStartedRef.current, now, now, toastRemainingRef.current)
          setToastBarState(true)
          toastPausedRef.current = true
          // 同步延长撤销保护窗口：暂停期间其它普通提示不得替换撤销吐司。
          toast.until = now + toastRemainingRef.current
        }

        function resumeToast() {
          if (!toast || !shouldResumeToast(toastPausedRef.current, focusInsideToast())) return
          toastPausedRef.current = false
          setToastBarState(false)
          toast.until = Date.now() + toastRemainingRef.current
          toastStartedRef.current = Date.now()
          clearTimeout(toastTimerRef.current)
          toastTimerRef.current = setTimeout(dismissToast, toastRemainingRef.current)
        }

        // 快捷键：/ 聚焦搜索（无输入焦点、无弹窗时）；Esc 清除批量选择。
        useEffect(function () {
          function onKey(e) {
            if (modalOpenRef.current) return
            var el = document.activeElement
            var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.closest && el.closest('.dm_select_pop') !== null))
            if (e.key === '/' && !typing) {
              e.preventDefault()
              // 搜索框在记忆 tabpanel 内：设置页下 hidden 元素不可聚焦（focus 静默
              // 失败还吞掉按键）。先切回记忆页，等面板可见后再聚焦。
              if (tab !== 'memories') switchTab('memories')
              var tries = 0
              function tryFocusSearch() {
                var el = searchRef.current
                if (el && el.offsetParent !== null) { try { el.focus() } catch { /* ignore */ } return }
                if (tries++ < 10) requestAnimationFrame(tryFocusSearch)
              }
              tryFocusSearch()
            } else if (e.key === 'Escape' && !typing && selectedRef.current.length > 0) {
              setSelected([])
            }
          }
          document.addEventListener('keydown', onKey)
          return function () { document.removeEventListener('keydown', onKey) }
          // 依赖 tab：处理函数闭包里的 tab/switchTab 必须是当前渲染的值，否则切到设置页后
          // 「/」分支永远看到首帧的 'memories'，按键被吞但页面不切换（第十轮审计 C1）。
        }, [tab])

        // busy 期间被点/被聚焦的控件会因 disabled 把焦点抛回 body（键盘用户每次钉选/
        // 工具栏操作后都要从页首重新 Tab）。disabled 的 blur 发生在 React 提交阶段，
        // passive effect 读到 activeElement 时已经是 body——所以额外用 focusin 记录
        // 最后一个获得焦点的元素，busy 结束后仅在焦点确实丢失时归还。
        var lastFocusRef = useRef(null)
        useEffect(function () {
          if (typeof document === 'undefined') return undefined
          function onFocusIn(e) { lastFocusRef.current = e.target }
          document.addEventListener('focusin', onFocusIn)
          return function () { document.removeEventListener('focusin', onFocusIn) }
        }, [])
        var busyFocusRef = useRef(null)
        useEffect(function () {
          if (typeof document === 'undefined') return
          if (busy) {
            var active = document.activeElement
            busyFocusRef.current = active && active !== document.body ? active : lastFocusRef.current
            return
          }
          var previous = busyFocusRef.current
          busyFocusRef.current = null
          if (!previous) return
          // 弹窗/吐司等其它路径已接管焦点时不抢。
          if (document.activeElement && document.activeElement !== document.body) return
          if (previous.isConnected && typeof previous.focus === 'function') {
            try { previous.focus() } catch { /* 焦点归还失败不影响功能 */ }
            return
          }
          if (pageRef.current) { try { pageRef.current.focus() } catch { /* ignore */ } }
        }, [busy])

        // 卸载取消（C5）：停止分片导入/预演链并 abort 在途请求，
        // 避免孤儿响应在面板卸载后继续写状态/弹吐司。
        useEffect(function () {
          // 开发态重挂载可能已 abort 旧控制器：换新保证重挂载后请求仍可用。
          if (pageAbortRef.current.signal.aborted) pageAbortRef.current = new AbortController()
          return function () {
            importStopRef.current = true
            pageAbortRef.current.abort()
          }
        }, [])

        var options = [{ value: 'all', kind: 'all' }].concat(workspaceOptions({ workspaces: workspaces, currentCwd: currentCwd }))
        var unknownWorkspaces = workspaces.filter(function (w) { return !w || typeof w.cwd !== 'string' || w.cwd === '' })
        var workspaceTarget = selection !== 'all' && selection !== 'global' ? selection : currentCwd

        // 翻页/筛选/切换作用域是「导航」而非「刷新」：回到列表顶部（并同步 tab 记忆），
// 否则在第 1 页底部点下一页会停在新页中后段。
        function resetListScroll() {
          var page = pageRef.current
          if (page) page.scrollTop = 0
          tabScrollRef.current.memories = 0
        }
        function changeQuery(value) { setQuery(value); setPage(0); setSelected([]); resetListScroll() }
        function changeSelection(value) { setSelection(value); setPage(0); setSelected([]); resetListScroll() }
        function changeCategory(value) { setCategoryFilter(value); setPage(0); setSelected([]); resetListScroll() }
        function changeOrigin(value) { setOriginFilter(value); setPage(0); setSelected([]); resetListScroll() }
        function changeTag(value) { setTagFilter(value); setPage(0); setSelected([]); resetListScroll() }
        // 卡片标签点击 = 精确标签过滤（与服务端 tag= 语义一致），而不是把标签塞进全文查询。
        function filterByTag(tag) {
          setTagFilter(String(tag || ''))
          setQuery('')
          setPage(0)
          setSelected([])
          resetListScroll()
        }
        function changeStatus(value) { setStatusFilter(value); setPage(0); setSelected([]); resetListScroll() }
        function focusPage() {
          // 空态/错误态按钮触发后自身随分支卸载：焦点回面板容器，键盘用户不必从页首重来。
          if (pageRef.current) { try { pageRef.current.focus() } catch { /* ignore */ } }
        }
        function clearAllFilters() { setQuery(''); setCategoryFilter(''); setOriginFilter(''); setTagFilter(''); setStatusFilter('active'); setPage(0); setSelected([]); resetListScroll(); focusPage() }
        // 被取代条目的「查看后继」：按 id 搜索（host query 匹配 id），回到活跃视图。
        function jumpToEntry(id) { setStatusFilter('all'); setOriginFilter(''); setCategoryFilter(''); setTagFilter(''); setPage(0); setSelected([]); setQuery(String(id || '')); resetListScroll() }
        function changePage(value) { setPage(value); setSelected([]); resetListScroll() }
        function toggleSelect(id) {
          setSelected(function (prev) { return prev.indexOf(id) === -1 ? prev.concat([id]) : prev.filter(function (x) { return x !== id }) })
        }

        function openCreate() {
          if (busy) return
          setEditor({ mode: 'create', content: '', category: 'fact', tags: '', scope: workspaceTarget && selection !== 'global' ? 'workspace' : 'global', pinned: false, expires: '', expiresOriginal: '', origin: 'manual' })
        }
        function openEdit(entry) {
          if (busy) return
          setEditor({ mode: 'edit', id: entry.id, content: entry.content, category: entry.category, tags: (entry.tags || []).join(', '), scope: entry.scope, pinned: !!entry.pinned, expires: entry.expires || '', expiresOriginal: entry.expires || '', origin: originOf(entry) })
        }
        function openDelete(entry) {
          if (busy) return
          setConfirm({ entries: [entry] })
        }
        function openBulkDelete() {
          if (busy) return
          var chosen = entries.filter(function (e) { return selected.indexOf(e.id) !== -1 })
          if (chosen.length === 0) {
            // 选中项已不在当前列表（被归档/删除/过滤）：清空选择并说明，避免按钮死点。
            setSelected([])
            showToast('error', t('errStaleSelection'))
            return
          }
          setConfirm({ entries: chosen })
        }

        // 钉选/归档快捷操作：POST update 单字段 → 刷新；归档吐司复用撤销基建。
        function quickUpdate(entry, patch, okKey, action, opts) {
          var forced = !!(opts && opts.force)
          if (busy && !forced) return
          if (!forced) setBusy(true)
          // opts.workspace 覆盖默认 workspaceTarget：学习区按 currentCwd 拉取，动作须同口径。
          var ws = entry.scope === 'workspace' ? ((opts && opts.workspace) || workspaceTarget) : undefined
          api.update(Object.assign({ id: entry.id, workspace: ws }, patch)).then(function () {
            bumpDataVersion()
            showToast('ok', t(okKey), action)
            // 写已成功：刷新失败单独兜底（列表错误态由 refreshEntries 自处理），
            // 不得落入 writeFailure 把已成功的操作误报成失败。
            return refreshRef.current().catch(function () {})
          }).catch(writeFailure).then(function () { if (!forced) setBusy(false) })
        }
        function togglePin(entry) {
          quickUpdate(entry, { pinned: !entry.pinned }, entry.pinned ? 'unpinnedMsg' : 'pinnedMsg')
        }
        function toggleArchive(entry, opts) {
          var restoring = !!entry.archived
          var base = opts || {}
          quickUpdate(entry, { archived: !restoring }, restoring ? 'restoredMsg' : 'archivedMsg', restoring ? undefined : {
            label: t('undo'),
            // 撤销不能被列表刷新期间的 busy 守卫静默丢弃（toast 已消失但归档仍生效）。
            run: function () { quickUpdate(entry, { archived: false }, 'restoredMsg', undefined, Object.assign({}, base, { force: true })) },
          }, base)
        }

        // 待确认候选：批准=落盘为活跃条目（origin 沿用候选来源），拒绝=只留审计。
        function approvePendingItem(item) {
          if (busy) return
          setBusy(true)
          api.approveLearning({ pendingId: item.id, workspace: item.cwd || currentCwd }).then(function () {
            bumpDataVersion()
            showToast('ok', t('learningApproved'))
            return loadLearning()
          }).catch(writeFailure).then(function () {
            setBusy(false)
            refreshRef.current().catch(function () {})
          })
        }
        function rejectPendingItem(item) {
          if (busy) return
          setBusy(true)
          api.rejectLearning({ pendingId: item.id }).then(function () {
            bumpDataVersion()
            showToast('ok', t('learningRejected'))
            return loadLearning()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        // 撤销自动写入：复用归档/恢复（可逆、留审计），不是物理删除。
        // 传真实 entry（含 archived）：已归档者按钮给「恢复」而非再归档（C6）；
        // 学习区按 currentCwd 拉取，workspace 固定 currentCwd 不随作用域下拉漂移（C2）。
        function archiveRecentAuto(entry) {
          toggleArchive(entry, { workspace: currentCwd })
        }
        // v0.30.0：程序性知识候选批准/拒绝/回滚（批准前不索引、不可加载）。
        function approveSkillItem(skill) {
          if (busy) return
          setBusy(true)
          api.approveSkill({ skillId: skill.id }).then(function () {
            bumpDataVersion()
            showToast('ok', t('learningSkillApprovedMsg').replace('{name}', String(skill.name)))
            return loadLearning()
          }).catch(writeFailure).then(function () {
            setBusy(false)
            refreshRef.current().catch(function () {}) // 批准会写全局索引条目，刷新列表（C3）
          })
        }
        function rejectSkillItem(skill) {
          if (busy) return
          setBusy(true)
          api.rejectSkill({ skillId: skill.id }).then(function () {
            bumpDataVersion()
            showToast('ok', t('learningSkillRejectedMsg').replace('{name}', String(skill.name)))
            return loadLearning()
          }).catch(writeFailure).then(function () {
            setBusy(false)
            refreshRef.current().catch(function () {}) // 拒绝修订会恢复上一版索引条目，刷新列表（C3）
          })
        }
        function rollbackSkillItem(skill) {
          if (busy) return
          setBusy(true)
          api.rollbackSkill({ skillId: skill.id, revision: Math.max(1, Number(skill.version) - 1) }).then(function () {
            bumpDataVersion()
            showToast('ok', t('learningSkillRolledBackMsg').replace('{name}', String(skill.name)))
            return loadLearning()
          }).catch(writeFailure).then(function () {
            setBusy(false)
            refreshRef.current().catch(function () {}) // 回滚改写索引条目版本，刷新列表（C3）
          })
        }
        // v0.31.0：批量审批（逐项结算，失败数如实展示）。
        function approveAllPending() {
          if (busy) return
          var pendingIds = (Array.isArray(learning && learning.pending) ? learning.pending : []).map(function (item) { return item.id })
          if (pendingIds.length === 0) return
          setBusy(true)
          api.approveLearningMany({ pendingIds: pendingIds, workspace: currentCwd }).then(function (payload) {
            var counts = learningBatchCounts(payload)
            bumpDataVersion()
            showToast('ok', t('learningBatchApproved').replace('{n}', String(counts.approved)).replace('{m}', String(counts.failed)))
            return loadLearning()
          }).catch(writeFailure).then(function () {
            setBusy(false)
            // 批量批准真实落盘条目：刷新列表/统计，否则新条目不可见（C3，与单条批准同口径）。
            refreshRef.current().catch(function () {})
          })
        }
        function rejectAllPending() {
          if (busy) return
          var pendingIds = (Array.isArray(learning && learning.pending) ? learning.pending : []).map(function (item) { return item.id })
          if (pendingIds.length === 0) return
          setBusy(true)
          api.rejectLearningMany({ pendingIds: pendingIds }).then(function (payload) {
            var counts = learningBatchCounts(payload)
            bumpDataVersion()
            showToast('ok', t('learningBatchRejected').replace('{n}', String(counts.rejected)).replace('{m}', String(counts.failed)))
            return loadLearning()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function writeFailure(err) {
          if (err.status === 403) {
            return api.status().then(function () {
              showToast('error', t('errRefreshed'))
            }).catch(function () {
              showToast('error', errorText(err, t))
            })
          }
          showToast('error', errorText(err, t))
          return undefined
        }

        function handleSave() {
          if (busy) return
          var check = validateDraft(editor)
          if (!check.ok) {
            var errKey = check.error === 'empty-content' ? 'errEmptyContent'
              : check.error === 'bad-expires' ? 'errBadExpires'
                : check.error === 'expires-past' ? 'errExpiresPast'
                  : 'errBadCategory'
            showToast('error', t(errKey))
            return
          }
          var started = editor
          setBusy(true)
          var tags = splitTags(editor.tags)
          var promise
          if (editor.mode === 'create') {
            // 只发送用户真正显式设置的字段：宿主去重命中时会应用显式字段，若把表单默认值
            // （category=fact / tags=[] / pinned=false / origin=manual）也当显式字段发送，
            // 新建一条重复内容会静默改写既有条目的分类/标签/钉选（第十轮审计 C2）。
            promise = api.save(buildCreatePayload(editor, tags, workspaceTarget))
          } else {
            promise = api.update({ id: editor.id, content: editor.content.trim(), category: editor.category, tags: tags, scope: editor.scope, workspace: workspaceTarget, pinned: !!editor.pinned, expires: editor.expires || '', origin: editor.origin })
          }
          promise.then(function (payload) {
            if (editorRef.current === started) setEditor(null)
            bumpDataVersion()
            var result = (payload && payload.result) || {}
            var key = savedToastKey(result)
            var sim = result.similar || []
            if (key === 'similarSaved') showToast('ok', t('similarSaved').replace('{n}', String(sim.length)).replace('{id}', sim[0].id))
            else showToast('ok', t(key))
            // 新建条目按更新时间排在最前：回到第一页让它可见。
            if (started.mode === 'create') { setPage(0); resetListScroll() }
            // 写已成功：刷新失败单独兜底（列表错误态由 refreshEntries 自处理），
            // 不得落入 writeFailure 误报写失败。
            return refreshRef.current().catch(function () {})
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        // 删除（单条/批量）→ 确认 → forget → 撤销吐司（import 原样恢复 id/时间戳）。
        // 批量删除逐项结算：单项失败不阻断其余项；成功项仍可撤销，失败项汇报原因。
        function handleDelete() {
          if (busy || !confirm) return
          var started = confirm
          var targets = started.entries
          var wsTarget = workspaceTarget
          setBusy(true)
          var outcomePromise
          if (targets.length === 1) {
            var one = targets[0]
            outcomePromise = api.forget({ id: one.id, workspace: one.scope === 'workspace' ? wsTarget : undefined })
              .then(function () { return { ok: targets, failed: [] } })
          } else {
            // 批量删除走单请求（服务端一次扫描/一次取代指针清理），不再 N 次全量扫描。
            // 结算按宿主 {ids, notFound, failed} 分别归因：failed=文件被占用 → busy。
            outcomePromise = api.forgetMany({ ids: targets.map(function (e) { return e.id }) }).then(function (payload) {
              return settleBulkDelete(targets, payload && payload.result)
            })
          }
          outcomePromise.then(function (outcome) {
            if (outcome.ok.length > 0) bumpDataVersion()
            if (confirmRef.current === started) setConfirm(null)
            setSelected([])
            // 成功项先从当前页移除，不必等刷新（刷新也仍会执行）。
            var removed = idSetOf(outcome.ok)
            setEntries(function (prev) { return prev.filter(function (e) { return removed[e.id] !== true }) })
            if (outcome.ok.length > 0) {
              var text = outcome.ok.length === 1 ? t('deleted') : t('deletedN').replace('{n}', String(outcome.ok.length))
              var action = { label: t('undo'), run: function () { restoreEntries(outcome.ok, wsTarget) } }
              if (outcome.failed.length > 0) {
                text = t('deletedPartial').replace('{n}', String(outcome.ok.length)).replace('{m}', String(outcome.failed.length)) + t('errJoin') + errorText(outcome.failed[0].error, t)
                showToast('error', text, action)
              } else {
                showToast('ok', text, action)
              }
            } else if (outcome.failed.length > 0) {
              showToast('error', t('deleteFailed') + t('errJoin') + errorText(outcome.failed[0].error, t))
            }
            // 删除已结算：刷新失败单独兜底，不误报写失败。
            return refreshRef.current().catch(function () {})
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function restoreEntries(targets, wsTarget) {
          var payloadEntries = targets.map(function (e) {
            return {
              id: e.id, content: e.content, category: e.category, scope: e.scope,
              tags: e.tags || [], created: e.created, updated: e.updated, source: e.source || '',
              workspace: e.scope === 'workspace' ? wsTarget : null,
              // v2 元数据随撤销原样恢复（host import 无损保留；缺省字段经 JSON 序列化自动省略）。
              origin: e.origin, pinned: e.pinned, expires: e.expires, archived: e.archived,
              supersedes: e.supersedes, superseded_by: e.superseded_by, last_access: e.last_access, hit_count: e.hit_count,
            }
          })
          api.import({ entries: payloadEntries }).then(function (payload) {
            bumpDataVersion()
            var n = payload && payload.result ? payload.result.imported : 0
            showToast('ok', t('undone').replace('{n}', String(n)))
            // 恢复已成功：undoFailed 只覆盖 import 本身；列表/工作区刷新失败
            // 单独兜底（refreshEntries 已有列表错误态），否则会先弹「已恢复」再弹
            // 「恢复失败」误导用户重复操作（撤销是删除后 6 秒内唯一防线）。
            return refreshRef.current().catch(function () {})
          }).then(function () {
            return refreshWorkspaces()
          }).catch(function (err) {
            showToast('error', t('undoFailed') + t('labelSep') + errorText(err, t))
          })
        }

        function handleExport() {
          if (busy) return
          setBusy(true)
          showToast('info', t('exporting'))
          var scopeParams = exportParams(selection, currentCwd)
          api.export(scopeParams).then(function (doc) {
            var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
            var url = URL.createObjectURL(blob)
            var a = document.createElement('a')
            a.href = url
            a.download = 'dsh-memory-export-' + scopeParams.scope + '-' + localDateStamp() + '.json'
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
            showToast('ok', t('exportDone').replace('{n}', String((doc.entries || []).length)) + (Number(doc.skipped) > 0 ? ' · ' + t('exportSkipped').replace('{n}', String(Number(doc.skipped))) : ''))
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        // 整档 dry-run 超过服务端单请求上限（1000 条）时分片预览并聚合计数。
        // 预演分片上报进度（preview 标记区分写盘文案）；复用 importStopRef 支持取消，
        // 停止后不再发送后续片，resolve null 让调用方保留原状、不弹错误。
        function previewImport(entries, mode) {
          var chunks = chunkEntriesPreservingLinks(entries, IMPORT_PREVIEW_CHUNK)
          // 分片会重排条目顺序：保留「条目对象 → 原始文件下标」映射，用于 rejected 重定位。
          var indexByEntry = new Map()
          for (var ei = 0; ei < entries.length; ei++) indexByEntry.set(entries[ei], ei)
          var plans = []
          var done = 0
          importStopRef.current = false
          setImportProgress({ done: 0, total: entries.length, preview: true })
          var chain = Promise.resolve()
          chunks.forEach(function (chunk) {
            chain = chain.then(function () {
              if (importStopRef.current) return undefined
              return api.import({ entries: chunk, dryRun: true, mode: mode }).then(function (payload) {
                var plan = (payload && payload.result) || {}
                plans.push(Object.assign({}, plan, { rejected: rebaseRejectedIndexes(plan.rejected, chunk, indexByEntry) }))
                done += chunk.length
                setImportProgress({ done: done, total: entries.length, preview: true })
              })
            })
          })
          return chain.then(function () { return importStopRef.current ? null : aggregateImportPlans(plans) })
        }

        function handleImportFile(e) {
          var file = e.target.files && e.target.files[0]
          e.target.value = ''
          if (!file || busy) return
          if (file.size > IMPORT_MAX_BYTES) {
            showToast('error', t('errBodyTooLarge'))
            return
          }
          // 读文件/解析窗口也置 busy：大文件读取期间不允许再次触发导入；
          // 读失败、JSON 语法错误、格式不符分别归因，不再一律提示「请求数据无效」。
          setBusy(true)
          file.text().then(function (text) {
            var parsed = parseImportText(text)
            if (!parsed.ok) {
              showToast('error', t(parsed.errorKey))
              return undefined
            }
            // 预演期即打开弹窗（plan=null）：大文件分片预演可能数十秒，
            // 进度与「停止」入口必须可见可达；预演完成后回填 plan。
            var runId = newImportRunId()
            setImportPlan({ entries: parsed.doc.entries, plan: null, mode: 'skip', runId: runId })
            setImportPreviewing(true)
            return previewImport(parsed.doc.entries, 'skip').then(function (plan) {
              if (!plan) { setImportPlan(null); return } // 用户停止预演：不报错，直接收起
              setImportPlan({ entries: parsed.doc.entries, plan: plan, mode: 'skip', runId: runId })
            })
          }).catch(function (err) {
            setImportPlan(null)
            if (err && err.code) writeFailure(err)
            else showToast('error', t('errReadFile') + t('labelSep') + errorText(err, t))
          }).then(function () {
            setImportPreviewing(false)
            setImportProgress(null)
            setBusy(false)
          })
        }

        function changeImportMode(mode) {
          if (busy || !importPlan) return
          setBusy(true)
          setImportPreviewing(true)
          previewImport(importPlan.entries, mode).then(function (plan) {
            if (!plan) return // 用户停止预演：保留原 plan 与模式
            setImportPlan({ entries: importPlan.entries, plan: plan, mode: mode, runId: importPlan.runId })
          }).catch(writeFailure).then(function () {
            setImportPreviewing(false)
            setImportProgress(null)
            setBusy(false)
          })
        }

        function confirmImport() {
          if (busy || !importPlan) return
          setBusy(true)
          setImportConfirming(true)
          importStopRef.current = false
          var entries = importPlan.entries
          var mode = importPlan.mode
          var chunks = chunkEntriesPreservingLinks(entries, IMPORT_CHUNK_SIZE)
          var totals = { imported: 0, updated: 0, deduplicated: 0, repaired: 0, rejected: [] }
          var written = 0
          var writeActual = 0
          var runId = importPlan.runId || newImportRunId()
          setImportProgress({ done: 0, total: entries.length })
          var chain = Promise.resolve()
          chunks.forEach(function (chunk, chunkIndex) {
            chain = chain.then(function () {
              // 用户点「停止」：当前片结算后不再发送后续片，已落盘片保留。
              if (importStopRef.current) return undefined
              return api.import({ entries: chunk, mode: mode, importId: runId, chunkIndex: chunkIndex }).then(function (payload) {
                var r = (payload && payload.result) || {}
                totals.imported += r.imported || 0
                totals.updated += r.updated || 0
                totals.deduplicated += r.deduplicated || 0
                totals.repaired += r.repaired || 0
                if (Array.isArray(r.rejected)) totals.rejected = totals.rejected.concat(r.rejected)
                writeActual += (Number(r.imported) || 0) + (Number(r.updated) || 0)
                written += chunk.length
                setImportProgress({ done: written, total: entries.length })
              })
            })
          })
          chain.then(function () {
            var stopped = importStopRef.current && written < entries.length
            setImportConfirming(false)
            setImportPlan(null)
            setImportProgress(null)
            if (stopped) {
              if (writeActual > 0 || Number(totals.repaired) > 0) bumpDataVersion()
              showToast('ok', t('importStopped').replace('{d}', String(writeActual)).replace('{t}', String(entries.length)))
              setPage(0)
              resetListScroll()
              // 写已结算：刷新失败单独兜底，不得落入 partial-fail 误报、不二次 bump。
              return refreshRef.current().catch(function () {})
            }
            if (writeActual > 0 || Number(totals.repaired) > 0) bumpDataVersion()
            var summary = importSummary(totals)
            var repairedNote = summary.repaired > 0 ? ' · ' + t('importRepaired').replace('{n}', String(summary.repaired)) : ''
            showToast('ok', t('imported') + ' · ' + t('importNew') + ' ' + summary.imported + ' / ' + t('importUpdated') + ' ' + summary.updated + ' / ' + t('importDup') + ' ' + summary.deduplicated + ' / ' + t('importRej') + ' ' + summary.rejected + repairedNote)
            setPage(0)
            resetListScroll()
            return refreshRef.current().catch(function () {})
          }).catch(function (err) {
            // 分片导入中途失败：已提交的片是完整的；保留弹窗，用户可用同一 runId 重试，
            // 已成功的片由服务端幂等回执直接返回、不会二次写盘。
            setImportConfirming(false)
            if (writeActual > 0 || Number(totals.repaired) > 0) bumpDataVersion()
            var text = t('importPartialFail').replace('{d}', String(writeActual)).replace('{t}', String(entries.length)) + t('errJoin') + errorText(err, t)
            showToast('error', text)
            setImportProgress(null)
            // 已报 partial-fail：刷新失败再兜底一次，避免叠加 writeFailure 误报。
            return refreshRef.current().catch(function () {})
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function auditParams() {
          if (selection === 'global') return { scope: 'global' }
          if (selection === 'all') return { scope: 'all', workspace: currentCwd }
          return { scope: 'workspace', workspace: selection }
        }
        function handleAudit() {
          if (busy) return
          setBusy(true)
          // 查重大库是同步全库计算（数秒）：给出进行中反馈（中性 info 而非成功图标），
          // 并依赖 api.similar 的独立 120s 超时（第十轮审计 C5/C9）。
          showToast('info', t('auditRunning'))
          var params = auditParams()
          api.similar(params).then(function (payload) {
            setAudit({ pairs: (payload && payload.pairs) || [], params: params })
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function handleSupersedePair(pair) {
          if (busy || !audit) return
          setBusy(true)
          var params = audit.params
          api.update({ id: pair.newer.id, supersedes: pair.older.id, workspace: pair.newer.scope === 'workspace' ? params.workspace : undefined }).then(function () {
            bumpDataVersion()
            showToast('ok', t('auditSuperseded'))
            // 取代已成功：相似对刷新失败保留旧列表（弹窗可重开），列表刷新失败自处理，
            // 都不落入 writeFailure 误报「取代失败」。
            return api.similar(params).catch(function () { return null })
          }).then(function (payload) {
            if (payload) setAudit({ pairs: (payload && payload.pairs) || [], params: params })
            return refreshRef.current().catch(function () {})
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function dismissPair(pair) {
          if (!audit) return
          setAudit(Object.assign({}, audit, { pairs: audit.pairs.filter(function (p) { return !(p.older.id === pair.older.id && p.newer.id === pair.newer.id) }) }))
        }

        // ---- 存量治理（v0.29.0）：精确重复组合并 + 批量归档/恢复 ----
        function handleDuplicates() {
          if (busy) return
          setBusy(true)
          var params = auditParams()
          api.duplicates(params).then(function (payload) {
            setDuplicates({ groups: (payload && payload.groups) || [], params: params })
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function mergeDuplicatesNow() {
          if (busy || !duplicates) return
          setBusy(true)
          var params = duplicates.params
          api.mergeDuplicates({ scope: params.scope, workspace: params.workspace }).then(function (payload) {
            var result = (payload && payload.result) || {}
            var archived = Array.isArray(result.archived) ? result.archived : []
            bumpDataVersion()
            setDuplicates(null)
            showToast(archived.length > 0 ? 'ok' : 'info',
              t('duplicatesMerged').replace('{n}', String(Number(result.mergeable) || 0)).replace('{m}', String(archived.length)))
            return refreshRef.current().catch(function () {})
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function bulkArchiveSelected() {
          if (busy || selected.length === 0) return
          var ids = selected.slice()
          var restoring = statusFilter === 'archived'
          setBusy(true)
          // 用 workspaceTarget（所选作用域目录）而非 currentCwd：浏览其它工作区时
          // 批量归档/恢复才能命中条目（C2；selection=all 时其值即 currentCwd）。
          api.archive({ ids: ids, archived: !restoring, workspace: workspaceTarget }).then(function (payload) {
            var result = (payload && payload.result) || {}
            var done = restoring ? (result.restored || []) : (result.archived || [])
            bumpDataVersion()
            setSelected([])
            if (done.length > 0) {
              showToast('ok', t(restoring ? 'bulkRestored' : 'bulkArchived').replace('{n}', String(done.length)), {
                label: t('undo'),
                run: function () {
                  api.archive({ ids: done, archived: restoring, workspace: workspaceTarget }).then(function () {
                    bumpDataVersion()
                    refreshRef.current().catch(function () {})
                  }).catch(writeFailure)
                },
              })
            } else {
              showToast('error', t('errStaleSelection'))
            }
            return refreshRef.current().catch(function () {})
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function renderStats() {
          var total = stats ? stats.total : null
          var cats = ['preference', 'fact', 'decision']
          var filtered = !!(query || categoryFilter || originFilter || tagFilter || statusFilter !== 'active')
          var scopeText = stats && selection === 'all'
            ? t('statsScope').replace('{g}', String(stats.byScope.global || 0)).replace('{w}', String(stats.byScope.workspace || 0))
            : null
          return h('div', { className: 'dm_stats' },
            h('div', { className: 'dm_stats_head' },
              h('div', { className: 'dm_stats_total' },
                h('span', { className: 'dm_stats_num' }, total === null ? '—' : String(total)),
                h('span', { className: 'dm_stats_unit' }, t('statsUnit'))),
              h('div', { className: 'dm_stats_div' }),
              h('div', { className: 'dm_stats_dist' },
                h('div', { className: 'dm_dist_bar', 'aria-hidden': true },
                  stats && stats.total > 0 ? cats.map(function (cat) {
                    var n = stats.byCategory[cat] || 0
                    if (n === 0) return null
                    return h('div', {
                      key: cat, className: 'dm_dist_seg dm_dist_seg_' + cat,
                      style: { flexGrow: n },
                      title: t(CATEGORY_META[cat].label) + t('labelSep') + n,
                    })
                  }) : null)),
              scopeText ? h('div', { className: 'dm_stats_scope' }, scopeText) : null,
              filtered ? h('button', { className: 'dm_stats_clear', onClick: clearAllFilters }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 }), t('clearFilters')) : null),
            h('div', { className: 'dm_stats_body' },
              h('div', { className: 'dm_chips', role: 'group', 'aria-label': t('categoryLabel') },
                h('span', { className: 'dm_filter_label' }, t('categoryLabel')),
                h('button', {
                  className: 'dm_chip', 'aria-pressed': categoryFilter === '',
                  onClick: function () { changeCategory('') },
                }, h(Icon, { name: 'layers', size: 13 }), t('categoryAll'), h('span', { className: 'dm_chip_n' }, total === null ? '…' : String(total))),
                cats.map(function (cat) {
                  var meta = CATEGORY_META[cat]
                  var n = categoryChipCount(stats, cat, categoryFilter)
                  return h('button', {
                    key: cat, className: 'dm_chip', 'aria-pressed': categoryFilter === cat,
                    style: { '--dm-chip-c': meta.cat, '--dm-chip-soft': meta.soft },
                    onClick: function () { changeCategory(categoryFilter === cat ? '' : cat) },
                  }, h(Icon, { name: meta.icon, size: 13, strokeWidth: 2 }), t(meta.label),
                    n === undefined ? null : h('span', { className: 'dm_chip_n' }, n === null ? '…' : String(n)))
                })),
              h('div', { className: 'dm_chips dm_chips_status', role: 'group', 'aria-label': t('statusFilterLabel') },
                h('span', { className: 'dm_filter_label' }, t('statusFilterLabel')),
                STATUS_CHIPS.map(function (s) {
                  var n = stats && stats.byStatus ? (s.key === 'all' ? (stats.byStatus.active || 0) + (stats.byStatus.superseded || 0) + (stats.byStatus.expired || 0) + (stats.byStatus.archived || 0) : (stats.byStatus[s.key] || 0)) : null
                  return h('button', {
                    key: s.key, className: 'dm_chip', 'aria-pressed': statusFilter === s.key,
                    style: { '--dm-chip-c': s.c, '--dm-chip-soft': 'color-mix(in srgb,' + s.c + ' 12%,transparent)' },
                    onClick: function () { changeStatus(s.key) },
                  }, h(Icon, { name: s.icon, size: 13, strokeWidth: 2 }), t(s.label),
                    h('span', { className: 'dm_chip_n' }, n === null ? '…' : String(n)))
                }))))
        }

        // 学习分区（v3）：只展示待确认候选与最近自动写入；数据来自 /learning 只读端点。
        // 待确认候选永不注入、批准前不生效；「归档」撤销自动写入复用可逆归档而非删除。
        function renderLearning() {
          var data = learning || {}
          var pending = Array.isArray(data.pending) ? data.pending : []
          var recent = Array.isArray(data.recentAuto) ? data.recentAuto : []
          var pendingSkillsEarly = Array.isArray(data.pendingSkills) ? data.pendingSkills : []
          var approvedSkillsEarly = Array.isArray(data.approvedSkills) ? data.approvedSkills : []
          var digestsEarly = Array.isArray(data.digests) ? data.digests : []
          if (pending.length === 0 && recent.length === 0 && pendingSkillsEarly.length === 0 && approvedSkillsEarly.length === 0 && digestsEarly.length === 0) return null
          var rows = []
          // 行内正文默认截断（CSS line-clamp），点击/回车展开完整内容再判断；
          // 避免长候选/周报把工具栏与记忆列表挤出首屏。
          function expandText(key, text) {
            var open = learnExpanded === key
            function toggle() { setLearnExpanded(function (prev) { return prev === key ? null : key }) }
            return h('span', {
              className: 'dm_learn_text dm_learn_expand' + (open ? ' dm_learn_text_open' : ''),
              title: text, role: 'button', tabIndex: 0, 'aria-expanded': open,
              onClick: toggle,
              onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
            }, text)
          }
          // v0.31.0：批量审批（仅记忆候选；逐条仍在下方，可单独处理）。
          if (pending.length > 1) {
            rows.push(h('div', { key: 'batch-pending', className: 'dm_learn_row', 'data-testid': 'dm-learning-batch' },
              h('div', { className: 'dm_learn_main' }, h('span', { className: 'dm_learn_text' }, t('learningBatchHint').replace('{n}', String(pending.length)))),
              h('div', { className: 'dm_learn_actions' },
                h('button', { className: 'dm_btn dm_btn_mini dm_btn_primary', disabled: busy, onClick: approveAllPending }, t('learningApproveAll')),
                h('button', { className: 'dm_btn dm_btn_mini', disabled: busy, onClick: rejectAllPending }, t('learningRejectAll')))))
          }
          pending.slice(0, learnShowAll ? pending.length : 5).forEach(function (item) {
            // U3：候选来源可辨——分类徽章＋作用域（含工作区名）＋疑似冲突计数，
            // 让跨工作区候选（C1）与冲突候选在批准前可见可辨。
            var conflictN = Array.isArray(item.conflictWith) ? item.conflictWith.length : 0
            var cwdShort = ''
            if (item.scope === 'workspace' && item.cwd) {
              var trimmed = String(item.cwd).replace(/[\\/]+$/, '')
              var slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
              cwdShort = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
            }
            rows.push(h('div', { key: 'pending-' + item.id, className: 'dm_learn_row', 'data-testid': 'dm-learning-pending' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningPendingBadge')),
                h(Badge, { category: item.category, t: t }),
                h('span', { className: 'dm_learn_reason', title: item.cwd || '' }, item.scope === 'workspace' ? t('scopeWorkspace') + (cwdShort ? t('labelSep') + cwdShort : '') : t('scopeGlobal')),
                conflictN > 0 ? h('span', { className: 'dm_learn_conflict' }, t('learningConflict').replace('{n}', String(conflictN))) : null,
                expandText('pending-' + item.id, item.content),
                item.reason ? h('span', { className: 'dm_learn_reason' }, t('learningReason') + item.reason) : null),
              h('div', { className: 'dm_learn_actions' },
                h('button', { className: 'dm_btn dm_btn_mini dm_btn_primary', disabled: busy, onClick: function () { approvePendingItem(item) } }, t('learningApprove')),
                h('button', { className: 'dm_btn dm_btn_mini', disabled: busy, onClick: function () { rejectPendingItem(item) } }, t('learningReject')))))
          })
          // U2：>5 条时提供「显示全部/收起」，先审后批，避免盲批。
          if (pending.length > 5) {
            rows.push(h('div', { key: 'pending-toggle', className: 'dm_learn_row', 'data-testid': 'dm-learning-showall' },
              h('div', { className: 'dm_learn_main' },
                h('button', { className: 'dm_btn dm_btn_mini', onClick: function () { setLearnShowAll(!learnShowAll) } },
                  learnShowAll ? t('learningCollapse') : t('learningShowAll').replace('{n}', String(pending.length))))))
          }
          recent.slice(0, 3).forEach(function (entry) {
            // 已归档的自动写入仍会出现在最近列表：按钮须随真实状态给「恢复」，
            // 否则用户在此归档后无法撤销（旧实现硬编码 archived:false）。
            var archived = entry.archived === true
            rows.push(h('div', { key: 'auto-' + entry.id, className: 'dm_learn_row dm_learn_row_auto', 'data-testid': 'dm-learning-auto' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningAutoBadge')),
                h('span', {
                  className: 'dm_learn_text dm_learn_link', title: entry.content,
                  role: 'button', tabIndex: 0, 'aria-label': t('jumpToEntry') + t('labelSep') + entry.content,
                  onClick: function () { jumpToEntry(entry.id) },
                  onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToEntry(entry.id) } },
                }, entry.content),
                archived ? h('span', { className: 'dm_learn_reason' }, t('statusArchived')) : null,
                h('span', { className: 'dm_learn_time' }, settings && settings.effective.relativeTime === false ? formatTime(entry.updated) : relativeTime(entry.updated, Date.now(), uiLang()))),
              h('div', { className: 'dm_learn_actions' },
                h('button', { className: 'dm_btn dm_btn_mini', disabled: busy, onClick: function () { archiveRecentAuto(entry) } }, archived ? t('restore') : t('learningArchive')))))
          })
          // v0.30.0：程序性知识（skill）候选——批准前不可加载/不索引。
          var pendingSkills = Array.isArray(data.pendingSkills) ? data.pendingSkills : []
          pendingSkills.slice(0, learnShowAll ? pendingSkills.length : 5).forEach(function (skill) {
            rows.push(h('div', { key: 'skill-' + skill.id, className: 'dm_learn_row', 'data-testid': 'dm-learning-skill-pending' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningSkillBadge')),
                h('span', { className: 'dm_learn_text', title: skill.trigger }, t('learningSkillRow').replace('{name}', String(skill.name)).replace('{trigger}', String(skill.trigger))),
                h('span', { className: 'dm_learn_time' }, 'v' + String(skill.version))),
              h('div', { className: 'dm_learn_actions' },
                h('button', { className: 'dm_btn dm_btn_mini dm_btn_primary', disabled: busy, onClick: function () { approveSkillItem(skill) } }, t('learningApprove')),
                h('button', { className: 'dm_btn dm_btn_mini', disabled: busy, onClick: function () { rejectSkillItem(skill) } }, t('learningReject')))))
          })
          var approvedSkills = Array.isArray(data.approvedSkills) ? data.approvedSkills : []
          approvedSkills.slice(0, 3).forEach(function (skill) {
            rows.push(h('div', { key: 'skill-ok-' + skill.id, className: 'dm_learn_row', 'data-testid': 'dm-learning-skill-approved' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningSkillApprovedBadge')),
                h('span', { className: 'dm_learn_text', title: skill.trigger }, t('learningSkillRow').replace('{name}', String(skill.name)).replace('{trigger}', String(skill.trigger))),
                h('span', { className: 'dm_learn_time' }, 'v' + String(skill.version))),
              h('div', { className: 'dm_learn_actions' },
                skill.version > 1 && skill.revised
                  ? h('button', { className: 'dm_btn dm_btn_mini', disabled: busy, onClick: function () { rollbackSkillItem(skill) } }, t('learningSkillRollback'))
                  : null)))
          })
          var digests = Array.isArray(data.digests) ? data.digests : []
          if (digests.length > 0) {
            var latestDigest = digests[digests.length - 1]
            rows.push(h('div', { key: 'digest', className: 'dm_learn_row', 'data-testid': 'dm-learning-digest' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningDigestBadge')),
                expandText('digest', String(latestDigest.text || '')))))
          }
          var auditRows = auditCounts(Array.isArray(data.audit) ? data.audit : [])
          if (auditRows.length > 0) {
            var auditLabels = {
              auto_saved: t('auditAutoSaved'), pending_created: t('auditPendingCreated'), pending_approved: t('auditPendingApproved'),
              pending_rejected: t('auditPendingRejected'), pending_approved_batch: t('auditPendingApproved'), pending_rejected_batch: t('auditPendingRejected'),
              duplicates_merged: t('auditDuplicatesMerged'), entries_archived: t('auditArchived'), entries_restored: t('auditRestored'),
              skill_pending: t('auditSkill'), skill_approved: t('auditSkill'), skill_rejected: t('auditSkill'),
              skill_revised: t('auditSkill'), skill_rolled_back: t('auditSkill'), skill_created: t('auditSkill'),
              skill_archived: t('auditSkill'), skill_restored: t('auditSkill'), skill_candidate_created: t('auditSkill'),
              digest_emitted: t('auditDigest'),
            }
            var auditText = auditRows.slice(0, 8).map(function (row) { return (Object.prototype.hasOwnProperty.call(auditLabels, row.type) ? auditLabels[row.type] : row.type) + ' ' + row.count }).join(' · ')
            rows.push(h('div', { key: 'audit', className: 'dm_learn_row', 'data-testid': 'dm-learning-audit' },
              h('div', { className: 'dm_learn_main' },
                h('span', { className: 'dm_learn_badge' }, t('learningAuditTitle')),
                expandText('audit', auditText))))
          }
          return h('section', { className: 'dm_group dm_learn', 'data-testid': 'dm-learning' },
            h('div', { className: 'dm_section_title' }, h(Icon, { name: 'zap', size: 13 }), t('learningTitle'),
              pending.length > 0 ? h('span', { className: 'dm_section_n' }, t('learningPendingCount').replace('{n}', String(pending.length))) : null),
            h('div', { className: 'dm_group_body' }, rows))
        }

        function renderList() {
          var filtered = !!(query || categoryFilter || originFilter || tagFilter || statusFilter !== 'active')
          // 只有「单页完整结果」时区块计数才等于真实总数；分页或筛选状态下不显示，
          // 避免与统计条的全量数字互相矛盾。
          var exactCounts = sectionCountsExact(page, hasMore, filtered)
          var pager = (page > 0 || hasMore) ? h('div', { className: 'dm_pager' },
            h('button', { className: 'dm_btn', disabled: page === 0 || busy, onClick: function () { changePage(page - 1) } }, h(Icon, { name: 'chevL', size: 14 }), t('pagePrev')),
            h('span', { className: 'dm_pageinfo' }, t('pageInfo').replace('{page}', String(page + 1))),
            h('button', { className: 'dm_btn', disabled: !hasMore || busy, onClick: function () { changePage(page + 1) } }, t('pageNext'), h(Icon, { name: 'chevR', size: 14 }))) : null
          var hiddenHint = hidden && hidden.total > 0
            ? h('div', { className: 'dm_hidden_hint' },
              h(Icon, { name: 'info', size: 14, style: { flexShrink: 0, marginTop: 1 } }),
              h('span', { style: { flex: 1 } }, t('hiddenHint').replace('{n}', String(hidden.total)).replace('{s}', String(hidden.superseded)).replace('{e}', String(hidden.expired)).replace('{a}', String(hidden.archived))),
              statusFilter !== 'all' ? h('button', { className: 'dm_btn dm_btn_mini', onClick: function () { changeStatus('all') } }, t('hiddenViewAll')) : null)
            : null
          // 刷新失败但列表已有内容（如窗口聚焦自动刷新遇宿主短暂 busy）：保留列表与滚动
          // 上下文，仅在顶部加可关闭错误横幅（U5）；只有空列表才整块替换为错误态。
          var listErrorBanner = (listError && entries.length > 0)
            ? h('div', { className: 'dm_listerror', role: 'alert' },
              h(Icon, { name: 'alert', size: 14, style: { flexShrink: 0, marginTop: 1, color: 'var(--dm-danger)' } }),
              h('span', { style: { flex: 1 } }, t('listError') + t('labelSep') + listError),
              h('button', { className: 'dm_btn dm_btn_mini', onClick: function () { refreshEntries() } }, h(Icon, { name: 'undo', size: 12 }), t('retry')),
              h('button', { className: 'dm_btn dm_btn_mini', 'aria-label': t('close'), title: t('close'), onClick: function () { setListError('') } }, h(Icon, { name: 'x', size: 12 })))
            : null
          if (listError && entries.length === 0) {
            return h('div', { className: 'dm_empty', role: 'alert' },
              h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
              h('div', null, t('listError') + t('labelSep') + listError),
              h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: function () { focusPage(); refreshEntries() } }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
          }
          if (entries.length === 0 && page > 0) {
            // 翻页回退进行中（删除末页最后几条触发自动回退 / 页码超界）：显示加载态
            // 而非空态——否则闪现「记忆库还是空的」且与统计条旧 total 同屏矛盾。
            return h('div', null, hiddenHint, h(Skeletons))
          }
          if (entries.length === 0) {
            // 空态区分「筛选无结果 / 某工作区为空 / 整库为空」，避免切到空工作区误报「记忆库还是空的」。
            var scopedEmpty = selection !== 'all' && selection !== 'global'
            var emptyTitle = filtered ? t('noResults') : scopedEmpty ? t('emptyScopeTitle') : t('emptyTitle')
            var emptyHint = filtered ? t('noResultsHint') : scopedEmpty ? t('emptyScopeHint') : t('emptyHint')
            return h('div', null, hiddenHint,
              h('div', { className: 'dm_empty' },
                h(EmptyArt, { small: filtered }),
                h('div', { className: 'dm_empty_title' }, emptyTitle),
                h('div', { className: 'dm_empty_hint' }, emptyHint),
                filtered
                  ? h('button', { className: 'dm_btn', style: { marginTop: 14 }, onClick: clearAllFilters }, h(Icon, { name: 'x', size: 13 }), t('clearFilters'))
                  : page === 0 ? h('button', { className: 'dm_btn dm_btn_primary', style: { marginTop: 14 }, onClick: openCreate }, h(Icon, { name: 'plus', size: 14, strokeWidth: 2.2 }), t('newMemory')) : null),
              pager)
          }
          function rows(list, offset) {
            return list.map(function (entry, i) {
              return h(MemoryCard, {
                key: entry.id, entry: entry, t: t, index: offset + i,
                selected: selected.indexOf(entry.id) !== -1,
                injected: injected.indexOf(entry.id) !== -1,
                useRelative: !settings || settings.effective.relativeTime,
                onToggleSelect: toggleSelect,
                onEdit: openEdit, onDelete: openDelete,
                onTogglePin: togglePin, onToggleArchive: toggleArchive, onJumpTo: jumpToEntry,
                onTagClick: filterByTag,
                busy: busy,
                onToast: function (text, kind) { showToast(kind, text) },
              })
            })
          }
          // 分组容器：区块头 + 索引行面板（同一作用域的行共享一个细线面板，扫描时分组明确）。
          function groupBlock(title, body) {
            return h('section', { className: 'dm_group' }, title, h('div', { className: 'dm_group_body' }, body))
          }
          if (selection !== 'all') return h('div', { 'aria-busy': busy ? 'true' : 'false' }, listErrorBanner, hiddenHint, groupBlock(null, rows(entries, 0)), pager)
          var groups = groupEntries(entries)
          return h('div', { 'aria-busy': busy ? 'true' : 'false' }, listErrorBanner, hiddenHint,
            groups.global.length ? groupBlock(h('div', { className: 'dm_section_title' }, h(Icon, { name: 'globe', size: 13 }), t('scopeGlobal'), exactCounts ? h('span', { className: 'dm_section_n' }, groups.global.length + ' ' + t('entriesUnit')) : null), rows(groups.global, 0)) : null,
            groups.workspace.length ? groupBlock(h('div', { className: 'dm_section_title' }, h(Icon, { name: 'folder', size: 13 }), t('scopeWorkspace'), exactCounts ? h('span', { className: 'dm_section_n' }, groups.workspace.length + ' ' + t('entriesUnit')) : null), rows(groups.workspace, groups.global.length)) : null,
            pager)
        }

        var fileInputRef = useRef(null)

        var noAnim = settings && !settings.effective.animations
        return h('div', { ref: pageRef, tabIndex: -1, className: 'dm_page' + (selected.length > 0 ? ' dm_selecting' : '') + (noAnim ? ' dm_no_anim' : '') + (viewMode === 'compact' ? ' dm_compact' : '') },
          // 版心：内容最宽 1040px 居中，宽屏下不再被拉成一条长线。
          h('div', { className: 'dm_inner' },
          h('div', { className: 'dm_header' },
            h('div', { className: 'dm_brand' },
              h('div', { className: 'dm_brand_medal' }, h(NavIcon, { size: 20 })),
              h('div', null,
                h('div', { className: 'dm_title_row' },
                  h('h1', { className: 'dm_title' }, tab === 'settings' ? t('tabSettings') : t('title')),
                  // 当前插件版本（/status.version）：常驻可见、加载失败留空不显示假值。
                  version ? h('span', { className: 'dm_version', title: t('versionLabel') + version, 'data-testid': 'dm-version' }, 'v' + version) : null),
                h('div', { className: 'dm_subtitle' }, tab === 'settings' ? t('settingsSubtitle') : t('subtitle')))),
            tab === 'memories'
              ? h('button', { className: 'dm_btn dm_btn_primary dm_cta', onClick: openCreate, disabled: busy }, h(Icon, { name: 'plus', size: 15, strokeWidth: 2.2 }), t('newMemory'))
              : null),
          h('div', { className: 'dm_tabs', role: 'tablist', 'aria-label': t('title') },
            h('button', {
              ref: tabMemoriesRef, id: 'dm-tab-memories',
              role: 'tab', 'aria-selected': tab === 'memories', 'aria-controls': 'dm-panel-memories',
              tabIndex: tab === 'memories' ? 0 : -1,
              className: 'dm_tab' + (tab === 'memories' ? ' dm_tab_active' : ''),
              onClick: function () { switchTab('memories') }, onKeyDown: onTabKey,
            }, h(Icon, { name: 'layers', size: 15 }), t('tabMemories'), h('span', { className: 'dm_tab_n' }, stats ? String(stats.total) : '…')),
            h('button', {
              ref: tabSettingsRef, id: 'dm-tab-settings',
              role: 'tab', 'aria-selected': tab === 'settings', 'aria-controls': 'dm-panel-settings',
              tabIndex: tab === 'settings' ? 0 : -1,
              className: 'dm_tab' + (tab === 'settings' ? ' dm_tab_active' : ''),
              onClick: function () { switchTab('settings') }, onKeyDown: onTabKey,
            }, h(Icon, { name: 'sliders', size: 15 }), t('tabSettings'))),
          // 两个 tabpanel 常驻 DOM（非激活用 hidden）：aria-controls 始终指向存在的面板，
// 同时保留列表/设置的滚动与焦点上下文；hidden 使非激活面板不可聚焦。
          h('div', { id: 'dm-panel-memories', role: 'tabpanel', 'aria-labelledby': 'dm-tab-memories', hidden: tab !== 'memories' },
              renderStats(),
              renderLearning(),
              h('div', { className: 'dm_toolbar_wrap' },
                h('div', { className: 'dm_toolbar' },
                  h(Select, {
                    ariaLabel: t('scopeLabel'), value: selection, minWidth: 170, onChange: changeSelection,
                    options: options.map(function (opt) {
                      if (opt.kind === 'all') return { value: 'all', label: t('scopeAll'), icon: 'layers' }
                      if (opt.kind === 'global') return { value: 'global', label: t('scopeGlobal'), icon: 'globe' }
                      return { value: opt.value, label: (cwdCompareKey(opt.value) === cwdCompareKey(currentCwd) ? '● ' : '') + opt.value, hint: String(opt.count || 0), icon: 'folder' }
                    }).concat(unknownWorkspaces.map(function (w) {
                      return { value: 'unknown-' + w.key, label: t('workspaceUnknown') + ' (' + String(w.key).slice(0, 8) + '…)', icon: 'folder', disabled: true }
                    })),
                  }),
                  h(Select, {
                    ariaLabel: t('originFilterLabel'), value: originFilter, minWidth: 120, onChange: changeOrigin,
                    options: [
                      { value: '', label: t('originAll'), icon: 'layers' },
                      { value: 'auto', label: t('originAuto'), icon: 'zap' },
                      { value: 'manual', label: t('originManual'), icon: 'edit' },
                    ],
                  }),
                  h('div', { className: 'dm_tagwrap' },
                    h('input', {
                      className: 'dm_taginput', type: 'text', 'aria-label': t('tagFilterPlaceholder'), placeholder: t('tagFilterPlaceholder'), title: t('tagFilterHint'),
                      value: tagFilter, onChange: function (e) { changeTag(e.target.value) },
                    }),
                    tagFilter ? h('button', { className: 'dm_tagclear', 'aria-label': t('clearTag'), title: t('clearTag'), onClick: function () { changeTag('') } }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 })) : null),
                  h('div', { className: 'dm_searchwrap' },
                    h('span', { className: 'dm_search_icon' }, h(Icon, { name: 'search', size: 15 })),
                    h('input', {
                      ref: searchRef, className: 'dm_search', type: 'text', inputMode: 'search',
                      'aria-label': t('searchPlaceholder'), placeholder: t('searchPlaceholder'), title: t('searchHint'),
                      value: query, onChange: function (e) { changeQuery(e.target.value) },
                    }),
                    query ? h('button', { className: 'dm_search_clear', 'aria-label': t('clearSearch'), title: t('clearSearch'), onClick: function () { changeQuery('') } }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 })) : null),
                  // 列表密度切换：紧凑/舒适（写入设置覆盖层，持久生效；草稿即时切换视图）。
                  // 图标之外保留可见文字（视图/舒适/紧凑），不让用户猜图标含义。
                  h('div', { className: 'dm_viewtoggle', role: 'group', 'aria-label': t('viewModeLabel') },
                    h('span', { className: 'dm_viewtoggle_label' }, t('viewLabel')),
                    h('button', {
                      type: 'button', className: 'dm_viewbtn' + (viewMode === 'comfortable' ? ' dm_viewbtn_on' : ''),
                      'aria-pressed': viewMode === 'comfortable', 'aria-label': t('viewComfortable'), title: t('viewComfortable'),
                      disabled: busy, onClick: function () { setViewMode('comfortable') },
                    }, t('viewComfortable')),
                    h('button', {
                      type: 'button', className: 'dm_viewbtn' + (viewMode === 'compact' ? ' dm_viewbtn_on' : ''),
                      'aria-pressed': viewMode === 'compact', 'aria-label': t('viewCompact'), title: t('viewCompact'),
                      disabled: busy, onClick: function () { setViewMode('compact') },
                    }, t('viewCompact'))),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: handleExport, disabled: busy || phase !== 'ready' }, t('export')),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: function () { if (fileInputRef.current) fileInputRef.current.click() }, disabled: busy || phase !== 'ready' }, t('import')),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: handleAudit, disabled: busy || phase !== 'ready' }, t('audit')),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: handleDuplicates, disabled: busy || phase !== 'ready' }, t('duplicates')),
                  h('button', { className: 'dm_btn dm_toolbtn', 'aria-label': t('refreshList'), title: t('refreshList'), onClick: function () { refreshRef.current().catch(function () {}); loadLearning() }, disabled: busy || phase !== 'ready' }, t('refresh')),
                  h('input', { ref: fileInputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: handleImportFile }))),
              unknownWorkspaces.length > 0 ? h('div', { className: 'dm_hint', style: { margin: '8px 0 0' } }, t('unknownWorkspaceHint')) : null,
              // 批量选择浮栏放在列表之前（视觉仍是 fixed 底部）：键盘 Tab 顺序靠近工具栏，
              // 不必先穿过上百张卡片才能到达「删除所选」。
              selected.length > 0
                ? h('div', { className: 'dm_selbar', role: 'region', 'aria-label': t('bulkSelected').replace('{n}', String(selected.length)) },
                  h('span', { className: 'dm_selbar_n', 'aria-live': 'polite' }, t('bulkSelected').replace('{n}', String(selected.length))),
                  h('button', { className: 'dm_btn', onClick: bulkArchiveSelected, disabled: busy }, t(statusFilter === 'archived' ? 'bulkRestore' : 'bulkArchive')),
                  h('button', { className: 'dm_btn dm_btn_danger_solid', onClick: openBulkDelete, disabled: busy }, h(Icon, { name: 'trash', size: 14 }), t('bulkDelete')),
                  h('button', { className: 'dm_btn', onClick: function () { setSelected([]); if (pageRef.current) { try { pageRef.current.focus() } catch { /* ignore */ } } }, disabled: busy }, t('clearSelection')))
                : null,
              phase === 'loading' ? h(Skeletons)
                : phase === 'error' ? h('div', { className: 'dm_empty' },
                  h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
                  h('div', null, t('loadError') + t('labelSep') + errorTextState),
                  h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: function () { focusPage(); loadInitial() } }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
                  : renderList()),
          h('div', { id: 'dm-panel-settings', role: 'tabpanel', 'aria-labelledby': 'dm-tab-settings', hidden: tab !== 'settings' },
            h(SettingsPage, {
              view: settings, draft: draft, busy: busy, status: settingsStatus, t: t, api: api, workspace: currentCwd, active: tab === 'settings',
              error: settingsError, onRetry: function () { focusPage(); loadSettings() }, onRetrySave: retrySaveSettings,
              onChange: changeSetting, onReset: resetSettings, onBackup: backupNow,
              onToast: function (text, kind) { showToast(kind, text) },
            })),
          ),
          editor ? h(EditorModal, { draft: editor, setDraft: setEditor, t: t, workspaceTarget: workspaceTarget, busy: busy, onSave: handleSave, onClose: function () { if (!busy) setEditor(null) } }) : null,
          confirm ? h(ConfirmModal, { entries: confirm.entries, t: t, busy: busy, onConfirm: handleDelete, onClose: function () { if (!busy) setConfirm(null) } }) : null,
          importPlan ? h(ImportModal, { plan: importPlan.plan, mode: importPlan.mode, progress: importProgress, confirming: importConfirming, previewing: importPreviewing, t: t, busy: busy, onStop: function () { importStopRef.current = true }, onConfirm: confirmImport, onModeChange: changeImportMode, onClose: function () { if (!busy) setImportPlan(null) } }) : null,
          audit ? h(AuditModal, { pairs: audit.pairs, t: t, busy: busy, onSupersede: handleSupersedePair, onDismiss: dismissPair, onClose: function () { if (!busy) setAudit(null) } }) : null,
          duplicates ? h(DuplicatesModal, { groups: duplicates.groups, t: t, busy: busy, onMerge: mergeDuplicatesNow, onClose: function () { if (!busy) setDuplicates(null) } }) : null,
          toast ? h(Toast, { key: toast.id, toast: toast, t: t, raised: selected.length > 0, onClose: dismissToast, actionRef: toastActionRef, onPause: pauseToast, onResume: resumeToast }) : null)
      }

      return {
        inject: ['slots', 'locale'],
        apply: function (ctx) {
          ctx.effect(function () {
            var disposers = []
            disposers.push(ctx.locale.register(NS, { zh: ZH, en: EN }))
            var t = ctx.locale.bind(NS)

            var style = document.createElement('style')
            style.id = 'dsh-memory-style'
            style.textContent = CSS
            document.head.appendChild(style)
            disposers.push(function () { style.remove() })

            function Page() { return h(MemoryPage, { ctx: ctx, t: t }) }
            disposers.push(ctx.slots.inject('main', function () {
              return ctx.slots.register({ name: 'main', key: 'dsh-memory', locale: NS }, Page)
            }))
            disposers.push(ctx.slots.inject('sidebar.panellist', function () {
              return ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-memory', order: 20, label: function () { return t('nav') }, locale: NS }, NavIcon)
            }))
            return function () {
              var list = disposers.slice().reverse()
              for (var i = 0; i < list.length; i++) {
                try { list[i]() } catch { /* 卸载期容错 */ }
              }
            }
          })
        },
      }
    },
  })
})(typeof window !== 'undefined' ? window : globalThis)
