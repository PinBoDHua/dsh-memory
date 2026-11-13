/**
 * dsh-memory 浏览器客户端 —— 手写 classic script，无构建步骤。
 * 纯逻辑函数经 UMD 尾部导出供 node 单测（缝 4）；浏览器侧注册惰性 factory。
 * 与 dsh-reverse-proxy-connect 同一产物形态：window.__ModuleLoader__.load。
 *
 * 面板：layout main keyed 槽（key=dsh-memory）+ sidebar.panellist 导航。
 * 数据面：同源 fetch /plugins/dsh-memory/*（进程级 token，写操作带 X-RPC-Key）。
 *
 * 视觉语言「记忆星丛 Memory Atlas」：靛紫主色渐变 + 分类三色（偏好琥珀/事实湛蓝/
 * 决策翡翠）+ 玫红警示；环境光晕背景、分类色轨卡片、统计分布条、骨架屏、
 * 撤销吐司、批量选择浮栏。颜色全部走 --dsw-alias-* 令牌 + 插件自有变量，
 * 深色分支跟随宿主 body[data-ds-dark-theme]；文案 ctx.locale（zh/en）。
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
    var seen = {}
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
    return { ok: true }
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
    var options = [{ value: 'global', kind: 'global' }]
    var seen = {}
    for (var i = 0; i < workspaces.length; i++) {
      var ws = workspaces[i]
      if (!ws || typeof ws.cwd !== 'string' || ws.cwd === '') continue
      var key = ws.cwd.toLowerCase()
      if (seen[key]) continue
      seen[key] = true
      options.push({ value: ws.cwd, kind: 'workspace', count: ws.count || 0 })
    }
    if (typeof currentCwd === 'string' && currentCwd !== '' && !seen[currentCwd.toLowerCase()]) {
      options.push({ value: currentCwd, kind: 'workspace', count: 0 })
    }
    return options
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

  // 默认视图选择（纯函数）：「当前工作区」默认视图必须等 cwd 解析完成后再应用——
// 过早标记 initialized 会让晚到的 cwd 永久失效。resolved=false 表示还需等待。
  function defaultViewSelection(settings, currentCwd) {
    if (!settings || !settings.effective) return { selection: null, resolved: false }
    var dv = settings.effective.defaultView
    if (dv === 'global') return { selection: 'global', resolved: true }
    if (dv === 'workspace') {
      return currentCwd ? { selection: currentCwd, resolved: true } : { selection: null, resolved: false }
    }
    return { selection: null, resolved: true }
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
      rejected: Array.isArray(p.rejected) ? p.rejected.length : 0,
    }
  }

  function pageSlice(entries, size) {
    var list = Array.isArray(entries) ? entries : []
    var n = Math.max(1, Number(size) || 1)
    return { items: list.slice(0, n), hasMore: list.length > n }
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
    var diff = Math.max(0, now - then)
    var sec = Math.floor(diff / 1000)
    var min = Math.floor(sec / 60)
    var hr = Math.floor(min / 60)
    var day = Math.floor(hr / 24)
    if (sec < 45) return zh ? '刚刚' : 'just now'
    if (min < 60) return zh ? min + ' 分钟前' : min + ' min ago'
    if (hr < 24) return zh ? hr + ' 小时前' : hr + ' h ago'
    if (day < 7) return zh ? day + ' 天前' : day + ' d ago'
    var d = new Date(then)
    return zh ? (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  function formatBytes(n) {
    var b = Number(n) || 0
    if (b < 1024) return b + ' B'
    var kb = b / 1024
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB'
    var mb = kb / 1024
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB'
  }

  var helpers = { validateDraft: validateDraft, groupEntries: groupEntries, nextToken: nextToken, entriesParams: entriesParams, buildEntriesQuery: buildEntriesQuery, workspaceOptions: workspaceOptions, errorKeyFor: errorKeyFor, shouldQueueToast: shouldQueueToast, partitionSettled: partitionSettled, parseTags: parseTags, unwrapResult: unwrapResult, settingsStatusNext: settingsStatusNext, savedToastKey: savedToastKey, exportParams: exportParams, defaultViewSelection: defaultViewSelection, parseImportText: parseImportText, validateImportDoc: validateImportDoc, importSummary: importSummary, pageSlice: pageSlice, entryDetailRows: entryDetailRows, relativeTime: relativeTime, formatBytes: formatBytes, isExpired: isExpired, statusOf: statusOf, originOf: originOf, statusQueryFlags: statusQueryFlags }

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
  var TOAST_QUEUE_MAX = 3

  var ZH = {
    nav: '记忆',
    overline: 'LONG-TERM MEMORY',
    title: '记忆管理',
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
    edit: '编辑',
    del: '删除',
    save: '保存',
    cancel: '取消',
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
    errBodyTooLarge: '文件过大（超过 1 MB），请拆分后导入',
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
    expiresHint: '到期后默认隐藏，不删除；留空表示永不过期',
    expiresClear: '清除',
    errBadExpires: '过期日需为 YYYY-MM-DD 格式的有效日期',
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
    exportDone: '已导出 {n} 条记忆',
    importTitle: '导入记忆',
    importNew: '新增',
    importDup: '重复跳过',
    importRej: '拒绝',
    importUpdated: '更新',
    importMergeLabel: '按 id 合并已存在条目（更新内容，保留创建时间）',
    importRejHint: '被拒绝的条目（机密/无效/缺工作区）不会写入。',
    importConfirm: '确认导入',
    importAllDup: '全部条目均已存在，无需导入。',
    imported: '导入完成',
    audit: '查重',
    auditTitle: '相似记忆查重',
    auditHint: '扫描当前作用域内活跃记忆的相似度（≥50%）。可让较新条目取代较旧条目（保留历史），或忽略以保留两条。',
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
    backupDone: '备份完成',
    defaultViewLabel: '默认视图',
    pageSizeLabel: '每页条数',
    animationsLabel: '界面动效',
    animationsDesc: '卡片入场、悬停浮起等动画',
    relativeTimeLabel: '相对时间',
    relativeTimeDesc: '显示「N 小时前」而非绝对时间',
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
    overline: 'LONG-TERM MEMORY',
    title: 'Memory manager',
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
    edit: 'Edit',
    del: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
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
    errBodyTooLarge: 'File too large (over 1 MB); split it before importing',
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
    expiresHint: 'Hidden (not deleted) after this date; empty means never expires',
    expiresClear: 'Clear',
    errBadExpires: 'Expires must be a valid date in YYYY-MM-DD format',
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
    exportDone: 'Exported {n} memories',
    importTitle: 'Import memories',
    importNew: 'New',
    importDup: 'Duplicates skipped',
    importRej: 'Rejected',
    importUpdated: 'Updated',
    importMergeLabel: 'Merge existing by id (update content, keep created time)',
    importRejHint: 'Rejected entries (credentials/invalid/no workspace) are not written.',
    importConfirm: 'Import',
    importAllDup: 'All entries already exist; nothing to import.',
    imported: 'Import complete',
    audit: 'Audit',
    auditTitle: 'Similar memory audit',
    auditHint: 'Scans active memories in the current scope for similarity (≥50%). Supersede the older with the newer (history kept), or dismiss to keep both.',
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
    backupDone: 'Backup complete',
    defaultViewLabel: 'Default view',
    pageSizeLabel: 'Entries per page',
    animationsLabel: 'Animations',
    animationsDesc: 'Card entrance, hover lift and other motion',
    relativeTimeLabel: 'Relative time',
    relativeTimeDesc: 'Show “N hours ago” instead of absolute timestamps',
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
    // ---- 页面与调色板（浅色默认，深色跟随宿主） ----
    '.dm_page,.dm_select_pop{--dm-bg:var(--dsw-alias-bg-base,#f5f6fa);--dm-surface:var(--dsw-alias-bg-layer-1,#ffffff);--dm-ink:var(--dsw-alias-label-primary,#15171e);--dm-ink2:var(--dsw-alias-label-secondary,#5b6272);--dm-ink3:var(--dsw-alias-label-tertiary,#99a1b2);--dm-line:var(--dsw-alias-border-l1,rgba(21,23,30,.07));--dm-line2:var(--dsw-alias-border-l2,rgba(21,23,30,.14));--dm-primary:var(--dsw-alias-state-business-primary,#5b5bd6);--dm-primary2:#8b5cf6;--dm-on-primary:var(--dsw-alias-label-on-color,#ffffff);--dm-pref:#b45309;--dm-pref-soft:rgba(217,119,6,.12);--dm-fact:#1d4ed8;--dm-fact-soft:rgba(59,130,246,.12);--dm-dec:#047857;--dm-dec-soft:rgba(16,185,129,.13);--dm-danger:var(--dsw-alias-state-error-primary,#dc2626);--dm-danger-soft:rgba(220,38,38,.10);--dm-success:var(--dsw-alias-state-success-primary,#059669);--dm-success-soft:rgba(5,150,105,.12);--dm-amb-a:rgba(99,102,241,.10);--dm-amb-b:rgba(217,119,6,.07);--dm-shadow:0 1px 2px rgba(15,18,30,.05),0 10px 28px -14px rgba(15,18,30,.14);--dm-shadow-hover:0 2px 4px rgba(15,18,30,.06),0 18px 44px -16px rgba(15,18,30,.24);--dm-ring:0 0 0 3px color-mix(in srgb,var(--dm-primary) 22%,transparent);}',
    '.dm_page{height:100%;overflow-y:auto;box-sizing:border-box;color:var(--dm-ink);padding:calc(var(--dsh-frame-top-clearance,48px) + 18px) 24px 40px;font-size:13px;line-height:1.5;background-color:var(--dm-bg);background-image:radial-gradient(900px 460px at 88% -8%,var(--dm-amb-a),transparent 62%),radial-gradient(720px 420px at -8% 24%,var(--dm-amb-b),transparent 58%);background-attachment:local;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 22%,transparent) transparent;}',
    'body[data-ds-dark-theme] .dm_page,body[data-ds-dark-theme] .dm_select_pop{--dm-bg:var(--dsw-alias-bg-base,#0f1115);--dm-surface:var(--dsw-alias-bg-layer-1,#171a21);--dm-ink:var(--dsw-alias-label-primary,#e8eaf0);--dm-ink2:var(--dsw-alias-label-secondary,#a8aebd);--dm-ink3:var(--dsw-alias-label-tertiary,#6f7688);--dm-line:var(--dsw-alias-border-l1,rgba(232,234,240,.07));--dm-line2:var(--dsw-alias-border-l2,rgba(232,234,240,.15));--dm-primary2:#a78bfa;--dm-pref:#fbbf24;--dm-pref-soft:rgba(251,191,36,.14);--dm-fact:#60a5fa;--dm-fact-soft:rgba(96,165,250,.15);--dm-dec:#34d399;--dm-dec-soft:rgba(52,211,153,.14);--dm-danger:var(--dsw-alias-state-error-primary,#f87171);--dm-danger-soft:rgba(248,113,113,.14);--dm-success:var(--dsw-alias-state-success-primary,#34d399);--dm-success-soft:rgba(52,211,153,.14);--dm-amb-a:rgba(139,92,246,.15);--dm-amb-b:rgba(251,191,36,.06);--dm-shadow:0 1px 2px rgba(0,0,0,.42),0 12px 32px -14px rgba(0,0,0,.55);--dm-shadow-hover:0 2px 4px rgba(0,0,0,.45),0 20px 48px -16px rgba(0,0,0,.65);}',
    '.dm_page::-webkit-scrollbar{width:10px;height:10px;}',
    '.dm_page::-webkit-scrollbar-track{background:transparent;}',
    '.dm_page::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 20%,transparent);border-radius:8px;border:2.5px solid transparent;background-clip:content-box;}',
    '.dm_page::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dm-primary) 55%,transparent);border:2.5px solid transparent;background-clip:content-box;}',
    '.dm_page ::selection{background:color-mix(in srgb,var(--dm-primary) 26%,transparent);}',
    // ---- 头部 ----
    '.dm_header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px;}',
    '.dm_brand{display:flex;gap:14px;align-items:flex-start;min-width:0;}',
    '.dm_brand_medal{position:relative;flex-shrink:0;width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;color:var(--dm-on-primary);background:linear-gradient(135deg,var(--dm-primary),var(--dm-primary2));box-shadow:0 8px 22px -8px color-mix(in srgb,var(--dm-primary) 65%,transparent);}',
    '.dm_brand_medal::after{content:"";position:absolute;inset:-5px;border-radius:18px;border:1px solid color-mix(in srgb,var(--dm-primary) 45%,transparent);animation:dm_pulse 3.2s ease-in-out infinite;pointer-events:none;}',
    '.dm_overline{font-size:10.5px;font-weight:600;letter-spacing:.22em;color:var(--dm-ink3);text-transform:uppercase;}',
    '.dm_title{margin:2px 0 0;font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.2;}',
    '.dm_subtitle{color:var(--dm-ink2);margin-top:4px;font-size:12.5px;}',
    // ---- 按钮 ----
    '.dm_btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dm-line2);background:var(--dm-surface);color:var(--dm-ink2);border-radius:10px;padding:7px 13px;cursor:pointer;font:inherit;font-size:12.5px;transition:color .15s,background .15s,border-color .15s,transform .1s,box-shadow .15s;}',
    '.dm_btn:hover{color:var(--dm-primary);border-color:color-mix(in srgb,var(--dm-primary) 45%,var(--dm-line2));background:color-mix(in srgb,var(--dm-primary) 7%,var(--dm-surface));}',
    '.dm_btn:active{transform:scale(.97);}',
    '.dm_btn:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_btn:disabled{opacity:.45;cursor:default;transform:none;}',
    '.dm_btn_primary{background:linear-gradient(135deg,var(--dm-primary),var(--dm-primary2));border-color:transparent;color:var(--dm-on-primary);font-weight:600;box-shadow:0 6px 20px -8px color-mix(in srgb,var(--dm-primary) 70%,transparent);}',
    '.dm_btn_primary:hover{color:var(--dm-on-primary);background:linear-gradient(135deg,var(--dm-primary),var(--dm-primary2));filter:brightness(1.07);transform:translateY(-1px);box-shadow:0 10px 26px -8px color-mix(in srgb,var(--dm-primary) 75%,transparent);}',
    '.dm_btn_danger{color:var(--dm-danger);}',
    '.dm_btn_danger:hover{color:var(--dm-danger);border-color:color-mix(in srgb,var(--dm-danger) 50%,var(--dm-line2));background:var(--dm-danger-soft);}',
    '.dm_btn_danger_solid{background:var(--dm-danger);border-color:transparent;color:#fff;font-weight:600;}',
    '.dm_btn_danger_solid:hover{color:#fff;background:var(--dm-danger);filter:brightness(1.08);}',
    '.dm_btn_ghost{border-color:transparent;background:transparent;}',
    '.dm_btn_mini{padding:3px 9px;font-size:11.5px;border-radius:8px;}',
    '.dm_cta{height:38px;padding:0 18px;border-radius:11px;font-size:13px;flex-shrink:0;}',
    // ---- 统计条 ----
    '.dm_stats{display:flex;align-items:center;gap:20px;flex-wrap:wrap;background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:16px;padding:14px 20px;margin-bottom:14px;box-shadow:var(--dm-shadow);}',
    '.dm_stats_total{display:flex;align-items:baseline;gap:8px;}',
    '.dm_stats_num{font-family:Georgia,"Times New Roman",serif;font-size:32px;font-weight:700;line-height:1;color:var(--dm-ink);font-variant-numeric:tabular-nums;}',
    '.dm_stats_unit{font-size:11.5px;color:var(--dm-ink3);letter-spacing:.06em;}',
    '.dm_stats_div{width:1px;height:36px;background:var(--dm-line2);}',
    '.dm_stats_dist{flex:1;min-width:230px;display:flex;flex-direction:column;gap:8px;}',
    '.dm_dist_bar{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--dm-line);corner-shape:round;}',
    '.dm_dist_seg{transition:flex-grow .45s ease;min-width:0;}',
    '.dm_dist_seg_preference{background:linear-gradient(90deg,#f59e0b,var(--dm-pref));}',
    '.dm_dist_seg_fact{background:linear-gradient(90deg,#3b82f6,var(--dm-fact));}',
    '.dm_dist_seg_decision{background:linear-gradient(90deg,#10b981,var(--dm-dec));}',
    '.dm_chips{display:flex;gap:8px;flex-wrap:wrap;}',
    '.dm_chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dm-line2);background:transparent;color:var(--dm-ink2);border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px;corner-shape:round;transition:all .15s;}',
    '.dm_chip:hover{border-color:color-mix(in srgb,var(--dm-chip-c,var(--dm-primary)) 50%,var(--dm-line2));color:var(--dm-chip-c,var(--dm-primary));}',
    '.dm_chip:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_chip[aria-pressed="true"]{background:var(--dm-chip-soft,color-mix(in srgb,var(--dm-primary) 12%,transparent));border-color:color-mix(in srgb,var(--dm-chip-c,var(--dm-primary)) 55%,transparent);color:var(--dm-chip-c,var(--dm-primary));font-weight:600;}',
    '.dm_chip_n{font-size:11px;font-variant-numeric:tabular-nums;opacity:.75;}',
    '.dm_stats_scope{font-size:11.5px;color:var(--dm-ink3);white-space:nowrap;}',
    // ---- 工具栏（吸顶） ----
    '.dm_toolbar_wrap{position:sticky;top:var(--dsh-frame-top-clearance,48px);z-index:30;margin:0 -24px 6px;padding:10px 24px;background:var(--dm-bg);background:color-mix(in srgb,var(--dm-bg) 84%,transparent);backdrop-filter:blur(14px) saturate(1.25);-webkit-backdrop-filter:blur(14px) saturate(1.25);border-bottom:1px solid var(--dm-line);}',
    '.dm_toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
    '.dm_select{appearance:none;-webkit-appearance:none;height:36px;border:1px solid var(--dm-line2);border-radius:10px;background:var(--dm-surface);color:var(--dm-ink);padding:0 30px 0 12px;font:inherit;font-size:12.5px;cursor:pointer;max-width:340px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2399a1b2\' stroke-width=\'2.2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;transition:border-color .15s,box-shadow .15s;}',
    '.dm_select:hover{border-color:color-mix(in srgb,var(--dm-primary) 40%,var(--dm-line2));}',
    '.dm_select:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_searchwrap{position:relative;flex:1;min-width:200px;}',
    '.dm_search_icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--dm-ink3);pointer-events:none;display:flex;}',
    '.dm_search{width:100%;height:36px;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:10px;background:var(--dm-surface);color:var(--dm-ink);padding:0 32px 0 34px;font:inherit;font-size:12.5px;transition:border-color .15s,box-shadow .15s;}',
    '.dm_search::placeholder{color:var(--dm-ink3);}',
    '.dm_search:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_taginput{height:38px;width:140px;padding:0 12px;border:1px solid var(--dm-line2);border-radius:12px;background:var(--dm-bg);color:var(--dm-ink);font:inherit;font-size:13px;}',
    '.dm_taginput:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_search_clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:none;border-radius:50%;background:transparent;color:var(--dm-ink3);cursor:pointer;display:flex;align-items:center;justify-content:center;corner-shape:round;}',
    '.dm_search_clear:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_toolbtn{height:36px;}',
    // ---- 分组标题 ----
    '.dm_section_title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--dm-ink2);letter-spacing:.05em;margin:18px 0 10px;}',
    '.dm_section_n{font-size:11px;font-weight:500;color:var(--dm-ink3);background:var(--dm-line);border-radius:999px;padding:1px 8px;corner-shape:round;}',
    // ---- 记忆卡片 ----
    '.dm_card{position:relative;display:flex;gap:12px;border:1px solid var(--dm-line);border-radius:14px;padding:14px 14px 12px 12px;margin-bottom:10px;background:var(--dm-surface);box-shadow:var(--dm-shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease,opacity .18s ease;animation:dm_enter .4s ease backwards;}',
    '.dm_card:hover{transform:translateY(-2px);box-shadow:var(--dm-shadow-hover);border-color:var(--dm-line2);border-color:color-mix(in srgb,var(--dm-cat,var(--dm-primary)) 38%,var(--dm-line2));}',
    '.dm_card_selected{border-color:color-mix(in srgb,var(--dm-primary) 55%,transparent);background:color-mix(in srgb,var(--dm-primary) 5%,var(--dm-surface));}',
    '.dm_rail{position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,var(--dm-cat,var(--dm-primary)),color-mix(in srgb,var(--dm-cat,var(--dm-primary)) 35%,transparent));}',
    '.dm_check{display:flex;align-items:flex-start;padding-top:3px;flex-shrink:0;}',
    '.dm_check input{width:15px;height:15px;margin:0;accent-color:var(--dm-primary);cursor:pointer;opacity:0;transition:opacity .15s;}',
    '.dm_card:hover .dm_check input,.dm_check input:checked,.dm_selecting .dm_check input,.dm_check input:focus-visible{opacity:1;}',
    '@media (hover:none){.dm_check input{opacity:1;}}',
    '.dm_medal{flex-shrink:0;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--dm-cat,var(--dm-primary));background:var(--dm-cat-soft,var(--dm-fact-soft));}',
    '.dm_card_main{min-width:0;flex:1;}',
    '.dm_card_top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dm_badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;corner-shape:round;color:var(--dm-cat,var(--dm-primary));background:var(--dm-cat-soft,var(--dm-fact-soft));}',
    '.dm_scope_chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dm-ink3);}',
    '.dm_time{font-size:11px;color:var(--dm-ink3);margin-left:auto;font-variant-numeric:tabular-nums;cursor:default;}',
    '.dm_content{white-space:pre-wrap;word-break:break-word;margin:7px 0 6px;line-height:1.65;font-size:13.5px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;border-radius:6px;}',
    '.dm_content:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_content_open{display:block;-webkit-line-clamp:unset;cursor:default;}',
    '.dm_details{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--dm-ink2);margin:8px 0;padding:10px 12px;background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:10px;animation:dm_enter .25s ease;}',
    '.dm_details_row{display:flex;gap:6px;align-items:baseline;}',
    '.dm_details_k{color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_details_v{word-break:break-all;}',
    '.dm_details_link{display:inline-flex;align-items:center;gap:3px;border:none;background:none;padding:0;font:inherit;color:var(--dm-primary);cursor:pointer;word-break:break-all;text-decoration:underline;text-underline-offset:2px;}',
    '.dm_details_link:hover{color:var(--dm-primary2);}',
    '.dm_card_foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;}',
    '.dm_tag{border:1px solid var(--dm-line2);background:transparent;color:var(--dm-ink2);font:inherit;font-size:11px;padding:1.5px 9px;border-radius:999px;cursor:pointer;corner-shape:round;transition:all .15s;}',
    '.dm_tag:hover{color:var(--dm-primary);border-color:color-mix(in srgb,var(--dm-primary) 50%,var(--dm-line2));background:color-mix(in srgb,var(--dm-primary) 8%,transparent);}',
    '.dm_tag:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_id{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:10.5px;color:var(--dm-ink3);word-break:break-all;}',
    '.dm_card_actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0;}',
    '.dm_card_actions .dm_btn{padding:5px 10px;font-size:12px;border-color:transparent;background:transparent;}',
    '.dm_card_actions .dm_btn:hover{border-color:transparent;}',
    // ---- 骨架屏 ----
    '.dm_skel{border:1px solid var(--dm-line);border-radius:14px;padding:16px;margin-bottom:10px;background:var(--dm-surface);}',
    '.dm_skel_line{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--dm-line) 25%,color-mix(in srgb,var(--dm-ink) 7%,var(--dm-surface)) 37%,var(--dm-line) 63%);background-size:400% 100%;animation:dm_shimmer 1.4s ease infinite;margin-bottom:10px;}',
    // ---- 空态 / 错误 ----
    '.dm_empty{border:1px dashed var(--dm-line2);border-radius:16px;padding:48px 24px;text-align:center;color:var(--dm-ink2);background:color-mix(in srgb,var(--dm-surface) 60%,transparent);}',
    '.dm_empty_art{display:block;margin:0 auto 14px;}',
    '.dm_empty_title{font-size:15px;font-weight:600;color:var(--dm-ink);}',
    '.dm_empty_hint{margin-top:6px;font-size:12.5px;color:var(--dm-ink3);max-width:42ch;margin-left:auto;margin-right:auto;}',
    '.dm_float_a{animation:dm_float 5.5s ease-in-out infinite alternate;}',
    '.dm_float_b{animation:dm_float 6.5s ease-in-out .8s infinite alternate;}',
    '.dm_float_c{animation:dm_float 7.5s ease-in-out 1.6s infinite alternate;}',
    // ---- 翻页 ----
    '.dm_pager{display:flex;gap:10px;align-items:center;justify-content:center;margin:18px 0 4px;}',
    '.dm_pager .dm_btn{padding:6px 12px;}',
    '.dm_pageinfo{font-size:12px;color:var(--dm-ink2);background:var(--dm-surface);border:1px solid var(--dm-line);padding:4px 14px;border-radius:999px;corner-shape:round;font-variant-numeric:tabular-nums;}',
    // ---- 批量选择浮栏 ----
    '.dm_selbar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:900;display:flex;gap:10px;align-items:center;background:var(--dm-surface);border:1px solid var(--dm-line2);border-radius:14px;padding:10px 14px;box-shadow:var(--dm-shadow-hover);animation:dm_rise .25s ease;max-width:calc(100vw - 32px);}',
    '.dm_selbar_n{font-size:13px;font-weight:600;color:var(--dm-ink);white-space:nowrap;}',
    // ---- 弹窗 ----
    '.dm_overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay,rgba(10,12,20,.45));backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:1000;animation:dm_fade .18s ease;}',
    '.dm_dialog{background:var(--dm-surface);color:var(--dm-ink);border:1px solid var(--dm-line2);border-radius:18px;padding:24px;width:min(600px,calc(100vw - 48px));max-height:84vh;overflow-y:auto;box-shadow:0 24px 80px -24px rgba(0,0,0,.45);box-sizing:border-box;animation:dm_pop .22s cubic-bezier(.2,.9,.3,1.15);scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 22%,transparent) transparent;}',
    '.dm_dialog::-webkit-scrollbar{width:8px;}',
    '.dm_dialog::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 20%,transparent);border-radius:8px;}',
    '.dm_dialog_head{display:flex;align-items:center;gap:12px;margin-bottom:18px;}',
    '.dm_dialog_medal{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.dm_dialog_medal_primary{color:var(--dm-on-primary);background:linear-gradient(135deg,var(--dm-primary),var(--dm-primary2));}',
    '.dm_dialog_medal_danger{color:var(--dm-danger);background:var(--dm-danger-soft);}',
    '.dm_dialog_title{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em;}',
    '.dm_field{margin-bottom:14px;}',
    '.dm_label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dm-ink2);margin-bottom:6px;}',
    '.dm_textarea{width:100%;min-height:140px;resize:vertical;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:12px;background:var(--dm-bg);color:var(--dm-ink);padding:12px;font:inherit;font-size:13.5px;line-height:1.6;transition:border-color .15s,box-shadow .15s;}',
    '.dm_input{width:100%;height:38px;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:12px;background:var(--dm-bg);color:var(--dm-ink);padding:0 12px;font:inherit;font-size:12.5px;transition:border-color .15s,box-shadow .15s;}',
    '.dm_textarea:focus,.dm_input:focus,.dm_dialog .dm_select:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_dialog .dm_select{width:100%;max-width:none;height:38px;border-radius:12px;background-color:var(--dm-bg);}',
    '.dm_charcount{text-align:right;font-size:11px;color:var(--dm-ink3);margin-top:4px;font-variant-numeric:tabular-nums;}',
    '.dm_charcount_limit{color:var(--dm-danger);}',
    '.dm_catgrid{display:flex;gap:8px;}',
    '.dm_catopt{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--dm-line2);border-radius:12px;background:transparent;color:var(--dm-ink2);padding:10px 8px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;transition:all .15s;}',
    '.dm_catopt:hover{border-color:color-mix(in srgb,var(--dm-cat) 45%,var(--dm-line2));color:var(--dm-cat);}',
    '.dm_catopt:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_catopt[aria-checked="true"]{background:var(--dm-cat-soft);border-color:color-mix(in srgb,var(--dm-cat) 55%,transparent);color:var(--dm-cat);}',
    '.dm_dialog_footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;align-items:center;}',
    '.dm_dialog_footer .dm_hint{margin-right:auto;}',
    '.dm_delete_preview{border:1px solid var(--dm-line);border-radius:12px;padding:12px;margin:10px 0;white-space:pre-wrap;word-break:break-word;background:var(--dm-bg);max-height:36vh;overflow-y:auto;font-size:13px;line-height:1.6;}',
    '.dm_hint{color:var(--dm-ink3);font-size:11.5px;}',
    '.dm_import_tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:6px 0 10px;}',
    '.dm_import_merge{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12.5px;color:var(--dm-ink);cursor:pointer;}',
    '.dm_audit_list{display:flex;flex-direction:column;gap:12px;}',
    '.dm_audit_pair{border:1px solid var(--dm-line2);border-radius:12px;padding:12px;background:var(--dm-bg);}',
    '.dm_audit_score{font-size:12px;font-weight:700;color:var(--dm-primary);margin-bottom:8px;}',
    '.dm_audit_side{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;}',
    '.dm_audit_tag{flex-shrink:0;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--dm-line);color:var(--dm-ink3);}',
    '.dm_audit_tag_new{background:color-mix(in srgb,var(--dm-primary) 14%,transparent);color:var(--dm-primary);}',
    '.dm_audit_content{font-size:13px;line-height:1.45;color:var(--dm-ink);word-break:break-word;}',
    '.dm_audit_actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}',
    '.dm_recall{margin-top:10px;border:1px solid var(--dm-line2);border-radius:12px;padding:12px;background:var(--dm-bg);}',
    '.dm_recall_head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;}',
    '.dm_recall_list{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:220px;overflow-y:auto;scrollbar-width:thin;}',
    '.dm_recall_item{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.4;}',
    '.dm_recall_cat{flex-shrink:0;font-weight:700;font-size:11px;}',
    '.dm_recall_content{color:var(--dm-ink);word-break:break-word;}',
    '.dm_hidden_hint{display:flex;align-items:flex-start;gap:8px;margin:0 0 10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dm-primary) 30%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dm-primary) 8%,transparent);color:var(--dm-ink);font-size:12.5px;line-height:1.45;}',
    '.dm_tile{border:1px solid var(--dm-line);border-radius:12px;padding:12px;background:var(--dm-bg);text-align:center;}',
    '.dm_tile_num{font-family:Georgia,"Times New Roman",serif;font-size:26px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;}',
    '.dm_tile_label{font-size:11px;color:var(--dm-ink3);margin-top:3px;}',
    // ---- 吐司 ----
    '.dm_toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1100;display:flex;gap:10px;align-items:center;min-width:260px;max-width:min(560px,90vw);background:var(--dm-surface);color:var(--dm-ink);border:1px solid var(--dm-line2);border-radius:14px;padding:12px 14px;box-shadow:var(--dm-shadow-hover);animation:dm_rise .25s ease;overflow:hidden;}',
    '.dm_toast_raised{bottom:86px;}',
    '.dm_toast_icon{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;corner-shape:round;}',
    '.dm_toast_ok .dm_toast_icon{color:var(--dm-success);background:var(--dm-success-soft);}',
    '.dm_toast_error .dm_toast_icon{color:var(--dm-danger);background:var(--dm-danger-soft);}',
    '.dm_toast_text{flex:1;font-size:13px;line-height:1.45;}',
    '.dm_toast_action{border:none;background:color-mix(in srgb,var(--dm-primary) 12%,transparent);color:var(--dm-primary);font:inherit;font-size:12.5px;font-weight:700;padding:5px 12px;border-radius:8px;cursor:pointer;flex-shrink:0;transition:background .15s;}',
    '.dm_toast_action:hover{background:color-mix(in srgb,var(--dm-primary) 20%,transparent);}',
    '.dm_toast_close{border:none;background:transparent;color:var(--dm-ink3);width:22px;height:22px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;corner-shape:round;}',
    '.dm_toast_close:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_toast_bar{position:absolute;left:0;bottom:0;height:2.5px;width:100%;background:linear-gradient(90deg,var(--dm-primary),var(--dm-primary2));animation:dm_bar linear forwards;}',
    '.dm_toast_error .dm_toast_bar{background:var(--dm-danger);}',
    '.dm_nav_icon{display:block;}',
    // ---- 动画 ----
    '@keyframes dm_enter{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}',
    '@keyframes dm_fade{from{opacity:0;}to{opacity:1;}}',
    '@keyframes dm_pop{from{opacity:0;transform:scale(.96) translateY(6px);}to{opacity:1;transform:scale(1) translateY(0);}}',
    '@keyframes dm_rise{from{opacity:0;transform:translate(-50%,12px);}to{opacity:1;transform:translate(-50%,0);}}',
    '@keyframes dm_shimmer{0%{background-position:100% 0;}100%{background-position:-100% 0;}}',
    '@keyframes dm_pulse{0%,100%{opacity:.5;transform:scale(1);}50%{opacity:.12;transform:scale(1.06);}}',
    '@keyframes dm_float{from{transform:translateY(0);}to{transform:translateY(-5px);}}',
    '@keyframes dm_bar{from{width:100%;}to{width:0%;}}',
    // ---- 标签页 ----
    '.dm_tabs{display:flex;gap:6px;margin:0 0 16px;border-bottom:1px solid var(--dm-line);padding-bottom:0;}',
    '.dm_tab{display:inline-flex;align-items:center;gap:7px;border:none;background:transparent;color:var(--dm-ink2);font:inherit;font-size:13.5px;font-weight:600;padding:9px 16px;cursor:pointer;border-radius:10px 10px 0 0;position:relative;transition:color .15s,background .15s;}',
    '.dm_tab:hover{color:var(--dm-ink);background:color-mix(in srgb,var(--dm-ink) 5%,transparent);}',
    '.dm_tab:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_tab_active{color:var(--dm-primary);}',
    '.dm_tab_active::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2.5px;border-radius:3px;background:linear-gradient(90deg,var(--dm-primary),var(--dm-primary2));}',
    '.dm_tab_n{font-size:11px;font-weight:600;color:var(--dm-ink3);background:var(--dm-line);border-radius:999px;padding:0 7px;corner-shape:round;}',
    '.dm_tab_active .dm_tab_n{color:var(--dm-primary);background:color-mix(in srgb,var(--dm-primary) 14%,transparent);}',
    // ---- 设置页 ----
    '.dm_settings{display:flex;flex-direction:column;gap:16px;max-width:880px;animation:dm_enter .35s ease;}',
    '.dm_setgroup{background:var(--dm-surface);border:1px solid var(--dm-line);border-radius:16px;padding:18px 20px;box-shadow:var(--dm-shadow);}',
    '.dm_setgroup_head{display:flex;align-items:center;gap:11px;margin-bottom:6px;}',
    '.dm_setgroup_icon{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.dm_setgroup_title{margin:0;font-size:14.5px;font-weight:700;letter-spacing:-.01em;}',
    '.dm_setrow{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:13px 0;border-top:1px solid var(--dm-line);}',
    '.dm_setrow:first-of-type{border-top:none;}',
    '.dm_setrow_text{flex:1;min-width:0;}',
    '.dm_setrow_label{font-size:13px;font-weight:600;color:var(--dm-ink);}',
    '.dm_setrow_desc{font-size:11.5px;color:var(--dm-ink3);margin-top:2px;line-height:1.5;}',
    '.dm_setrow_ctrl{flex-shrink:0;display:flex;align-items:center;gap:8px;}',
    '.dm_setnote{font-size:11.5px;color:var(--dm-ink3);padding:10px 12px;background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:10px;margin-top:10px;display:flex;gap:7px;align-items:flex-start;line-height:1.5;}',
    // ---- 开关 ----
    '.dm_switch{position:relative;width:42px;height:24px;border:none;border-radius:999px;background:var(--dm-line2);cursor:pointer;padding:0;transition:background .2s;corner-shape:round;flex-shrink:0;}',
    '.dm_switch:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_switch_on{background:linear-gradient(135deg,var(--dm-primary),var(--dm-primary2));}',
    '.dm_switch:disabled{opacity:.45;cursor:default;}',
    '.dm_switch_knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s;corner-shape:round;}',
    '.dm_switch_on .dm_switch_knob{transform:translateX(18px);}',
    // ---- 滑杆 / 数字 ----
    '.dm_slider_row{display:flex;align-items:center;gap:12px;}',
    '.dm_range{width:180px;accent-color:var(--dm-primary);cursor:pointer;}',
    '.dm_slider_val{font-size:12.5px;font-weight:600;color:var(--dm-ink);font-variant-numeric:tabular-nums;min-width:52px;text-align:right;}',
    '.dm_numinput{width:72px;height:32px;border:1px solid var(--dm-line2);border-radius:8px;background:var(--dm-bg);color:var(--dm-ink);padding:0 8px;font:inherit;font-size:12.5px;text-align:center;}',
    '.dm_numinput:focus{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_setselect{height:34px;max-width:220px;}',
    // ---- 隐私护栏 ----
    '.dm_guard{display:flex;gap:12px;align-items:center;padding:14px 16px;border-radius:12px;background:var(--dm-success-soft);border:1px solid color-mix(in srgb,var(--dm-success) 35%,transparent);margin-top:8px;}',
    '.dm_guard_icon{color:var(--dm-success);flex-shrink:0;display:flex;}',
    '.dm_guard_title{font-size:13px;font-weight:700;color:var(--dm-ink);}',
    '.dm_guard_desc{font-size:11.5px;color:var(--dm-ink2);margin-top:2px;line-height:1.5;}',
    // ---- 路径 / 备份元信息 ----
    '.dm_pathrow{display:flex;gap:8px;align-items:center;}',
    '.dm_path{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:var(--dm-ink2);background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:8px;padding:7px 10px;flex:1;word-break:break-all;min-width:0;}',
    '.dm_backupmeta{font-size:11.5px;color:var(--dm-ink3);display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;}',
    '.dm_setfooter{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;}',
    '.dm_savestate{font-size:11.5px;color:var(--dm-ink3);display:flex;gap:6px;align-items:center;}',
    '.dm_linkbtn{border:none;background:transparent;color:var(--dm-primary);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;padding:0;}',
    '.dm_no_anim *,.dm_no_anim *::before,.dm_no_anim *::after{animation:none !important;transition:none !important;}',
    // ---- 自定义下拉 Select ----
    '.dm_selectwrap{position:relative;display:inline-block;min-width:0;}',
    '.dm_select_trigger{display:inline-flex;align-items:center;gap:8px;height:36px;width:100%;box-sizing:border-box;border:1px solid var(--dm-line2);border-radius:10px;background:var(--dm-surface);color:var(--dm-ink);padding:0 10px 0 12px;font:inherit;font-size:12.5px;cursor:pointer;max-width:340px;transition:border-color .15s,box-shadow .15s,background .15s;}',
    '.dm_select_trigger:hover{border-color:color-mix(in srgb,var(--dm-primary) 40%,var(--dm-line2));}',
    '.dm_select_trigger:focus-visible{outline:none;border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_select_open{border-color:var(--dm-primary);box-shadow:var(--dm-ring);}',
    '.dm_select_disabled{opacity:.45;cursor:default;}',
    '.dm_select_val_icon{display:flex;color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_select_value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}',
    '.dm_select_chev{display:flex;color:var(--dm-ink3);flex-shrink:0;transition:transform .2s;}',
    '.dm_select_open .dm_select_chev{transform:rotate(180deg);color:var(--dm-primary);}',
    '.dm_select_pop{position:fixed;z-index:1200;box-sizing:border-box;background:var(--dm-surface);border:1px solid color-mix(in srgb,var(--dm-primary) 35%,var(--dm-line2));border-radius:12px;box-shadow:var(--dm-shadow-hover);padding:5px;max-height:300px;overflow-y:auto;animation:dm_pop_in .16s ease;transform-origin:top center;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 22%,transparent) transparent;}',
    '.dm_select_pop::-webkit-scrollbar{width:8px;}',
    '.dm_select_pop::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dm-ink) 20%,transparent);border-radius:8px;}',
    '.dm_select_pop::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dm-primary) 50%,transparent);}',
    '.dm_select_up{transform-origin:bottom center;animation:dm_pop_in_up .16s ease;}',
    '.dm_select_opt{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;color:var(--dm-ink);transition:background .12s,color .12s;}',
    '.dm_select_opt_active{background:color-mix(in srgb,var(--dm-ink) 7%,transparent);}',
    '.dm_select_opt_sel{color:var(--dm-primary);font-weight:600;background:color-mix(in srgb,var(--dm-primary) 9%,transparent);}',
    '.dm_select_opt_sel.dm_select_opt_active{background:color-mix(in srgb,var(--dm-primary) 15%,transparent);}',
    '.dm_select_opt_disabled{opacity:.4;cursor:default;}',
    '.dm_select_opt_icon{display:flex;color:var(--dm-ink3);flex-shrink:0;}',
    '.dm_select_opt_sel .dm_select_opt_icon{color:var(--dm-primary);}',
    '.dm_select_opt_spacer{width:14px;}',
    '.dm_select_opt_label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dm_select_opt_hint{font-size:11px;color:var(--dm-ink3);flex-shrink:0;font-variant-numeric:tabular-nums;}',
    '.dm_select_opt_check{color:var(--dm-primary);flex-shrink:0;}',
    '.dm_dialog .dm_selectwrap{display:block;width:100%;}',
    '.dm_dialog .dm_select_trigger{max-width:none;height:38px;border-radius:12px;background:var(--dm-bg);}',
    '.dm_setselect .dm_select_trigger{height:34px;max-width:240px;}',
    '@keyframes dm_pop_in{from{opacity:0;transform:translateY(-4px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}',
    '@keyframes dm_pop_in_up{from{opacity:0;transform:translateY(4px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}',
    // ---- v2：来源徽章 / 状态装饰 / 钉选归档 / 过期日 ----
    '.dm_origin{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:1.5px 8px;border-radius:999px;corner-shape:round;}',
    '.dm_origin_auto{color:var(--dm-primary2);background:color-mix(in srgb,var(--dm-primary2) 12%,transparent);}',
    '.dm_origin_manual{color:var(--dm-ink3);background:color-mix(in srgb,var(--dm-ink) 6%,transparent);}',
    '.dm_status{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:1.5px 8px;border-radius:999px;corner-shape:round;}',
    '.dm_status_superseded{color:var(--dm-ink3);background:color-mix(in srgb,var(--dm-ink) 7%,transparent);}',
    '.dm_status_expired{color:var(--dm-danger);background:var(--dm-danger-soft);}',
    '.dm_status_archived{color:var(--dm-ink2);background:color-mix(in srgb,var(--dm-ink) 7%,transparent);}',
    '.dm_successor{display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;color:var(--dm-primary);font:inherit;font-size:10.5px;font-weight:600;padding:1.5px 7px;border-radius:999px;cursor:pointer;corner-shape:round;transition:background .15s;}',
    '.dm_successor:hover{background:color-mix(in srgb,var(--dm-primary) 10%,transparent);}',
    '.dm_successor:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_pinned_mark{display:inline-flex;color:var(--dm-pref);}',
    '.dm_injected_mark{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:700;color:var(--dm-success);}',
    '.dm_card_muted{opacity:.72;}',
    '.dm_card_muted:hover{opacity:1;}',
    '.dm_btn_pinned{color:var(--dm-pref);}',
    '.dm_chips_status{margin-top:2px;}',
    '.dm_expiresrow{display:flex;gap:8px;align-items:center;}',
    '.dm_dateinput{max-width:220px;color-scheme:light;}',
    'body[data-ds-dark-theme] .dm_dateinput{color-scheme:dark;}',
    '.dm_pinrow{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
    // ---- 响应式与动效偏好 ----
    '@media (max-width:720px){.dm_header{flex-direction:column;}.dm_cta{width:100%;justify-content:center;}.dm_stats{gap:12px;padding:12px 14px;}.dm_stats_div{display:none;}.dm_card_actions{flex-direction:row;}.dm_card{flex-wrap:wrap;}.dm_import_tiles{grid-template-columns:repeat(2,1fr);}}',
    '@media (prefers-reduced-motion:reduce){.dm_page *,.dm_page *::before,.dm_page *::after,.dm_toast,.dm_selbar,.dm_overlay,.dm_dialog,.dm_select_pop{animation:none !important;transition:none !important;}}',
    'body.dm-no-anim .dm_select_pop{animation:none !important;}',
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
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        var ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        ta.remove()
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
      function createApi(tokenRef) {
        function request(path, options) {
          var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options)
          var timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS
          delete opts.timeoutMs
          // 超时即中止：超时/网络失败统一转成带 code 的错误，交给 errorText 本地化。
          if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            opts.signal = AbortSignal.timeout(timeoutMs)
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
          similar: function (params) { return request(API_BASE + '/similar' + buildEntriesQuery(params)) },
          recallPreview: function (workspace) { return request(API_BASE + '/recall-preview' + (workspace ? '?workspace=' + encodeURIComponent(workspace) : '')) },
          export: function (params) { return request(API_BASE + '/export' + buildEntriesQuery(params || {})) },
          settings: function () { return request(API_BASE + '/settings') },
          saveSettings: function (input) { return post(API_BASE + '/settings', input).then(unwrapResult) },
          resetSettings: function () { return post(API_BASE + '/settings/reset', {}).then(unwrapResult) },
          backup: function () { return post(API_BASE + '/backup', {}) },
          save: function (input) { return post(API_BASE + '/save', input) },
          update: function (input) { return post(API_BASE + '/update', input) },
          forget: function (input) { return post(API_BASE + '/forget', input) },
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

      function ConstellationArt(props) {
        var small = props.small
        var w = small ? 120 : 168
        var hh = small ? 88 : 120
        // SVG presentation attributes do not resolve var(); colors go through style.
        return h('svg', { className: 'dm_empty_art', width: w, height: hh, viewBox: '0 0 168 120', fill: 'none', 'aria-hidden': true },
          h('g', { style: { stroke: 'var(--dm-line2)' }, strokeWidth: 1.2 },
            h('path', { d: 'M30 78L70 40L118 58L140 26' }),
            h('path', { d: 'M70 40L92 92L118 58' }),
            h('path', { d: 'M30 78L92 92' })),
          h('g', { className: 'dm_float_a' },
            h('circle', { cx: 30, cy: 78, r: 10, style: { fill: 'var(--dm-fact-soft)' } }),
            h('circle', { cx: 30, cy: 78, r: 4.5, style: { fill: 'var(--dm-fact)' } })),
          h('g', { className: 'dm_float_b' },
            h('circle', { cx: 70, cy: 40, r: 13, style: { fill: 'var(--dm-pref-soft)' } }),
            h('circle', { cx: 70, cy: 40, r: 6, style: { fill: 'var(--dm-pref)' } })),
          h('g', { className: 'dm_float_c' },
            h('circle', { cx: 118, cy: 58, r: 11, style: { fill: 'var(--dm-dec-soft)' } }),
            h('circle', { cx: 118, cy: 58, r: 5, style: { fill: 'var(--dm-dec)' } })),
          h('g', { className: 'dm_float_b' },
            h('circle', { cx: 140, cy: 26, r: 3.5, style: { fill: 'var(--dm-primary)' } }),
            h('circle', { cx: 92, cy: 92, r: 4, style: { fill: 'var(--dm-primary2)' } })))
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
          className: 'dm_card' + (checked ? ' dm_card_selected' : '') + (status !== 'active' ? ' dm_card_muted' : ''),
          style: Object.assign({}, catVars(entry.category), { animationDelay: (props.index % 10) * 35 + 'ms' }),
        },
          h('div', { className: 'dm_rail' }),
          h('label', { className: 'dm_check' },
            h('input', {
              type: 'checkbox', checked: checked, 'aria-label': t('selectEntry'),
              onChange: function () { props.onToggleSelect(entry.id) },
            })),
          h('div', { className: 'dm_medal' }, h(Icon, { name: meta.icon, size: 17, strokeWidth: 1.9 })),
          h('div', { className: 'dm_card_main' },
            h('div', { className: 'dm_card_top' },
              h(Badge, { category: entry.category, t: t }),
              h('span', { className: 'dm_origin dm_origin_' + origin, title: t('originLabel') + ': ' + t(origin === 'auto' ? 'originAuto' : 'originManual') },
                h(Icon, { name: origin === 'auto' ? 'zap' : 'edit', size: 10, strokeWidth: 2.2 }),
                t(origin === 'auto' ? 'originAuto' : 'originManual')),
              status !== 'active' ? h('span', { className: 'dm_status dm_status_' + status },
                h(Icon, { name: status === 'superseded' ? 'link' : status === 'expired' ? 'clock' : 'archive', size: 10, strokeWidth: 2.2 }),
                t(status === 'superseded' ? 'statusSuperseded' : status === 'expired' ? 'statusExpired' : 'statusArchived'),
                status === 'expired' && entry.expires ? ' · ' + entry.expires : null) : null,
              status === 'superseded' && entry.superseded_by ? h('button', {
                className: 'dm_successor', title: t('jumpToSuccessor') + ': ' + entry.superseded_by,
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
                    h('span', { className: 'dm_details_k' }, t(row.key) + ':'),
                    isLink
                      ? h('button', { className: 'dm_details_link', title: t('jumpToEntry') + ': ' + row.value, onClick: function () { props.onJumpTo(row.value) } }, text, h(Icon, { name: 'chevR', size: 11, strokeWidth: 2.2 }))
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
              disabled: !!props.busy,
              onClick: function () { props.onTogglePin(entry) },
            }, h(Icon, { name: 'pin', size: 13, style: entry.pinned ? { fill: 'currentColor' } : null }), entry.pinned ? t('unpin') : t('pin')),
            h('button', { className: 'dm_btn', disabled: !!props.busy, onClick: function () { props.onToggleArchive(entry) } },
              h(Icon, { name: 'archive', size: 13 }), entry.archived ? t('restore') : t('archive')),
            h('button', { className: 'dm_btn', disabled: !!props.busy, onClick: function () { props.onEdit(entry) } }, h(Icon, { name: 'edit', size: 13 }), t('edit')),
            h('button', { className: 'dm_btn dm_btn_danger', disabled: !!props.busy, onClick: function () { props.onDelete(entry) } }, h(Icon, { name: 'trash', size: 13 }), t('del'))))
      }

      // 焦点陷阱 + 焦点归还；busy 时禁止 Escape/遮罩关闭；回调经 ref 稳定。
      function Modal(props) {
        var dialogRef = useRef(null)
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
              ? h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('workspaceTarget') + ': ' + workspaceTarget)
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
            h('span', { className: 'dm_hint' }, t('editorHint')),
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
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-danger)' } }, summary.rejected), h('div', { className: 'dm_tile_label' }, t('importRej')))),
          rejected.length > 0
            ? h('div', { className: 'dm_hint' },
              t('importRejHint'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                rejected.slice(0, 5).map(function (r, i) {
                  return h('li', { key: i }, '#' + (r.index + 1) + ' ' + String(r.reason || r.code || ''))
                }),
                rejected.length > 5 ? h('li', { key: 'more' }, '… +' + (rejected.length - 5)) : null))
            : null,
          summary.imported === 0 && summary.updated === 0 && summary.deduplicated > 0
            ? h('div', { className: 'dm_hint', style: { marginTop: 8 } }, t('importAllDup'))
            : null,
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
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
        return h('div', {
          key: toast.id,
          className: 'dm_toast dm_toast_' + (toast.kind === 'error' ? 'error' : 'ok') + (props.raised ? ' dm_toast_raised' : ''),
          role: toast.kind === 'error' ? 'alert' : 'status',
        },
          h('span', { className: 'dm_toast_icon' }, h(Icon, { name: toast.kind === 'error' ? 'alert' : 'check', size: 14, strokeWidth: 2.2 })),
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
        return h('div', { className: 'dm_slider_row' },
          h('input', {
            type: 'range', className: 'dm_range', min: props.min, max: props.max, step: props.step || 1,
            value: props.value, 'aria-label': props.label, disabled: props.disabled,
            onChange: function (e) { props.onChange(Number(e.target.value)) },
          }),
          h('span', { className: 'dm_slider_val' }, props.value))
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
            h('span', { className: 'dm_setgroup_icon', style: props.style }, h(Icon, { name: props.icon, size: 16, strokeWidth: 1.9 })),
            h('h3', { className: 'dm_setgroup_title' }, props.title)),
          props.children)
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
        useEffect(function () { load() }, [workspace, props.refreshKey])
        var summary = data
          ? t('recallSummary').replace('{injected}', String(data.injected)).replace('{omitted}', String(data.omitted)).replace('{used}', String(data.usedChars)).replace('{budget}', String(data.budgetChars))
          : ''
        return h('div', { className: 'dm_recall' },
          h('div', { className: 'dm_recall_head' },
            h('span', { className: 'dm_label' }, h(Icon, { name: 'database', size: 13 }), t('recallTitle')),
            h('button', { className: 'dm_btn dm_btn_mini', onClick: load, disabled: busy }, h(Icon, { name: 'undo', size: 12 }), t('recallRefresh'))),
          h('div', { className: 'dm_hint', style: { marginBottom: 6 } }, t('recallHint')),
          err ? h('div', { className: 'dm_hint', style: { color: 'var(--dm-danger)' } }, err)
            : !data ? h('div', { className: 'dm_hint' }, t('recallLoading'))
            : h('div', null,
              h('div', { className: 'dm_hint' }, summary + (data.autoInject ? '' : ' ' + t('recallAutoOff'))),
              data.entries.length > 0
                ? h('div', { className: 'dm_recall_list' },
                  data.entries.slice(0, 30).map(function (e) {
                    var meta = CATEGORY_META[e.category] || CATEGORY_META.fact
                    return h('div', { key: e.id, className: 'dm_recall_item' },
                      h('span', { className: 'dm_recall_cat', style: { color: meta.cat } }, t(meta.label)),
                      h('span', { className: 'dm_recall_content' }, e.content.length > 60 ? e.content.slice(0, 60) + '…' : e.content))
                  }),
                  data.entries.length > 30 ? h('div', { className: 'dm_hint' }, '… +' + (data.entries.length - 30)) : null)
                : null))
      }

      function SettingsPage(props) {
        var t = props.t
        var view = props.view
        var draft = props.draft
        if (!view || !draft) {
          // 首次加载失败：显示错误与重试入口，而不是永久骨架。
          if (props.error) {
            return h('div', { className: 'dm_empty' },
              h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
              h('div', null, t('loadError') + ': ' + props.error),
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
          h(SettingsGroup, { icon: 'layers', title: t('groupInjection'), style: { color: 'var(--dm-primary)', background: 'color-mix(in srgb,var(--dm-primary) 12%,transparent)' } },
            h(SettingRow, { label: t('autoInjectLabel'), desc: t('autoInjectDesc') },
              h(Toggle, { checked: draft.autoInject, onChange: set('autoInject'), label: t('autoInjectLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('autoExtractHintLabel'), desc: t('autoExtractHintDesc') },
              h(Toggle, { checked: draft.autoExtractHint !== false, onChange: set('autoExtractHint'), label: t('autoExtractHintLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('decayEnabledLabel'), desc: t('decayEnabledDesc') },
              h(Toggle, { checked: draft.decayEnabled !== false, onChange: set('decayEnabled'), label: t('decayEnabledLabel'), disabled: props.busy })),
            h(SettingRow, { label: t('budgetLabel'), desc: t('budgetDesc') },
              h(Slider, { min: 0, max: bounds.budgetMax, step: 100, value: draft.injectionBudgetChars, onChange: set('injectionBudgetChars'), label: t('budgetLabel'), disabled: props.busy })),
            h(RecallPreview, { t: t, api: props.api, workspace: props.workspace, refreshKey: props.view && props.view.effective }),
            h('div', { className: 'dm_setnote' }, h(Icon, { name: 'info', size: 14, style: { flexShrink: 0, marginTop: 1 } }), t('priorityNote')),
            h('div', { className: 'dm_setnote' }, h(Icon, { name: 'info', size: 14, style: { flexShrink: 0, marginTop: 1 } }), t('enabledNote'))),
          h(SettingsGroup, { icon: 'lock', title: t('groupPrivacy'), style: { color: 'var(--dm-success)', background: 'var(--dm-success-soft)' } },
            h('div', { className: 'dm_guard' },
              h('span', { className: 'dm_guard_icon' }, h(Icon, { name: 'checkCircle', size: 22, strokeWidth: 1.9 })),
              h('div', null,
                h('div', { className: 'dm_guard_title' }, t('privacyLabel')),
                h('div', { className: 'dm_guard_desc' }, t('privacyDesc'))))),
          h(SettingsGroup, { icon: 'database', title: t('groupStorage'), style: { color: 'var(--dm-fact)', background: 'var(--dm-fact-soft)' } },
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
              h('span', null, t('lastBackupLabel') + ': ' + (meta.backup.lastBackup ? formatTime(meta.backup.lastBackup) : t('neverBackup'))),
              h('span', null, t('backupCount').replace('{n}', String(meta.backup.count))),
              h('button', { className: 'dm_btn dm_btn_mini', onClick: props.onBackup, disabled: props.busy || (props.status && props.status.saving) }, h(Icon, { name: 'export', size: 12 }), t('backupNow')))),
          h(SettingsGroup, { icon: 'sliders', title: t('groupPanel'), style: { color: 'var(--dm-pref)', background: 'var(--dm-pref-soft)' } },
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
              h(Toggle, { checked: draft.relativeTime, onChange: set('relativeTime'), label: t('relativeTimeLabel'), disabled: props.busy }))),
          h('div', { className: 'dm_setfooter' },
            h('button', { className: 'dm_btn dm_btn_danger', onClick: props.onReset, disabled: props.busy || (props.status && props.status.saving) }, h(Icon, { name: 'undo', size: 14 }), t('resetDefaults')),
            h('span', { className: 'dm_savestate' },
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
          role: 'listbox', ref: listRef, tabIndex: -1, 'aria-label': props.ariaLabel,
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
        var apiRef = useRef(null)
        if (apiRef.current === null) apiRef.current = createApi(tokenRef)
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
        var auditState = useState(null)
        var audit = auditState[0]; var setAudit = auditState[1]
        var toastState = useState(null)
        var toast = toastState[0]; var setToast = toastState[1]
        var toastRef = useRef(null)
        var toastQueueRef = useRef([])
        var toastActionRef = useRef(null)
        var busyState = useState(false)
        var busy = busyState[0]; var setBusy = busyState[1]
        var errorState = useState('')
        var errorTextState = errorState[0]; var setErrorText = errorState[1]
        var listErrorState = useState('')
        var listError = listErrorState[0]; var setListError = listErrorState[1]
        var tabState = useState('memories')
        var tab = tabState[0]; var setTab = tabState[1]
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
          setTab(next)
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
        modalOpenRef.current = !!(editor || confirm || importPlan || audit)
        var selectedRef = useRef(selected)
        selectedRef.current = selected
        var draftRef = useRef(draft)
        draftRef.current = draft
        var dirtyRef = useRef(false)
        var viewInitialized = useRef(false)
        var settingsSeq = useRef(0)
        var pageSize = (settings && settings.effective && settings.effective.pageSize) || PAGE_SIZE

        // 带操作按钮的吐司（删除撤销）出现时把焦点移到动作按钮：确认删除后原触发按钮
// 已随卡片卸载，不主动接管焦点的话键盘用户既丢失上下文、也无法到达撤销。
        useEffect(function () {
          if (toast && toast.action && toastActionRef.current) {
            try { toastActionRef.current.focus() } catch { /* 焦点接管失败不影响功能 */ }
          }
        }, [toast])

        function dismissToast() {
          var queued = toastQueueRef.current.shift()
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
          if (shouldQueueToast(toastRef.current, next, Date.now())) {
            // 撤销吐司优先：普通提示排队稍后展示（只保留最近几条，避免堆积）。
            toastQueueRef.current.push(next)
            while (toastQueueRef.current.length > TOAST_QUEUE_MAX) toastQueueRef.current.shift()
            return
          }
          toastRef.current = next
          setToast(next)
        }

        // 列表＋统计请求：seq 守卫防乱序；「全部」＝全局＋当前工作区。
        // 多取一条（PAGE_SIZE+1）探测下一页；过滤/切换作用域时回到第一页。
        var refreshEntries = useCallback(function () {
          var seq = ++seqRef.current
          var scopeParams = {}
          if (selection === 'global') scopeParams.scope = 'global'
          else if (selection === 'all') { scopeParams.scope = 'all'; scopeParams.workspace = currentCwd }
          else { scopeParams.scope = 'workspace'; scopeParams.workspace = selection }
          var params = entriesParams(Object.assign({}, scopeParams, { query: query, category: categoryFilter, origin: originFilter, tag: tagFilter, status: statusFilter, limit: pageSize + 1, offset: page * pageSize }))
          var statsParams = Object.assign({}, scopeParams, { query: query })
          return Promise.all([api.entries(params), api.stats(statsParams)]).then(function (results) {
            if (seq !== seqRef.current) return
            var doc = results[0]
            setStats(results[1].stats)
            setHidden(doc.hidden || { total: 0 })
            var sliced = pageSlice(doc.entries, pageSize)
            // 当前页被删空（如删掉末页最后一条）→ 自动回退一页，避免误导性空态。
            if (sliced.items.length === 0 && page > 0) { setPage(page - 1); return }
            // 来源/标签/状态均服务端过滤（分页口径一致）。
            setEntries(sliced.items)
            // 批量选择与列表同步：条目被删除/归档/过滤掉后不再保留在选中集合。
            var visibleIds = {}
            for (var vi = 0; vi < sliced.items.length; vi++) visibleIds[sliced.items[vi].id] = true
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
          return api.status().then(function () {
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
          var picked = defaultViewSelection(settings, currentCwd)
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

        useEffect(function () {
          if (phase !== 'ready' || busy) return
          refreshRecall()
        }, [phase, busy, settings, currentCwd, refreshRecall])

        // 选择/查询/分类/页码变化 → 刷新列表（查询防抖 300ms）
        useEffect(function () {
          if (phase !== 'ready') return undefined
          var timer = setTimeout(function () { refreshEntries() }, (query || tagFilter) ? 300 : 0)
          return function () { clearTimeout(timer) }
        }, [phase, query, categoryFilter, originFilter, tagFilter, statusFilter, page, selection, currentCwd, refreshEntries])

        // toast 自动消失（时长按 toast 自带 duration）；撤销吐司到期后继续展示排队提示。
        useEffect(function () {
          if (!toast) return undefined
          var timer = setTimeout(dismissToast, toast.duration || 2600)
          return function () { clearTimeout(timer) }
        }, [toast])

        // 快捷键：/ 聚焦搜索（无输入焦点、无弹窗时）；Esc 清除批量选择。
        useEffect(function () {
          function onKey(e) {
            if (modalOpenRef.current) return
            var el = document.activeElement
            var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el.closest && el.closest('.dm_select_pop') !== null))
            if (e.key === '/' && !typing) {
              e.preventDefault()
              if (searchRef.current) searchRef.current.focus()
            } else if (e.key === 'Escape' && !typing && selectedRef.current.length > 0) {
              setSelected([])
            }
          }
          document.addEventListener('keydown', onKey)
          return function () { document.removeEventListener('keydown', onKey) }
        }, [])

        var options = [{ value: 'all', kind: 'all' }].concat(workspaceOptions({ workspaces: workspaces, currentCwd: currentCwd }))
        var unknownWorkspaces = workspaces.filter(function (w) { return !w || typeof w.cwd !== 'string' || w.cwd === '' })
        var workspaceTarget = selection !== 'all' && selection !== 'global' ? selection : currentCwd

        function changeQuery(value) { setQuery(value); setPage(0); setSelected([]) }
        function changeSelection(value) { setSelection(value); setPage(0); setSelected([]) }
        function changeCategory(value) { setCategoryFilter(value); setPage(0); setSelected([]) }
        function changeOrigin(value) { setOriginFilter(value); setPage(0); setSelected([]) }
        function changeTag(value) { setTagFilter(value); setPage(0); setSelected([]) }
        // 卡片标签点击 = 精确标签过滤（与服务端 tag= 语义一致），而不是把标签塞进全文查询。
        function filterByTag(tag) {
          setTagFilter(String(tag || ''))
          setQuery('')
          setPage(0)
          setSelected([])
        }
        function changeStatus(value) { setStatusFilter(value); setPage(0); setSelected([]) }
        function clearAllFilters() { setQuery(''); setCategoryFilter(''); setOriginFilter(''); setTagFilter(''); setStatusFilter('active'); setPage(0); setSelected([]) }
        // 被取代条目的「查看后继」：按 id 搜索（host query 匹配 id），回到活跃视图。
        function jumpToEntry(id) { setStatusFilter('all'); setOriginFilter(''); setCategoryFilter(''); setTagFilter(''); setPage(0); setSelected([]); setQuery(String(id || '')) }
        function changePage(value) { setPage(value); setSelected([]) }
        function toggleSelect(id) {
          setSelected(function (prev) { return prev.indexOf(id) === -1 ? prev.concat([id]) : prev.filter(function (x) { return x !== id }) })
        }

        function openCreate() {
          if (busy) return
          setEditor({ mode: 'create', content: '', category: 'fact', tags: '', scope: workspaceTarget && selection !== 'global' ? 'workspace' : 'global', pinned: false, expires: '', origin: 'manual' })
        }
        function openEdit(entry) {
          if (busy) return
          setEditor({ mode: 'edit', id: entry.id, content: entry.content, category: entry.category, tags: (entry.tags || []).join(', '), scope: entry.scope, pinned: !!entry.pinned, expires: entry.expires || '', origin: originOf(entry) })
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
        function quickUpdate(entry, patch, okKey, action) {
          if (busy) return
          setBusy(true)
          api.update(Object.assign({ id: entry.id, workspace: entry.scope === 'workspace' ? workspaceTarget : undefined }, patch)).then(function () {
            showToast('ok', t(okKey), action)
            return refreshRef.current()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function togglePin(entry) {
          quickUpdate(entry, { pinned: !entry.pinned }, entry.pinned ? 'unpinnedMsg' : 'pinnedMsg')
        }
        function toggleArchive(entry) {
          var restoring = !!entry.archived
          quickUpdate(entry, { archived: !restoring }, restoring ? 'restoredMsg' : 'archivedMsg', restoring ? undefined : {
            label: t('undo'),
            run: function () { quickUpdate(entry, { archived: false }, 'restoredMsg') },
          })
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
            var errKey = check.error === 'empty-content' ? 'errEmptyContent' : check.error === 'bad-expires' ? 'errBadExpires' : 'errBadCategory'
            showToast('error', t(errKey))
            return
          }
          var started = editor
          setBusy(true)
          var tags = splitTags(editor.tags)
          var promise
          if (editor.mode === 'create') {
            promise = api.save({
              content: editor.content.trim(),
              category: editor.category,
              scope: editor.scope,
              workspace: editor.scope === 'workspace' ? workspaceTarget : undefined,
              tags: tags,
              origin: 'manual',
              pinned: !!editor.pinned,
              expires: editor.expires || undefined,
            })
          } else {
            promise = api.update({ id: editor.id, content: editor.content.trim(), category: editor.category, tags: tags, scope: editor.scope, workspace: workspaceTarget, pinned: !!editor.pinned, expires: editor.expires || '', origin: editor.origin })
          }
          promise.then(function (payload) {
            if (editorRef.current === started) setEditor(null)
            var result = (payload && payload.result) || {}
            var key = savedToastKey(result)
            var sim = result.similar || []
            if (key === 'similarSaved') showToast('ok', t('similarSaved').replace('{n}', String(sim.length)).replace('{id}', sim[0].id))
            else showToast('ok', t(key))
            // 新建条目按更新时间排在最前：回到第一页让它可见。
            if (started.mode === 'create') setPage(0)
            return refreshRef.current()
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
          var calls = targets.map(function (e) {
            return api.forget({ id: e.id, workspace: e.scope === 'workspace' ? wsTarget : undefined })
          })
          Promise.allSettled(calls).then(function (settled) {
            if (confirmRef.current === started) setConfirm(null)
            var outcome = partitionSettled(targets, settled)
            setSelected([])
            // 成功项先从当前页移除，不必等刷新（刷新也仍会执行）。
            var removed = {}
            for (var i = 0; i < outcome.ok.length; i++) removed[outcome.ok[i].id] = true
            setEntries(function (prev) { return prev.filter(function (e) { return removed[e.id] !== true }) })
            if (outcome.ok.length > 0) {
              var text = outcome.ok.length === 1 ? t('deleted') : t('deletedN').replace('{n}', String(outcome.ok.length))
              var action = { label: t('undo'), run: function () { restoreEntries(outcome.ok, wsTarget) } }
              if (outcome.failed.length > 0) {
                text = t('deletedPartial').replace('{n}', String(outcome.ok.length)).replace('{m}', String(outcome.failed.length)) + '：' + errorText(outcome.failed[0].error, t)
                showToast('error', text, action)
              } else {
                showToast('ok', text, action)
              }
            } else if (outcome.failed.length > 0) {
              showToast('error', t('deleteFailed') + '：' + errorText(outcome.failed[0].error, t))
            }
            return refreshRef.current()
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
            var n = payload && payload.result ? payload.result.imported : 0
            showToast('ok', t('undone').replace('{n}', String(n)))
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(function (err) {
            showToast('error', t('undoFailed') + ': ' + errorText(err, t))
          })
        }

        function handleExport() {
          if (busy) return
          setBusy(true)
          var scopeParams = exportParams(selection, currentCwd)
          api.export(scopeParams).then(function (doc) {
            var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
            var url = URL.createObjectURL(blob)
            var a = document.createElement('a')
            a.href = url
            a.download = 'dsh-memory-export-' + scopeParams.scope + '-' + new Date().toISOString().slice(0, 10) + '.json'
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
            showToast('ok', t('exportDone').replace('{n}', String((doc.entries || []).length)))
          }).catch(writeFailure).then(function () { setBusy(false) })
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
            return api.import({ entries: parsed.doc.entries, dryRun: true }).then(function (payload) {
              setImportPlan({ entries: parsed.doc.entries, plan: payload.result, mode: 'skip' })
            })
          }).catch(function (err) {
            if (err && err.code) writeFailure(err)
            else showToast('error', t('errReadFile') + ': ' + errorText(err, t))
          }).then(function () { setBusy(false) })
        }

        function changeImportMode(mode) {
          if (busy || !importPlan) return
          setBusy(true)
          api.import({ entries: importPlan.entries, dryRun: true, mode: mode }).then(function (payload) {
            setImportPlan({ entries: importPlan.entries, plan: payload.result, mode: mode })
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function confirmImport() {
          if (busy || !importPlan) return
          setBusy(true)
          api.import({ entries: importPlan.entries, mode: importPlan.mode }).then(function (payload) {
            setImportPlan(null)
            var summary = importSummary(payload.result)
            showToast('ok', t('imported') + ' · ' + t('importNew') + ' ' + summary.imported + ' / ' + t('importUpdated') + ' ' + summary.updated + ' / ' + t('importDup') + ' ' + summary.deduplicated + ' / ' + t('importRej') + ' ' + summary.rejected)
            setPage(0)
            return refreshRef.current()
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
            showToast('ok', t('auditSuperseded'))
            return api.similar(params)
          }).then(function (payload) {
            setAudit({ pairs: (payload && payload.pairs) || [], params: params })
            return refreshRef.current()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }
        function dismissPair(pair) {
          if (!audit) return
          setAudit(Object.assign({}, audit, { pairs: audit.pairs.filter(function (p) { return !(p.older.id === pair.older.id && p.newer.id === pair.newer.id) }) }))
        }

        function renderStats() {
          var total = stats ? stats.total : null
          var cats = ['preference', 'fact', 'decision']
          return h('div', { className: 'dm_stats' },
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
                    title: t(CATEGORY_META[cat].label) + ': ' + n,
                  })
                }) : null),
              h('div', { className: 'dm_chips', role: 'group', 'aria-label': t('categoryLabel') },
                h('button', {
                  className: 'dm_chip', 'aria-pressed': categoryFilter === '',
                  onClick: function () { changeCategory('') },
                }, h(Icon, { name: 'layers', size: 13 }), t('categoryAll'), h('span', { className: 'dm_chip_n' }, total === null ? '…' : String(total))),
                cats.map(function (cat) {
                  var meta = CATEGORY_META[cat]
                  return h('button', {
                    key: cat, className: 'dm_chip', 'aria-pressed': categoryFilter === cat,
                    style: { '--dm-chip-c': meta.cat, '--dm-chip-soft': meta.soft },
                    onClick: function () { changeCategory(categoryFilter === cat ? '' : cat) },
                  }, h(Icon, { name: meta.icon, size: 13, strokeWidth: 2 }), t(meta.label),
                    h('span', { className: 'dm_chip_n' }, stats ? String(stats.byCategory[cat] || 0) : '…'))
                })),
              h('div', { className: 'dm_chips dm_chips_status', role: 'group', 'aria-label': t('statusFilterLabel') },
                STATUS_CHIPS.map(function (s) {
                  var n = stats && stats.byStatus ? (s.key === 'all' ? (stats.byStatus.active || 0) + (stats.byStatus.superseded || 0) + (stats.byStatus.expired || 0) + (stats.byStatus.archived || 0) : (stats.byStatus[s.key] || 0)) : null
                  return h('button', {
                    key: s.key, className: 'dm_chip', 'aria-pressed': statusFilter === s.key,
                    style: { '--dm-chip-c': s.c, '--dm-chip-soft': 'color-mix(in srgb,' + s.c + ' 12%,transparent)' },
                    onClick: function () { changeStatus(s.key) },
                  }, h(Icon, { name: s.icon, size: 13, strokeWidth: 2 }), t(s.label),
                    h('span', { className: 'dm_chip_n' }, n === null ? '…' : String(n)))
                }))),
            stats && selection === 'all'
              ? h('div', { className: 'dm_stats_scope' }, t('statsScope').replace('{g}', String(stats.byScope.global || 0)).replace('{w}', String(stats.byScope.workspace || 0)))
              : null)
        }

        function renderList() {
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
          if (listError) {
            return h('div', { className: 'dm_empty' },
              h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
              h('div', null, t('listError') + ': ' + listError),
              h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: function () { refreshEntries() } }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
          }
          if (entries.length === 0) {
            var filtered = !!(query || categoryFilter || originFilter || tagFilter || statusFilter !== 'active')
            // 空态区分「筛选无结果 / 某工作区为空 / 整库为空」，避免切到空工作区误报「记忆库还是空的」。
            var scopedEmpty = selection !== 'all' && selection !== 'global'
            var emptyTitle = filtered ? t('noResults') : scopedEmpty ? t('emptyScopeTitle') : t('emptyTitle')
            var emptyHint = filtered ? t('noResultsHint') : scopedEmpty ? t('emptyScopeHint') : t('emptyHint')
            return h('div', null, hiddenHint,
              h('div', { className: 'dm_empty' },
                h(ConstellationArt, { small: filtered }),
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
          if (selection !== 'all') return h('div', { 'aria-busy': busy ? 'true' : 'false' }, hiddenHint, rows(entries, 0), pager)
          var groups = groupEntries(entries)
          return h('div', { 'aria-busy': busy ? 'true' : 'false' }, hiddenHint,
            groups.global.length ? h('div', { className: 'dm_section_title' }, h(Icon, { name: 'globe', size: 13 }), t('scopeGlobal'), h('span', { className: 'dm_section_n' }, groups.global.length + ' ' + t('entriesUnit'))) : null,
            rows(groups.global, 0),
            groups.workspace.length ? h('div', { className: 'dm_section_title' }, h(Icon, { name: 'folder', size: 13 }), t('scopeWorkspace'), h('span', { className: 'dm_section_n' }, groups.workspace.length + ' ' + t('entriesUnit'))) : null,
            rows(groups.workspace, groups.global.length),
            pager)
        }

        var fileInputRef = useRef(null)

        var noAnim = settings && !settings.effective.animations
        return h('div', { className: 'dm_page' + (selected.length > 0 ? ' dm_selecting' : '') + (noAnim ? ' dm_no_anim' : '') },
          h('div', { className: 'dm_header' },
            h('div', { className: 'dm_brand' },
              h('div', { className: 'dm_brand_medal' }, h(NavIcon, { size: 24 })),
              h('div', null,
                h('div', { className: 'dm_overline' }, t('overline')),
                h('h1', { className: 'dm_title' }, tab === 'settings' ? t('tabSettings') : t('title')),
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
              onClick: function () { setTab('memories') }, onKeyDown: onTabKey,
            }, h(Icon, { name: 'layers', size: 15 }), t('tabMemories'), h('span', { className: 'dm_tab_n' }, stats ? String(stats.total) : '…')),
            h('button', {
              ref: tabSettingsRef, id: 'dm-tab-settings',
              role: 'tab', 'aria-selected': tab === 'settings', 'aria-controls': 'dm-panel-settings',
              tabIndex: tab === 'settings' ? 0 : -1,
              className: 'dm_tab' + (tab === 'settings' ? ' dm_tab_active' : ''),
              onClick: function () { setTab('settings') }, onKeyDown: onTabKey,
            }, h(Icon, { name: 'sliders', size: 15 }), t('tabSettings'))),
          // 两个 tabpanel 常驻 DOM（非激活用 hidden）：aria-controls 始终指向存在的面板，
// 同时保留列表/设置的滚动与焦点上下文；hidden 使非激活面板不可聚焦。
          h('div', { id: 'dm-panel-memories', role: 'tabpanel', 'aria-labelledby': 'dm-tab-memories', hidden: tab !== 'memories' },
              renderStats(),
              h('div', { className: 'dm_toolbar_wrap' },
                h('div', { className: 'dm_toolbar' },
                  h(Select, {
                    ariaLabel: t('scopeLabel'), value: selection, minWidth: 220, onChange: changeSelection,
                    options: options.map(function (opt) {
                      if (opt.kind === 'all') return { value: 'all', label: t('scopeAll'), icon: 'layers' }
                      if (opt.kind === 'global') return { value: 'global', label: t('scopeGlobal'), icon: 'globe' }
                      return { value: opt.value, label: (opt.value === currentCwd ? '● ' : '') + opt.value, hint: String(opt.count || 0), icon: 'folder' }
                    }).concat(unknownWorkspaces.map(function (w) {
                      return { value: 'unknown-' + w.key, label: t('workspaceUnknown') + ' (' + String(w.key).slice(0, 8) + '…)', icon: 'folder', disabled: true }
                    })),
                  }),
                  h(Select, {
                    ariaLabel: t('originFilterLabel'), value: originFilter, minWidth: 150, onChange: changeOrigin,
                    options: [
                      { value: '', label: t('originAll'), icon: 'layers' },
                      { value: 'auto', label: t('originAuto'), icon: 'zap' },
                      { value: 'manual', label: t('originManual'), icon: 'edit' },
                    ],
                  }),
                  h('input', {
                    className: 'dm_taginput', type: 'text', 'aria-label': t('tagFilterPlaceholder'), placeholder: t('tagFilterPlaceholder'), title: t('tagFilterHint'),
                    value: tagFilter, onChange: function (e) { changeTag(e.target.value) },
                  }),
                  h('div', { className: 'dm_searchwrap' },
                    h('span', { className: 'dm_search_icon' }, h(Icon, { name: 'search', size: 15 })),
                    h('input', {
                      ref: searchRef, className: 'dm_search', type: 'text', inputMode: 'search',
                      'aria-label': t('searchPlaceholder'), placeholder: t('searchPlaceholder'), title: t('searchHint'),
                      value: query, onChange: function (e) { changeQuery(e.target.value) },
                    }),
                    query ? h('button', { className: 'dm_search_clear', 'aria-label': t('clearFilters'), onClick: function () { changeQuery('') } }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 })) : null),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: handleExport, disabled: busy || phase !== 'ready' }, h(Icon, { name: 'export', size: 15 }), t('export')),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: function () { if (fileInputRef.current) fileInputRef.current.click() }, disabled: busy || phase !== 'ready' }, h(Icon, { name: 'import', size: 15 }), t('import')),
                  h('button', { className: 'dm_btn dm_toolbtn', onClick: handleAudit, disabled: busy || phase !== 'ready' }, h(Icon, { name: 'copy', size: 15 }), t('audit')),
                  h('input', { ref: fileInputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: handleImportFile }))),
              unknownWorkspaces.length > 0 ? h('div', { className: 'dm_hint', style: { margin: '8px 0 0' } }, t('unknownWorkspaceHint')) : null,
              phase === 'loading' ? h(Skeletons)
                : phase === 'error' ? h('div', { className: 'dm_empty' },
                  h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
                  h('div', null, t('loadError') + ': ' + errorTextState),
                  h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: function () { loadInitial() } }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
                  : renderList(),
              selected.length > 0
                ? h('div', { className: 'dm_selbar' },
                  h('span', { className: 'dm_selbar_n' }, t('bulkSelected').replace('{n}', String(selected.length))),
                  h('button', { className: 'dm_btn dm_btn_danger_solid', onClick: openBulkDelete, disabled: busy }, h(Icon, { name: 'trash', size: 14 }), t('bulkDelete')),
                  h('button', { className: 'dm_btn', onClick: function () { setSelected([]) }, disabled: busy }, t('clearSelection')))
                : null),
          h('div', { id: 'dm-panel-settings', role: 'tabpanel', 'aria-labelledby': 'dm-tab-settings', hidden: tab !== 'settings' },
            h(SettingsPage, {
              view: settings, draft: draft, busy: busy, status: settingsStatus, t: t, api: api, workspace: currentCwd,
              error: settingsError, onRetry: loadSettings, onRetrySave: retrySaveSettings,
              onChange: changeSetting, onReset: resetSettings, onBackup: backupNow,
              onToast: function (text, kind) { showToast(kind, text) },
            })),
          editor ? h(EditorModal, { draft: editor, setDraft: setEditor, t: t, workspaceTarget: workspaceTarget, busy: busy, onSave: handleSave, onClose: function () { if (!busy) setEditor(null) } }) : null,
          confirm ? h(ConfirmModal, { entries: confirm.entries, t: t, busy: busy, onConfirm: handleDelete, onClose: function () { if (!busy) setConfirm(null) } }) : null,
          importPlan ? h(ImportModal, { plan: importPlan.plan, mode: importPlan.mode, t: t, busy: busy, onConfirm: confirmImport, onModeChange: changeImportMode, onClose: function () { if (!busy) setImportPlan(null) } }) : null,
          audit ? h(AuditModal, { pairs: audit.pairs, t: t, busy: busy, onSupersede: handleSupersedePair, onDismiss: dismissPair, onClose: function () { if (!busy) setAudit(null) } }) : null,
          toast ? h(Toast, { toast: toast, t: t, raised: selected.length > 0, onClose: dismissToast, actionRef: toastActionRef }) : null)
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
