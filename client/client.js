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

  function validateDraft(draft) {
    var content = String((draft && draft.content) || '').trim()
    if (content === '') return { ok: false, error: 'empty-content' }
    var category = (draft && draft.category) || 'fact'
    if (['preference', 'fact', 'decision'].indexOf(category) === -1) return { ok: false, error: 'bad-category' }
    return { ok: true }
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

  function buildEntriesQuery(params) {
    var p = params || {}
    var parts = ['scope=' + encodeURIComponent(p.scope || 'all')]
    if (p.workspace) parts.push('workspace=' + encodeURIComponent(p.workspace))
    if (p.query) parts.push('query=' + encodeURIComponent(p.query))
    if (p.category) parts.push('category=' + encodeURIComponent(p.category))
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
    var msg = err.message
    if (msg === 'unauthorized') return 'errUnauthorized'
    if (msg === 'loopback-only') return 'errLoopback'
    if (msg === 'invalid-json') return 'errInvalidJson'
    if (msg === 'body-too-large') return 'errBodyTooLarge'
    if (err.status === 403) return 'errUnauthorized'
    return null
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

  var helpers = { validateDraft: validateDraft, groupEntries: groupEntries, nextToken: nextToken, buildEntriesQuery: buildEntriesQuery, workspaceOptions: workspaceOptions, errorKeyFor: errorKeyFor, validateImportDoc: validateImportDoc, importSummary: importSummary, pageSlice: pageSlice, entryDetailRows: entryDetailRows, relativeTime: relativeTime }

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

  var ZH = {
    nav: '记忆',
    overline: 'LONG-TERM MEMORY',
    title: '记忆管理',
    subtitle: '跨会话长期记忆 · 全局与工作区',
    searchPlaceholder: '搜索记忆…',
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
    deduplicated: '已有相同记忆，未重复写入',
    deleted: '已删除',
    deletedN: '已删除 {n} 条',
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
    pagePrev: '上一页',
    pageNext: '下一页',
    pageInfo: '第 {page} 页',
    copyId: '复制 id',
    copied: '已复制 id',
    copyFailed: '复制失败，请手动选择',
    createdAt: '创建于',
    updatedAt: '更新于',
    sourceLabel: '来源会话',
    tagSearch: '按此标签搜索',
    workspaceUnknown: '未知工作区',
    unknownWorkspaceHint: '有工作区路径未知（索引损坏），无法在面板中浏览；可用「导出」查看全部记忆，或手工修复数据目录下的 workspaces/index.json。',
    entriesUnit: '条',
    workspaceTarget: '写入工作区',
    export: '导出',
    import: '导入',
    exportDone: '已导出全部记忆',
    importTitle: '导入记忆',
    importNew: '新增',
    importDup: '重复跳过',
    importRej: '拒绝',
    importRejHint: '被拒绝的条目（机密/无效/缺工作区）不会写入。',
    importConfirm: '确认导入',
    importAllDup: '全部条目均已存在，无需导入。',
    imported: '导入完成',
    errDuplicate: '目标作用域已有相同内容的记忆',
    errImportDoc: '不是有效的 dsh-memory 导出文件（format/version/entries 不符）',
  }
  var EN = {
    nav: 'Memory',
    overline: 'LONG-TERM MEMORY',
    title: 'Memory manager',
    subtitle: 'Cross-session long-term memory · global & workspace',
    searchPlaceholder: 'Search memories…',
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
    deduplicated: 'Identical memory exists; nothing added',
    deleted: 'Deleted',
    deletedN: 'Deleted {n}',
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
    pagePrev: 'Previous',
    pageNext: 'Next',
    pageInfo: 'Page {page}',
    copyId: 'Copy id',
    copied: 'Id copied',
    copyFailed: 'Copy failed; select manually',
    createdAt: 'Created',
    updatedAt: 'Updated',
    sourceLabel: 'Source session',
    tagSearch: 'Search by this tag',
    workspaceUnknown: 'Unknown workspace',
    unknownWorkspaceHint: 'Some workspace paths are unknown (corrupt index) and cannot be browsed here. Use Export to see all memories, or repair workspaces/index.json in the data directory by hand.',
    entriesUnit: 'entries',
    workspaceTarget: 'Writes to workspace',
    export: 'Export',
    import: 'Import',
    exportDone: 'All memories exported',
    importTitle: 'Import memories',
    importNew: 'New',
    importDup: 'Duplicates skipped',
    importRej: 'Rejected',
    importRejHint: 'Rejected entries (credentials/invalid/no workspace) are not written.',
    importConfirm: 'Import',
    importAllDup: 'All entries already exist; nothing to import.',
    imported: 'Import complete',
    errDuplicate: 'Identical memory already exists in the target scope',
    errImportDoc: 'Not a valid dsh-memory export file (format/version/entries mismatch)',
  }

  var CSS = [
    // ---- 页面与调色板（浅色默认，深色跟随宿主） ----
    '.dm_page{--dm-bg:var(--dsw-alias-bg-base,#f5f6fa);--dm-surface:var(--dsw-alias-bg-layer-1,#ffffff);--dm-ink:var(--dsw-alias-label-primary,#15171e);--dm-ink2:var(--dsw-alias-label-secondary,#5b6272);--dm-ink3:var(--dsw-alias-label-tertiary,#99a1b2);--dm-line:var(--dsw-alias-border-l1,rgba(21,23,30,.07));--dm-line2:var(--dsw-alias-border-l2,rgba(21,23,30,.14));--dm-primary:var(--dsw-alias-state-business-primary,#5b5bd6);--dm-primary2:#8b5cf6;--dm-on-primary:var(--dsw-alias-label-on-color,#ffffff);--dm-pref:#b45309;--dm-pref-soft:rgba(217,119,6,.12);--dm-fact:#1d4ed8;--dm-fact-soft:rgba(59,130,246,.12);--dm-dec:#047857;--dm-dec-soft:rgba(16,185,129,.13);--dm-danger:var(--dsw-alias-state-error-primary,#dc2626);--dm-danger-soft:rgba(220,38,38,.10);--dm-success:var(--dsw-alias-state-success-primary,#059669);--dm-success-soft:rgba(5,150,105,.12);--dm-amb-a:rgba(99,102,241,.10);--dm-amb-b:rgba(217,119,6,.07);--dm-shadow:0 1px 2px rgba(15,18,30,.05),0 10px 28px -14px rgba(15,18,30,.14);--dm-shadow-hover:0 2px 4px rgba(15,18,30,.06),0 18px 44px -16px rgba(15,18,30,.24);--dm-ring:0 0 0 3px color-mix(in srgb,var(--dm-primary) 22%,transparent);height:100%;overflow-y:auto;box-sizing:border-box;color:var(--dm-ink);padding:calc(var(--dsh-frame-top-clearance,48px) + 18px) 24px 40px;font-size:13px;line-height:1.5;background-color:var(--dm-bg);background-image:radial-gradient(900px 460px at 88% -8%,var(--dm-amb-a),transparent 62%),radial-gradient(720px 420px at -8% 24%,var(--dm-amb-b),transparent 58%);background-attachment:local;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dm-ink) 22%,transparent) transparent;}',
    'body[data-ds-dark-theme] .dm_page{--dm-bg:var(--dsw-alias-bg-base,#0f1115);--dm-surface:var(--dsw-alias-bg-layer-1,#171a21);--dm-ink:var(--dsw-alias-label-primary,#e8eaf0);--dm-ink2:var(--dsw-alias-label-secondary,#a8aebd);--dm-ink3:var(--dsw-alias-label-tertiary,#6f7688);--dm-line:var(--dsw-alias-border-l1,rgba(232,234,240,.07));--dm-line2:var(--dsw-alias-border-l2,rgba(232,234,240,.15));--dm-primary2:#a78bfa;--dm-pref:#fbbf24;--dm-pref-soft:rgba(251,191,36,.14);--dm-fact:#60a5fa;--dm-fact-soft:rgba(96,165,250,.15);--dm-dec:#34d399;--dm-dec-soft:rgba(52,211,153,.14);--dm-danger:var(--dsw-alias-state-error-primary,#f87171);--dm-danger-soft:rgba(248,113,113,.14);--dm-success:var(--dsw-alias-state-success-primary,#34d399);--dm-success-soft:rgba(52,211,153,.14);--dm-amb-a:rgba(139,92,246,.15);--dm-amb-b:rgba(251,191,36,.06);--dm-shadow:0 1px 2px rgba(0,0,0,.42),0 12px 32px -14px rgba(0,0,0,.55);--dm-shadow-hover:0 2px 4px rgba(0,0,0,.45),0 20px 48px -16px rgba(0,0,0,.65);}',
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
    '.dm_search_clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:none;border-radius:50%;background:transparent;color:var(--dm-ink3);cursor:pointer;display:flex;align-items:center;justify-content:center;corner-shape:round;}',
    '.dm_search_clear:hover{background:var(--dm-line);color:var(--dm-ink);}',
    '.dm_toolbtn{height:36px;}',
    // ---- 分组标题 ----
    '.dm_section_title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--dm-ink2);letter-spacing:.05em;margin:18px 0 10px;}',
    '.dm_section_n{font-size:11px;font-weight:500;color:var(--dm-ink3);background:var(--dm-line);border-radius:999px;padding:1px 8px;corner-shape:round;}',
    // ---- 记忆卡片 ----
    '.dm_card{position:relative;display:flex;gap:12px;border:1px solid var(--dm-line);border-radius:14px;padding:14px 14px 12px 12px;margin-bottom:10px;background:var(--dm-surface);box-shadow:var(--dm-shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;animation:dm_enter .4s ease backwards;}',
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
    '.dm_catgrid{display:flex;gap:8px;}',
    '.dm_catopt{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--dm-line2);border-radius:12px;background:transparent;color:var(--dm-ink2);padding:10px 8px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;transition:all .15s;}',
    '.dm_catopt:hover{border-color:color-mix(in srgb,var(--dm-cat) 45%,var(--dm-line2));color:var(--dm-cat);}',
    '.dm_catopt:focus-visible{outline:none;box-shadow:var(--dm-ring);}',
    '.dm_catopt[aria-checked="true"]{background:var(--dm-cat-soft);border-color:color-mix(in srgb,var(--dm-cat) 55%,transparent);color:var(--dm-cat);}',
    '.dm_dialog_footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;align-items:center;}',
    '.dm_dialog_footer .dm_hint{margin-right:auto;}',
    '.dm_delete_preview{border:1px solid var(--dm-line);border-radius:12px;padding:12px;margin:10px 0;white-space:pre-wrap;word-break:break-word;background:var(--dm-bg);max-height:36vh;overflow-y:auto;font-size:13px;line-height:1.6;}',
    '.dm_hint{color:var(--dm-ink3);font-size:11.5px;}',
    '.dm_import_tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0 10px;}',
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
    // ---- 响应式与动效偏好 ----
    '@media (max-width:720px){.dm_header{flex-direction:column;}.dm_cta{width:100%;justify-content:center;}.dm_stats{gap:12px;padding:12px 14px;}.dm_stats_div{display:none;}.dm_card_actions{flex-direction:row;}.dm_card{flex-wrap:wrap;}.dm_import_tiles{grid-template-columns:repeat(3,1fr);}}',
    '@media (prefers-reduced-motion:reduce){.dm_page *,.dm_page *::before,.dm_page *::after,.dm_toast,.dm_selbar,.dm_overlay,.dm_dialog{animation:none !important;transition:none !important;}}',
  ].join('\n')

  global.__ModuleLoader__.load({
    id: 'dsh-memory',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useCallback = React.useCallback

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

      function splitTags(text) {
        return String(text || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
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
          return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options)).then(function (res) {
            return res.json().catch(function () { return null }).then(function (payload) {
              tokenRef.current = nextToken(tokenRef.current, { status: res.status, payload: payload })
              if (!res.ok) {
                var err = new Error((payload && (payload.error || payload.code)) || ('HTTP ' + res.status))
                err.status = res.status
                err.code = payload && payload.code
                throw err
              }
              return payload
            })
          })
        }
        function post(path, input) {
          return request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RPC-Key': tokenRef.current },
            body: JSON.stringify(input || {}),
          })
        }
        return {
          status: function () { return request(API_BASE + '/status') },
          workspaces: function () { return request(API_BASE + '/workspaces') },
          entries: function (params) { return request(API_BASE + '/entries' + buildEntriesQuery(params)) },
          stats: function (params) { return request(API_BASE + '/stats' + buildEntriesQuery(params)) },
          export: function () { return request(API_BASE + '/export') },
          save: function (input) { return post(API_BASE + '/save', input) },
          update: function (input) { return post(API_BASE + '/update', input) },
          forget: function (input) { return post(API_BASE + '/forget', input) },
          import: function (input) { return post(API_BASE + '/import', input) },
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
        var expandedState = useState(false)
        var expanded = expandedState[0]; var setExpanded = expandedState[1]
        function toggle() { setExpanded(!expanded) }
        function copyId() {
          copyText(entry.id).then(function () { props.onToast(t('copied'), 'ok') }, function () { props.onToast(t('copyFailed'), 'error') })
        }
        var checked = props.selected
        return h('div', {
          className: 'dm_card' + (checked ? ' dm_card_selected' : ''),
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
              h('span', { className: 'dm_scope_chip' },
                h(Icon, { name: entry.scope === 'global' ? 'globe' : 'folder', size: 12 }),
                entry.scope === 'global' ? t('scopeGlobal') : t('scopeWorkspace')),
              h('span', { className: 'dm_time', title: formatTime(entry.updated) },
                h(Icon, { name: 'clock', size: 11, style: { verticalAlign: '-1px', marginRight: 3 } }),
                relativeTime(entry.updated, Date.now(), uiLang()))),
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
                  return h('div', { className: 'dm_details_row', key: row.key },
                    h('span', { className: 'dm_details_k' }, t(row.key) + ':'),
                    h('span', { className: 'dm_details_v' }, row.key === 'sourceLabel' ? row.value : formatTime(row.value)))
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
            h('button', { className: 'dm_btn', onClick: function () { props.onEdit(entry) } }, h(Icon, { name: 'edit', size: 13 }), t('edit')),
            h('button', { className: 'dm_btn dm_btn_danger', onClick: function () { props.onDelete(entry) } }, h(Icon, { name: 'trash', size: 13 }), t('del'))))
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
            h('div', { className: 'dm_catgrid', role: 'radiogroup', 'aria-label': t('categoryLabel') },
              ['preference', 'fact', 'decision'].map(function (cat) {
                var meta = CATEGORY_META[cat]
                return h('button', {
                  key: cat, type: 'button', role: 'radio', 'aria-checked': draft.category === cat,
                  className: 'dm_catopt', style: catVars(cat), disabled: props.busy,
                  onClick: function () { field('category', cat) },
                }, h(Icon, { name: meta.icon, size: 15, strokeWidth: 2 }), t(meta.label))
              }))),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-scope' }, h(Icon, { name: 'layers', size: 13 }), t('scopeLabel')),
            h('select', { id: 'dm-scope', className: 'dm_select', disabled: props.busy, value: draft.scope, onChange: function (e) { field('scope', e.target.value) } },
              h('option', { value: 'global' }, t('scopeGlobal')),
              workspaceTarget ? h('option', { value: 'workspace' }, t('scopeWorkspace') + ' — ' + workspaceTarget) : null,
              !workspaceTarget && draft.scope === 'workspace' ? h('option', { value: 'workspace', disabled: true }, t('scopeWorkspace')) : null),
            draft.scope === 'workspace' && workspaceTarget
              ? h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('workspaceTarget') + ': ' + workspaceTarget)
              : null),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-tags' }, h(Icon, { name: 'tag', size: 13 }), t('tagsLabel')),
            h('input', { id: 'dm-tags', className: 'dm_input', disabled: props.busy, value: draft.tags, onChange: function (e) { field('tags', e.target.value) }, onKeyDown: onKeySave })),
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
        return h(Modal, { title: t('importTitle'), onClose: props.onClose, busy: props.busy },
          h('div', { className: 'dm_dialog_head' },
            h('div', { className: 'dm_dialog_medal dm_dialog_medal_primary' }, h(Icon, { name: 'import', size: 17, strokeWidth: 2 })),
            h('h2', { className: 'dm_dialog_title' }, t('importTitle'))),
          h('div', { className: 'dm_import_tiles' },
            h('div', { className: 'dm_tile' }, h('div', { className: 'dm_tile_num', style: { color: 'var(--dm-primary)' } }, summary.imported), h('div', { className: 'dm_tile_label' }, t('importNew'))),
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
          summary.imported === 0 && summary.deduplicated > 0
            ? h('div', { className: 'dm_hint', style: { marginTop: 8 } }, t('importAllDup'))
            : null,
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_primary', onClick: props.onConfirm, disabled: props.busy || summary.imported === 0 }, h(Icon, { name: 'check', size: 14, strokeWidth: 2.2 }), t('importConfirm'))))
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
          toast.action ? h('button', { className: 'dm_toast_action', onClick: function () { toast.action.run() } }, h(Icon, { name: 'undo', size: 13, strokeWidth: 2.2, style: { verticalAlign: '-2px', marginRight: 4 } }), toast.action.label) : null,
          h('button', { className: 'dm_toast_close', 'aria-label': t('cancel'), onClick: props.onClose }, h(Icon, { name: 'x', size: 12, strokeWidth: 2.2 })),
          h('span', { className: 'dm_toast_bar', style: { animationDuration: (toast.duration || 2600) + 'ms' } }))
      }

      function currentSessionCwd(ctx) {
        try {
          var sessions = ctx.get('sessions')
          var snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null
          var rows = snap && snap.byId ? Object.keys(snap.byId).map(function (k) { return snap.byId[k] }) : []
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i]
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0 && typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
          }
        } catch { /* sessions 服务不可用时忽略 optional */ }
        return undefined
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

        var phaseState = useState('loading')
        var phase = phaseState[0]; var setPhase = phaseState[1]
        var entriesState = useState([])
        var entries = entriesState[0]; var setEntries = entriesState[1]
        var statsState = useState(null)
        var stats = statsState[0]; var setStats = statsState[1]
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
        var toastState = useState(null)
        var toast = toastState[0]; var setToast = toastState[1]
        var busyState = useState(false)
        var busy = busyState[0]; var setBusy = busyState[1]
        var errorState = useState('')
        var errorTextState = errorState[0]; var setErrorText = errorState[1]
        var listErrorState = useState('')
        var listError = listErrorState[0]; var setListError = listErrorState[1]

        var editorRef = useRef(null)
        editorRef.current = editor
        var confirmRef = useRef(null)
        confirmRef.current = confirm
        var modalOpenRef = useRef(false)
        modalOpenRef.current = !!(editor || confirm || importPlan)
        var selectedRef = useRef(selected)
        selectedRef.current = selected

        function showToast(kind, text, action) {
          toastSeq.current += 1
          setToast({ id: toastSeq.current, kind: kind, text: text, action: action, duration: action ? UNDO_MS : 2600 })
        }

        // 列表＋统计请求：seq 守卫防乱序；「全部」＝全局＋当前工作区。
        // 多取一条（PAGE_SIZE+1）探测下一页；过滤/切换作用域时回到第一页。
        var refreshEntries = useCallback(function () {
          var seq = ++seqRef.current
          var scopeParams = {}
          if (selection === 'global') scopeParams.scope = 'global'
          else if (selection === 'all') { scopeParams.scope = 'all'; scopeParams.workspace = currentCwd }
          else { scopeParams.scope = 'workspace'; scopeParams.workspace = selection }
          var params = Object.assign({}, scopeParams, { query: query, category: categoryFilter, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE })
          var statsParams = Object.assign({}, scopeParams, { query: query })
          return Promise.all([api.entries(params), api.stats(statsParams)]).then(function (results) {
            if (seq !== seqRef.current) return
            var doc = results[0]
            setStats(results[1].stats)
            var sliced = pageSlice(doc.entries, PAGE_SIZE)
            // 当前页被删空（如删掉末页最后一条）→ 自动回退一页，避免误导性空态。
            if (sliced.items.length === 0 && page > 0) { setPage(page - 1); return }
            setEntries(sliced.items)
            setHasMore(sliced.hasMore)
            setListError('')
          }).catch(function (err) {
            if (seq !== seqRef.current) return
            setListError(errorText(err, t))
          })
        }, [api, query, categoryFilter, page, selection, currentCwd, t])

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
            setCurrentCwd(currentSessionCwd(ctx))
            setPhase('ready')
          }).catch(function (err) {
            setErrorText(errorText(err, t))
            setPhase('error')
          })
        }, [api, ctx, t])

        useEffect(function () { loadInitial() }, [loadInitial])

        // 选择/查询/分类/页码变化 → 刷新列表（查询防抖 300ms）
        useEffect(function () {
          if (phase !== 'ready') return undefined
          var timer = setTimeout(function () { refreshEntries() }, query ? 300 : 0)
          return function () { clearTimeout(timer) }
        }, [phase, query, categoryFilter, page, selection, currentCwd, refreshEntries])

        // toast 自动消失（时长按 toast 自带 duration）
        useEffect(function () {
          if (!toast) return undefined
          var timer = setTimeout(function () { setToast(null) }, toast.duration || 2600)
          return function () { clearTimeout(timer) }
        }, [toast])

        // 快捷键：/ 聚焦搜索（无输入焦点、无弹窗时）；Esc 清除批量选择。
        useEffect(function () {
          function onKey(e) {
            if (modalOpenRef.current) return
            var el = document.activeElement
            var typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
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
        function changePage(value) { setPage(value); setSelected([]) }
        function toggleSelect(id) {
          setSelected(function (prev) { return prev.indexOf(id) === -1 ? prev.concat([id]) : prev.filter(function (x) { return x !== id }) })
        }

        function openCreate() {
          if (busy) return
          setEditor({ mode: 'create', content: '', category: 'fact', tags: '', scope: workspaceTarget && selection !== 'global' ? 'workspace' : 'global' })
        }
        function openEdit(entry) {
          if (busy) return
          setEditor({ mode: 'edit', id: entry.id, content: entry.content, category: entry.category, tags: (entry.tags || []).join(', '), scope: entry.scope })
        }
        function openDelete(entry) {
          if (busy) return
          setConfirm({ entries: [entry] })
        }
        function openBulkDelete() {
          if (busy) return
          var chosen = entries.filter(function (e) { return selected.indexOf(e.id) !== -1 })
          if (chosen.length === 0) return
          setConfirm({ entries: chosen })
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
            showToast('error', t(check.error === 'empty-content' ? 'errEmptyContent' : 'errBadCategory'))
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
            })
          } else {
            promise = api.update({ id: editor.id, content: editor.content.trim(), category: editor.category, tags: tags, scope: editor.scope, workspace: workspaceTarget })
          }
          promise.then(function (payload) {
            if (editorRef.current === started) setEditor(null)
            var dedup = payload && payload.result && payload.result.deduplicated
            showToast('ok', dedup ? t('deduplicated') : t('saved'))
            // 新建条目按更新时间排在最前：回到第一页让它可见。
            if (started.mode === 'create') setPage(0)
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        // 删除（单条/批量）→ 确认 → forget → 撤销吐司（import 原样恢复 id/时间戳）。
        function handleDelete() {
          if (busy || !confirm) return
          var started = confirm
          var targets = started.entries
          var wsTarget = workspaceTarget
          setBusy(true)
          Promise.all(targets.map(function (e) {
            return api.forget({ id: e.id, workspace: e.scope === 'workspace' ? wsTarget : undefined })
          })).then(function () {
            if (confirmRef.current === started) setConfirm(null)
            setSelected([])
            var text = targets.length === 1 ? t('deleted') : t('deletedN').replace('{n}', String(targets.length))
            showToast('ok', text, {
              label: t('undo'),
              run: function () { restoreEntries(targets, wsTarget) },
            })
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
          api.export().then(function (doc) {
            var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
            var url = URL.createObjectURL(blob)
            var a = document.createElement('a')
            a.href = url
            a.download = 'dsh-memory-export-' + new Date().toISOString().slice(0, 10) + '.json'
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
            showToast('ok', t('exportDone'))
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function handleImportFile(e) {
          var file = e.target.files && e.target.files[0]
          e.target.value = ''
          if (!file || busy) return
          if (file.size > 1024 * 1024) {
            showToast('error', t('errBodyTooLarge'))
            return
          }
          file.text().then(function (text) {
            var doc
            try { doc = JSON.parse(text) } catch { showToast('error', t('errInvalidJson')); return undefined }
            if (!validateImportDoc(doc).ok) {
              showToast('error', t('errImportDoc'))
              return undefined
            }
            setBusy(true)
            return api.import({ entries: doc.entries, dryRun: true }).then(function (payload) {
              setImportPlan({ entries: doc.entries, plan: payload.result })
            }).catch(writeFailure).then(function () { setBusy(false) })
          }).catch(function () {
            showToast('error', t('errInvalidJson'))
          })
        }

        function confirmImport() {
          if (busy || !importPlan) return
          setBusy(true)
          api.import({ entries: importPlan.entries }).then(function (payload) {
            setImportPlan(null)
            var summary = importSummary(payload.result)
            showToast('ok', t('imported') + ' · ' + t('importNew') + ' ' + summary.imported + ' / ' + t('importDup') + ' ' + summary.deduplicated + ' / ' + t('importRej') + ' ' + summary.rejected)
            setPage(0)
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
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
          if (listError) {
            return h('div', { className: 'dm_empty' },
              h(Icon, { name: 'alert', size: 28, style: { color: 'var(--dm-danger)', marginBottom: 10 } }),
              h('div', null, t('listError') + ': ' + listError),
              h('button', { className: 'dm_btn', style: { marginTop: 12 }, onClick: function () { refreshEntries() } }, h(Icon, { name: 'undo', size: 13 }), t('retry')))
          }
          if (entries.length === 0) {
            var filtered = !!(query || categoryFilter)
            return h('div', null,
              h('div', { className: 'dm_empty' },
                h(ConstellationArt, { small: filtered }),
                h('div', { className: 'dm_empty_title' }, filtered ? t('noResults') : t('emptyTitle')),
                h('div', { className: 'dm_empty_hint' }, filtered ? t('noResultsHint') : t('emptyHint')),
                filtered
                  ? h('button', { className: 'dm_btn', style: { marginTop: 14 }, onClick: function () { changeQuery(''); changeCategory('') } }, h(Icon, { name: 'x', size: 13 }), t('clearFilters'))
                  : page === 0 ? h('button', { className: 'dm_btn dm_btn_primary', style: { marginTop: 14 }, onClick: openCreate }, h(Icon, { name: 'plus', size: 14, strokeWidth: 2.2 }), t('newMemory')) : null),
              pager)
          }
          function rows(list, offset) {
            return list.map(function (entry, i) {
              return h(MemoryCard, {
                key: entry.id, entry: entry, t: t, index: offset + i,
                selected: selected.indexOf(entry.id) !== -1,
                onToggleSelect: toggleSelect,
                onEdit: openEdit, onDelete: openDelete,
                onTagClick: changeQuery,
                onToast: function (text, kind) { showToast(kind, text) },
              })
            })
          }
          if (selection !== 'all') return h('div', null, rows(entries, 0), pager)
          var groups = groupEntries(entries)
          return h('div', null,
            groups.global.length ? h('div', { className: 'dm_section_title' }, h(Icon, { name: 'globe', size: 13 }), t('scopeGlobal'), h('span', { className: 'dm_section_n' }, groups.global.length + ' ' + t('entriesUnit'))) : null,
            rows(groups.global, 0),
            groups.workspace.length ? h('div', { className: 'dm_section_title' }, h(Icon, { name: 'folder', size: 13 }), t('scopeWorkspace'), h('span', { className: 'dm_section_n' }, groups.workspace.length + ' ' + t('entriesUnit'))) : null,
            rows(groups.workspace, groups.global.length),
            pager)
        }

        var fileInputRef = useRef(null)

        return h('div', { className: 'dm_page' + (selected.length > 0 ? ' dm_selecting' : '') },
          h('div', { className: 'dm_header' },
            h('div', { className: 'dm_brand' },
              h('div', { className: 'dm_brand_medal' }, h(NavIcon, { size: 24 })),
              h('div', null,
                h('div', { className: 'dm_overline' }, t('overline')),
                h('h1', { className: 'dm_title' }, t('title')),
                h('div', { className: 'dm_subtitle' }, t('subtitle')))),
            h('button', { className: 'dm_btn dm_btn_primary dm_cta', onClick: openCreate, disabled: busy }, h(Icon, { name: 'plus', size: 15, strokeWidth: 2.2 }), t('newMemory'))),
          renderStats(),
          h('div', { className: 'dm_toolbar_wrap' },
            h('div', { className: 'dm_toolbar' },
              h('select', { className: 'dm_select', 'aria-label': t('scopeLabel'), value: selection, onChange: function (e) { changeSelection(e.target.value) } },
                options.map(function (opt) {
                  var label = opt.kind === 'all' ? t('scopeAll')
                    : opt.kind === 'global' ? t('scopeGlobal')
                      : (opt.value === currentCwd ? '● ' : '') + opt.value + ' (' + (opt.count || 0) + ')'
                  return h('option', { key: opt.value, value: opt.value }, label)
                }),
                unknownWorkspaces.map(function (w) {
                  return h('option', { key: 'unknown-' + w.key, value: 'unknown-' + w.key, disabled: true }, t('workspaceUnknown') + ' (' + String(w.key).slice(0, 8) + '…)')
                })),
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
            : null,
          editor ? h(EditorModal, { draft: editor, setDraft: setEditor, t: t, workspaceTarget: workspaceTarget, busy: busy, onSave: handleSave, onClose: function () { if (!busy) setEditor(null) } }) : null,
          confirm ? h(ConfirmModal, { entries: confirm.entries, t: t, busy: busy, onConfirm: handleDelete, onClose: function () { if (!busy) setConfirm(null) } }) : null,
          importPlan ? h(ImportModal, { plan: importPlan.plan, t: t, busy: busy, onConfirm: confirmImport, onClose: function () { if (!busy) setImportPlan(null) } }) : null,
          toast ? h(Toast, { toast: toast, t: t, raised: selected.length > 0, onClose: function () { setToast(null) } }) : null)
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
