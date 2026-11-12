/**
 * dsh-memory 浏览器客户端 —— 手写 classic script，无构建步骤。
 * 纯逻辑函数经 UMD 尾部导出供 node 单测（缝 4）；浏览器侧注册惰性 factory。
 * 与 dsh-reverse-proxy-connect 同一产物形态：window.__ModuleLoader__.load。
 *
 * 面板：layout main keyed 槽（key=dsh-memory）+ sidebar.panellist 导航。
 * 数据面：同源 fetch /plugins/dsh-memory/*（进程级 token，写操作带 X-RPC-Key）。
 * 样式只用 --dsw-alias-* 主题令牌；文案走 ctx.locale（zh/en）。
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

  var helpers = { validateDraft: validateDraft, groupEntries: groupEntries, nextToken: nextToken, buildEntriesQuery: buildEntriesQuery, workspaceOptions: workspaceOptions, errorKeyFor: errorKeyFor, validateImportDoc: validateImportDoc, importSummary: importSummary, pageSlice: pageSlice, entryDetailRows: entryDetailRows }

  // ===== node 测试导出（CJS） =====
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers
    return
  }

  // ===== 浏览器模块注册 =====

  var API_BASE = '/plugins/dsh-memory'
  var NS = 'dsh-memory'
  var PAGE_SIZE = 50

  var ZH = {
    nav: '记忆',
    title: '记忆管理',
    subtitle: '跨会话长期记忆 · 全局与工作区',
    searchPlaceholder: '搜索记忆…',
    newMemory: '新建记忆',
    scopeGlobal: '全局',
    scopeWorkspace: '工作区',
    scopeAll: '全局＋当前工作区',
    empty: '暂无记忆',
    emptyHint: '对话中说「记住…」，或点右上角新建。',
    noResults: '没有匹配的记忆',
    edit: '编辑',
    del: '删除',
    save: '保存',
    cancel: '取消',
    contentLabel: '内容（一条事实）',
    categoryLabel: '分类',
    tagsLabel: '标签（逗号分隔，最多 12 个）',
    scopeLabel: '作用域',
    catPreference: '偏好',
    catFact: '事实',
    catDecision: '决策',
    editorCreate: '新建记忆',
    editorEdit: '编辑记忆',
    deleteTitle: '删除这条记忆？',
    deleteHint: '删除后不可恢复。',
    saved: '已保存',
    deduplicated: '已有相同记忆，未重复写入',
    deleted: '已删除',
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
    categoryAll: '全部分类',
    pagePrev: '上一页',
    pageNext: '下一页',
    pageInfo: '第 {page} 页',
    copyId: '复制 id',
    copied: '已复制 id',
    copyFailed: '复制失败，请手动选择',
    createdAt: '创建于',
    updatedAt: '更新于',
    sourceLabel: '来源会话',
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
    title: 'Memory manager',
    subtitle: 'Cross-session long-term memory · global & workspace',
    searchPlaceholder: 'Search memories…',
    newMemory: 'New memory',
    scopeGlobal: 'Global',
    scopeWorkspace: 'Workspace',
    scopeAll: 'Global + current workspace',
    empty: 'No memories yet',
    emptyHint: 'Say “remember…” in chat, or create one here.',
    noResults: 'No matching memories',
    edit: 'Edit',
    del: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
    contentLabel: 'Content (one fact)',
    categoryLabel: 'Category',
    tagsLabel: 'Tags (comma-separated, max 12)',
    scopeLabel: 'Scope',
    catPreference: 'Preference',
    catFact: 'Fact',
    catDecision: 'Decision',
    editorCreate: 'New memory',
    editorEdit: 'Edit memory',
    deleteTitle: 'Delete this memory?',
    deleteHint: 'This cannot be undone.',
    saved: 'Saved',
    deduplicated: 'Identical memory exists; nothing added',
    deleted: 'Deleted',
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
    categoryAll: 'All categories',
    pagePrev: 'Previous',
    pageNext: 'Next',
    pageInfo: 'Page {page}',
    copyId: 'Copy id',
    copied: 'Id copied',
    copyFailed: 'Copy failed; select manually',
    createdAt: 'Created',
    updatedAt: 'Updated',
    sourceLabel: 'Source session',
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
    '.dm_page{height:100%;overflow-y:auto;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);padding:calc(var(--dsh-frame-top-clearance,48px) + 16px) 24px 32px;font-size:13px;line-height:1.5;}',
    '.dm_header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px;}',
    '.dm_title{margin:0;font-size:18px;font-weight:600;}',
    '.dm_subtitle{color:var(--dsw-alias-label-secondary,#666);margin-top:4px;}',
    '.dm_toolbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;}',
    '.dm_select,.dm_search,.dm_input,.dm_textarea{background:var(--dsw-alias-bg-layer-1,#f7f7f7);border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.12));border-radius:8px;color:inherit;padding:7px 10px;font:inherit;box-sizing:border-box;}',
    '.dm_search{flex:1;min-width:180px;}',
    '.dm_textarea{width:100%;min-height:110px;resize:vertical;}',
    '.dm_input{width:100%;}',
    '.dm_select:focus,.dm_search:focus,.dm_input:focus,.dm_textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary,#2f6bff);outline-offset:1px;}',
    '.dm_btn{border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.12));background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#222);border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;}',
    '.dm_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));}',
    '.dm_btn:disabled{opacity:0.5;cursor:default;}',
    '.dm_btn_primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary,#2f6bff));border-color:transparent;color:var(--dsw-alias-label-on-color,#fff);}',
    '.dm_btn_primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-state-business-primary,#2f6bff));opacity:0.92;}',
    '.dm_btn_danger{color:var(--dsw-alias-state-error-primary,#d4380d);}',
    '.dm_section_title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin:16px 0 8px;}',
    '.dm_row{display:flex;gap:12px;justify-content:space-between;border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.08));border-radius:10px;padding:12px 14px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,#fafafa);}',
    '.dm_row_main{min-width:0;flex:1;}',
    '.dm_row_top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.dm_badge{font-size:11px;padding:1px 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,0.12));color:var(--dsw-alias-label-secondary,#555);}',
    '.dm_badge_preference{color:var(--dsw-alias-state-business-primary,#2f6bff);border-color:currentColor;}',
    '.dm_badge_decision{color:var(--dsw-alias-state-success-primary,#2da44e);border-color:currentColor;}',
    '.dm_scope_chip{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);}',
    '.dm_time{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-left:auto;}',
    '.dm_content{white-space:pre-wrap;word-break:break-word;margin:6px 0;line-height:1.55;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;}',
    '.dm_content_open{display:block;-webkit-line-clamp:unset;cursor:default;}',
    '.dm_details{font-size:11px;color:var(--dsw-alias-label-secondary,#666);margin:6px 0;display:flex;flex-direction:column;gap:2px;}',
    '.dm_btn_mini{padding:2px 8px;font-size:11px;align-self:flex-start;margin-top:4px;}',
    '.dm_meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;word-break:break-all;}',
    '.dm_row_actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0;}',
    '.dm_empty{border:0.5px dashed var(--dsw-alias-border-l2,rgba(0,0,0,0.15));border-radius:10px;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary,#666);}',
    '.dm_empty_hint{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999);}',
    '.dm_overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,0.35));display:flex;align-items:center;justify-content:center;z-index:1000;}',
    '.dm_dialog{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:12px;padding:20px;width:min(560px,calc(100vw - 48px));max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.18);box-sizing:border-box;}',
    '.dm_dialog_title{margin:0 0 14px;font-size:15px;font-weight:600;}',
    '.dm_field{margin-bottom:12px;}',
    '.dm_label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:4px;}',
    '.dm_dialog_footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}',
    '.dm_delete_preview{border:0.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.08));border-radius:8px;padding:10px;margin:10px 0;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1,#fafafa);max-height:40vh;overflow-y:auto;}',
    '.dm_hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;}',
    '.dm_pager{display:flex;gap:10px;align-items:center;justify-content:center;margin:14px 0 4px;}',
    '.dm_toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-toast-bg,var(--dsw-alias-state-business-primary,#2f6bff));color:var(--dsw-alias-toast-label,#fff);padding:8px 16px;border-radius:8px;z-index:1100;font-size:13px;}',
    '.dm_toast_error{background:var(--dsw-alias-state-error-primary,#d4380d);color:var(--dsw-alias-label-on-color,#fff);}',
    '.dm_nav_icon{display:block;}',
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

      function formatTime(iso) {
        if (!iso) return ''
        var date = new Date(iso)
        if (isNaN(date.getTime())) return String(iso)
        var lang = (document.documentElement && document.documentElement.lang) || ''
        return date.toLocaleString(lang.indexOf('zh') === 0 ? 'zh-CN' : 'en-US')
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

      function Badge(props) {
        var category = props.category
        var label = category === 'preference' ? props.t('catPreference') : category === 'decision' ? props.t('catDecision') : props.t('catFact')
        return h('span', { className: 'dm_badge dm_badge_' + category }, label)
      }

      function EntryRow(props) {
        var entry = props.entry
        var t = props.t
        var expandedState = useState(false)
        var expanded = expandedState[0]; var setExpanded = expandedState[1]
        function toggle() { setExpanded(!expanded) }
        function copyId() {
          copyText(entry.id).then(function () { props.onToast(t('copied'), 'ok') }, function () { props.onToast(t('copyFailed'), 'error') })
        }
        return h('div', { className: 'dm_row' },
          h('div', { className: 'dm_row_main' },
            h('div', { className: 'dm_row_top' },
              h(Badge, { category: entry.category, t: t }),
              h('span', { className: 'dm_scope_chip' }, entry.scope === 'global' ? t('scopeGlobal') : t('scopeWorkspace')),
              h('span', { className: 'dm_time' }, formatTime(entry.updated))),
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
                  return h('div', { key: row.key }, t(row.key) + ': ' + (row.key === 'sourceLabel' ? row.value : formatTime(row.value)))
                }),
                h('button', { className: 'dm_btn dm_btn_mini', onClick: copyId }, t('copyId')))
              : null,
            h('div', { className: 'dm_meta' },
              (entry.tags && entry.tags.length ? entry.tags.join(' · ') + '  —  ' : '') + entry.id)),
          h('div', { className: 'dm_row_actions' },
            h('button', { className: 'dm_btn', onClick: function () { props.onEdit(entry) } }, t('edit')),
            h('button', { className: 'dm_btn dm_btn_danger', onClick: function () { props.onDelete(entry) } }, t('del'))))
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
        return h(Modal, { title: isCreate ? t('editorCreate') : t('editorEdit'), onClose: props.onClose, busy: props.busy },
          h('h2', { className: 'dm_dialog_title' }, isCreate ? t('editorCreate') : t('editorEdit')),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-content' }, t('contentLabel')),
            h('textarea', { id: 'dm-content', className: 'dm_textarea', disabled: props.busy, value: draft.content, onChange: function (e) { field('content', e.target.value) } })),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-category' }, t('categoryLabel')),
            h('select', { id: 'dm-category', className: 'dm_select', disabled: props.busy, value: draft.category, onChange: function (e) { field('category', e.target.value) } },
              h('option', { value: 'fact' }, t('catFact')),
              h('option', { value: 'preference' }, t('catPreference')),
              h('option', { value: 'decision' }, t('catDecision')))),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-scope' }, t('scopeLabel')),
            h('select', { id: 'dm-scope', className: 'dm_select', disabled: props.busy, value: draft.scope, onChange: function (e) { field('scope', e.target.value) } },
              h('option', { value: 'global' }, t('scopeGlobal')),
              workspaceTarget ? h('option', { value: 'workspace' }, t('scopeWorkspace') + ' — ' + workspaceTarget) : null,
              !workspaceTarget && draft.scope === 'workspace' ? h('option', { value: 'workspace', disabled: true }, t('scopeWorkspace')) : null),
            draft.scope === 'workspace' && workspaceTarget
              ? h('div', { className: 'dm_hint', style: { marginTop: 4 } }, t('workspaceTarget') + ': ' + workspaceTarget)
              : null),
          h('div', { className: 'dm_field' },
            h('label', { className: 'dm_label', htmlFor: 'dm-tags' }, t('tagsLabel')),
            h('input', { id: 'dm-tags', className: 'dm_input', disabled: props.busy, value: draft.tags, onChange: function (e) { field('tags', e.target.value) } })),
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_primary', onClick: props.onSave, disabled: props.busy }, t('save'))))
      }

      function ConfirmModal(props) {
        var t = props.t
        var entry = props.entry
        return h(Modal, { title: t('deleteTitle'), onClose: props.onClose, busy: props.busy },
          h('h2', { className: 'dm_dialog_title' }, t('deleteTitle')),
          h('div', { className: 'dm_delete_preview' }, entry.content),
          h('div', { className: 'dm_hint' }, t('deleteHint')),
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_danger', onClick: props.onConfirm, disabled: props.busy }, t('del'))))
      }

      function ImportModal(props) {
        var t = props.t
        var summary = importSummary(props.plan)
        var rejected = (props.plan && props.plan.rejected) || []
        return h(Modal, { title: t('importTitle'), onClose: props.onClose, busy: props.busy },
          h('h2', { className: 'dm_dialog_title' }, t('importTitle')),
          h('div', { className: 'dm_delete_preview' },
            h('div', null, t('importNew') + ': ' + summary.imported),
            h('div', null, t('importDup') + ': ' + summary.deduplicated),
            h('div', null, t('importRej') + ': ' + summary.rejected),
            rejected.length > 0
              ? h('div', { className: 'dm_hint', style: { marginTop: 8 } },
                t('importRejHint'),
                h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                  rejected.slice(0, 5).map(function (r, i) {
                    return h('li', { key: i }, '#' + (r.index + 1) + ' ' + String(r.reason || r.code || ''))
                  }),
                  rejected.length > 5 ? h('li', { key: 'more' }, '… +' + (rejected.length - 5)) : null))
              : null,
            summary.imported === 0 && summary.deduplicated > 0
              ? h('div', { className: 'dm_hint', style: { marginTop: 8 } }, t('importAllDup'))
              : null),
          h('div', { className: 'dm_dialog_footer' },
            h('button', { className: 'dm_btn', onClick: props.onClose, disabled: props.busy }, t('cancel')),
            h('button', { className: 'dm_btn dm_btn_primary', onClick: props.onConfirm, disabled: props.busy || summary.imported === 0 }, t('importConfirm'))))
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

        var phaseState = useState('loading')
        var phase = phaseState[0]; var setPhase = phaseState[1]
        var entriesState = useState([])
        var entries = entriesState[0]; var setEntries = entriesState[1]
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
        var editorState = useState(null)
        var editor = editorState[0]; var setEditor = editorState[1]
        var confirmState = useState(null)
        var confirm = confirmState[0]; var setConfirm = confirmState[1]
        var importState = useState(null)
        var importPlan = importState[0]; var setImportPlan = importState[1]
        var fileInputRef = useRef(null)
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

        // 列表请求：seq 守卫防止旧响应覆盖新结果；「全部」＝全局＋当前工作区。
        // 多取一条（PAGE_SIZE+1）探测下一页；过滤/切换作用域时回到第一页。
        var refreshEntries = useCallback(function () {
          var seq = ++seqRef.current
          var params = { query: query, category: categoryFilter, limit: PAGE_SIZE + 1, offset: page * PAGE_SIZE }
          if (selection === 'global') params.scope = 'global'
          else if (selection === 'all') { params.scope = 'all'; params.workspace = currentCwd }
          else { params.scope = 'workspace'; params.workspace = selection }
          return api.entries(params).then(function (doc) {
            if (seq !== seqRef.current) return
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

        // toast 自动消失
        useEffect(function () {
          if (!toast) return undefined
          var timer = setTimeout(function () { setToast(null) }, 2600)
          return function () { clearTimeout(timer) }
        }, [toast])

        var options = [{ value: 'all', kind: 'all' }].concat(workspaceOptions({ workspaces: workspaces, currentCwd: currentCwd }))
        var unknownWorkspaces = workspaces.filter(function (w) { return !w || typeof w.cwd !== 'string' || w.cwd === '' })
        var workspaceTarget = selection !== 'all' && selection !== 'global' ? selection : currentCwd

        function changeQuery(value) { setQuery(value); setPage(0) }
        function changeSelection(value) { setSelection(value); setPage(0) }
        function changeCategory(value) { setCategoryFilter(value); setPage(0) }

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
          setConfirm(entry)
        }

        function writeFailure(err) {
          if (err.status === 403) {
            return api.status().then(function () {
              setToast({ kind: 'error', text: t('errRefreshed') })
            }).catch(function () {
              setToast({ kind: 'error', text: errorText(err, t) })
            })
          }
          setToast({ kind: 'error', text: errorText(err, t) })
          return undefined
        }

        function handleSave() {
          if (busy) return
          var check = validateDraft(editor)
          if (!check.ok) {
            setToast({ kind: 'error', text: t(check.error === 'empty-content' ? 'errEmptyContent' : 'errBadCategory') })
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
            setToast({ kind: 'ok', text: dedup ? t('deduplicated') : t('saved') })
            // 新建条目按更新时间排在最前：回到第一页让它可见。
            if (started.mode === 'create') setPage(0)
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function handleDelete() {
          if (busy) return
          var started = confirm
          setBusy(true)
          api.forget({ id: confirm.id, workspace: workspaceTarget }).then(function () {
            if (confirmRef.current === started) setConfirm(null)
            setToast({ kind: 'ok', text: t('deleted') })
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
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
            setToast({ kind: 'ok', text: t('exportDone') })
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function handleImportFile(e) {
          var file = e.target.files && e.target.files[0]
          e.target.value = ''
          if (!file || busy) return
          if (file.size > 1024 * 1024) {
            setToast({ kind: 'error', text: t('errBodyTooLarge') })
            return
          }
          file.text().then(function (text) {
            var doc
            try { doc = JSON.parse(text) } catch { setToast({ kind: 'error', text: t('errInvalidJson') }); return undefined }
            if (!validateImportDoc(doc).ok) {
              setToast({ kind: 'error', text: t('errImportDoc') })
              return undefined
            }
            setBusy(true)
            return api.import({ entries: doc.entries, dryRun: true }).then(function (payload) {
              setImportPlan({ entries: doc.entries, plan: payload.result })
            }).catch(writeFailure).then(function () { setBusy(false) })
          }).catch(function () {
            setToast({ kind: 'error', text: t('errInvalidJson') })
          })
        }

        function confirmImport() {
          if (busy || !importPlan) return
          setBusy(true)
          api.import({ entries: importPlan.entries }).then(function (payload) {
            setImportPlan(null)
            var summary = importSummary(payload.result)
            setToast({ kind: 'ok', text: t('imported') + ' · ' + t('importNew') + ' ' + summary.imported + ' / ' + t('importDup') + ' ' + summary.deduplicated + ' / ' + t('importRej') + ' ' + summary.rejected })
            setPage(0)
            return refreshRef.current()
          }).then(function () {
            return refreshWorkspaces()
          }).catch(writeFailure).then(function () { setBusy(false) })
        }

        function renderList() {
          var pager = (page > 0 || hasMore) ? h('div', { className: 'dm_pager' },
            h('button', { className: 'dm_btn', disabled: page === 0 || busy, onClick: function () { setPage(page - 1) } }, t('pagePrev')),
            h('span', { className: 'dm_hint' }, t('pageInfo').replace('{page}', String(page + 1))),
            h('button', { className: 'dm_btn', disabled: !hasMore || busy, onClick: function () { setPage(page + 1) } }, t('pageNext'))) : null
          if (listError) {
            return h('div', { className: 'dm_empty' },
              h('div', null, t('listError') + ': ' + listError),
              h('button', { className: 'dm_btn', style: { marginTop: 10 }, onClick: function () { refreshEntries() } }, t('retry')))
          }
          if (entries.length === 0) {
            return h('div', null,
              h('div', { className: 'dm_empty' },
                h('div', null, query || categoryFilter ? t('noResults') : t('empty')),
                !query && !categoryFilter && page === 0 ? h('div', { className: 'dm_empty_hint' }, t('emptyHint')) : null),
              pager)
          }
          function rows(list) {
            return list.map(function (entry) {
              return h(EntryRow, { key: entry.id, entry: entry, t: t, onEdit: openEdit, onDelete: openDelete, onToast: function (text, kind) { setToast({ kind: kind, text: text }) } })
            })
          }
          if (selection !== 'all') return h('div', null, rows(entries), pager)
          var groups = groupEntries(entries)
          return h('div', null,
            groups.global.length ? h('div', { className: 'dm_section_title' }, t('scopeGlobal') + ' · ' + groups.global.length + ' ' + t('entriesUnit')) : null,
            rows(groups.global),
            groups.workspace.length ? h('div', { className: 'dm_section_title' }, t('scopeWorkspace') + ' · ' + groups.workspace.length + ' ' + t('entriesUnit')) : null,
            rows(groups.workspace),
            pager)
        }

        return h('div', { className: 'dm_page' },
          h('div', { className: 'dm_header' },
            h('div', null,
              h('h1', { className: 'dm_title' }, t('title')),
              h('div', { className: 'dm_subtitle' }, t('subtitle'))),
            h('button', { className: 'dm_btn dm_btn_primary', onClick: openCreate }, '+ ' + t('newMemory'))),
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
            h('select', { className: 'dm_select', 'aria-label': t('categoryLabel'), value: categoryFilter, onChange: function (e) { changeCategory(e.target.value) } },
              h('option', { value: '' }, t('categoryAll')),
              h('option', { value: 'preference' }, t('catPreference')),
              h('option', { value: 'fact' }, t('catFact')),
              h('option', { value: 'decision' }, t('catDecision'))),
            h('input', { className: 'dm_search', type: 'search', 'aria-label': t('searchPlaceholder'), placeholder: t('searchPlaceholder'), value: query, onChange: function (e) { changeQuery(e.target.value) } }),
            h('button', { className: 'dm_btn', onClick: handleExport, disabled: busy || phase !== 'ready' }, t('export')),
            h('button', { className: 'dm_btn', onClick: function () { if (fileInputRef.current) fileInputRef.current.click() }, disabled: busy || phase !== 'ready' }, t('import')),
            h('input', { ref: fileInputRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: handleImportFile })),
          unknownWorkspaces.length > 0 ? h('div', { className: 'dm_hint', style: { margin: '0 0 12px' } }, t('unknownWorkspaceHint')) : null,
          phase === 'loading' ? h('div', { className: 'dm_empty' }, t('loading'))
            : phase === 'error' ? h('div', { className: 'dm_empty' },
              h('div', null, t('loadError') + ': ' + errorTextState),
              h('button', { className: 'dm_btn', style: { marginTop: 10 }, onClick: function () { loadInitial() } }, t('retry')))
              : renderList(),
          editor ? h(EditorModal, { draft: editor, setDraft: setEditor, t: t, workspaceTarget: workspaceTarget, busy: busy, onSave: handleSave, onClose: function () { if (!busy) setEditor(null) } }) : null,
          confirm ? h(ConfirmModal, { entry: confirm, t: t, busy: busy, onConfirm: handleDelete, onClose: function () { if (!busy) setConfirm(null) } }) : null,
          importPlan ? h(ImportModal, { plan: importPlan.plan, t: t, busy: busy, onConfirm: confirmImport, onClose: function () { if (!busy) setImportPlan(null) } }) : null,
          toast ? h('div', { className: 'dm_toast' + (toast.kind === 'error' ? ' dm_toast_error' : ''), role: toast.kind === 'error' ? 'alert' : 'status' }, toast.text) : null)
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
