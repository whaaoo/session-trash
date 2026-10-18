/**
 * Browser half of the Session trash plugin.
 *
 * Three rows in a Session row's "..." menu (move to trash, delete
 * permanently, open the trash), one frame-wide overlay that owns the
 * confirmations, the trash manager, and the result notices, and the exact Host
 * route calls that perform each operation.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** The design system's own menu row: same geometry, icon box and danger tone as the shipped rows. */
    const MenuItemButton = primitives.MenuItemButton
    /** The design system's trash glyph, the same one the workspace menu uses for a destructive row. */
    const IconTrash = primitives.IconTrashOutlineRegular

    const ROUTE = '/api/dsh-session-trash'
    const NS = 'sessionTrash'

    /**
     * Resolve the route under whatever mount the page is served from.
     * @returns {string} request path.
     */
    function routePath() {
      const relative = ROUTE.replace(/^\/+/, '')
      if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return `/${relative}`
      try {
        return new URL(relative, document.baseURI).pathname
      } catch {
        return `/${relative}`
      }
    }

    const ZH = {
      'menu.move': '移到回收站',
      'menu.delete': '永久删除',
      'menu.trash': '回收站…',
      'confirm.title': '永久删除会话？',
      'confirm.body': '会话「{title}」的日志将被永久删除，无法恢复。',
      'confirm.cancel': '取消',
      'confirm.ok': '永久删除',
      'confirm.purgeTitle': '彻底删除该会话？',
      'confirm.purgeBody': '回收站中「{title}」的副本将被永久删除，无法恢复。',
      'confirm.purgeOk': '彻底删除',
      'confirm.emptyTitle': '清空回收站？',
      'confirm.emptyBody': '回收站中的 {count} 个会话副本将被永久删除，无法恢复。',
      'confirm.emptyOk': '清空回收站',
      'notice.trashed': '已将「{title}」移到回收站',
      'notice.deleted': '已永久删除「{title}」',
      'notice.restored': '已还原「{title}」',
      'notice.purged': '已彻底删除「{title}」',
      'notice.emptied': '已清空回收站，共 {count} 个会话',
      'notice.undo': '撤销',
      'trash.title': '回收站',
      'trash.subtitle': '共 {count} 个会话 · {size}',
      'trash.refresh': '刷新',
      'trash.empty': '清空回收站',
      'trash.close': '关闭',
      'trash.restore': '还原',
      'trash.purge': '彻底删除',
      'trash.loading': '正在读取回收站…',
      'trash.emptyState': '回收站是空的。移入回收站的会话会在这里列出，可还原或彻底删除。',
      'trash.broken': '记录缺失，仅可彻底删除',
      'trash.loadFailed': '读取回收站失败：{message}',
      'unnamed': '未命名会话',
      'error.notFound': '没有找到该会话的存储文件，可能已经被删除。',
      'error.invalid': '请求无效，已拒绝执行。',
      'error.busy': '该操作正在进行中，请稍候。',
      'error.locked': '无法处理会话文件：文件仍被占用（会话可能还在运行），请稍后重试。',
      'error.exists': '目标位置已存在同名会话，请先处理现有会话再还原。',
      'error.broken': '该回收站记录已损坏，无法还原，只能彻底删除。',
      'error.registry': '文件已处理，但工作区记录更新失败：{message}',
      'error.unavailable': '当前宿主没有可用的连接服务，无法执行。',
      'error.failed': '操作失败：{message}',
    }

    const EN = {
      'menu.move': 'Move to Trash',
      'menu.delete': 'Delete Permanently',
      'menu.trash': 'Trash…',
      'confirm.title': 'Delete this session permanently?',
      'confirm.body': 'The stored log of "{title}" will be deleted permanently and cannot be recovered.',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Delete Permanently',
      'confirm.purgeTitle': 'Purge this session?',
      'confirm.purgeBody': 'The trash copy of "{title}" will be deleted permanently and cannot be recovered.',
      'confirm.purgeOk': 'Purge',
      'confirm.emptyTitle': 'Empty the trash?',
      'confirm.emptyBody': '{count} trashed sessions will be deleted permanently and cannot be recovered.',
      'confirm.emptyOk': 'Empty Trash',
      'notice.trashed': 'Moved "{title}" to the trash',
      'notice.deleted': 'Permanently deleted "{title}"',
      'notice.restored': 'Restored "{title}"',
      'notice.purged': 'Purged "{title}" from the trash',
      'notice.emptied': 'Emptied the trash ({count} sessions)',
      'notice.undo': 'Undo',
      'trash.title': 'Trash',
      'trash.subtitle': '{count} sessions · {size}',
      'trash.refresh': 'Refresh',
      'trash.empty': 'Empty Trash',
      'trash.close': 'Close',
      'trash.restore': 'Restore',
      'trash.purge': 'Purge',
      'trash.loading': 'Loading the trash…',
      'trash.emptyState': 'The trash is empty. Sessions you move to the trash appear here and can be restored or purged.',
      'trash.broken': 'record missing, purge only',
      'trash.loadFailed': 'Could not load the trash: {message}',
      'unnamed': 'Untitled session',
      'error.notFound': 'No stored log was found for this session; it may already be deleted.',
      'error.invalid': 'The request was invalid, so it was refused.',
      'error.busy': 'This operation is already in progress. Please wait.',
      'error.locked': 'Could not handle the session files: they are still held open (the session may still be running). Please try again.',
      'error.exists': 'A live session with the same id already exists; deal with it before restoring.',
      'error.broken': 'This trash record is broken and cannot be restored; purge it instead.',
      'error.registry': 'The files were handled, but the workspace record could not be updated: {message}',
      'error.unavailable': 'This Host has no usable connection service, so nothing can be done.',
      'error.failed': 'Operation failed: {message}',
    }

    const CSS = `
.dsh-st-backdrop{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.32);pointer-events:auto;z-index:80}
.dsh-st-dialog{width:min(420px,calc(100vw - 48px));display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 44px rgba(0,0,0,.28)}
.dsh-st-dialog--wide{width:min(560px,calc(100vw - 48px))}
.dsh-st-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.dsh-st-body{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-st-subtitle{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-st-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.dsh-st-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-st-btn:hover:not(.dsh-st-btn--danger){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-st-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-st-btn:disabled{opacity:.55;cursor:default}
.dsh-st-btn--danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.dsh-st-btn--danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 86%,#000)}
.dsh-st-btn--danger:active{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 74%,#000)}
.dsh-st-btn--small{height:26px;padding:0 10px;font-size:12px}
.dsh-st-list{display:flex;flex-direction:column;gap:8px;max-height:min(46vh,380px);overflow:auto;margin:4px 0}
.dsh-st-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsh-st-row__main{flex:1 1 auto;min-width:0}
.dsh-st-row__title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-st-row__meta{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-st-row__ops{display:flex;gap:6px;flex:0 0 auto}
.dsh-st-notice{position:fixed;left:50%;bottom:28px;display:flex;gap:8px;align-items:flex-start;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.22);transform:translateX(-50%);pointer-events:auto;cursor:pointer;overflow-wrap:anywhere}
.dsh-st-notice--error{border-color:var(--dsw-alias-state-error-primary)}
.dsh-st-dot{flex:0 0 auto;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsh-st-notice--error .dsh-st-dot{background:var(--dsw-alias-state-error-primary)}
.dsh-st-notice__action{flex:0 0 auto;margin-left:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;padding:2px 10px;cursor:pointer}
`

    /** @returns {string} the page language tag, lowercased. */
    function activeLanguage() {
      if (
        typeof document === 'object' &&
        document !== null &&
        document.documentElement !== null &&
        typeof document.documentElement.lang === 'string' &&
        document.documentElement.lang !== ''
      ) {
        return document.documentElement.lang.toLowerCase()
      }
      if (typeof navigator === 'object' && navigator !== null) return String(navigator.language || '').toLowerCase()
      return ''
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template dictionary text.
     * @param {Record<string, unknown> | undefined} params values.
     * @returns {string} text.
     */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }

    /**
     * This package's own dictionary for the page language. It is the guaranteed
     * fallback, so a missing locale binding can never print a raw key.
     * @param {string} key translation key.
     * @param {Record<string, unknown>} [params] values.
     * @returns {string} text.
     */
    function localText(key, params) {
      const dictionary = activeLanguage().startsWith('zh') ? ZH : EN
      return interpolate(Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key, params)
    }

    /**
     * Translate through the Client locale service when it answers for this
     * namespace, otherwise through the packaged dictionary. A binding that
     * returns the key itself (namespace missing for the active locale) falls
     * through to the packaged dictionary as well.
     * @returns {(key: string, params?: Record<string, unknown>) => string} translator.
     */
    function translator() {
      const locale = pluginCtx === undefined || pluginCtx === null ? undefined : pluginCtx.get('locale')
      if (locale === undefined || locale === null || typeof locale.bind !== 'function') return localText
      let bound
      try {
        bound = locale.bind(NS)
      } catch {
        return localText
      }
      if (typeof bound !== 'function') return localText
      return (key, params) => {
        let text
        try {
          text = params === undefined ? bound(key) : bound(key, params)
        } catch {
          text = undefined
        }
        if (typeof text !== 'string' || text === '' || text === key) return localText(key, params)
        return params === undefined ? text : interpolate(text, params)
      }
    }

    /** @param {object} props row props. @returns {unknown} the menu's own state pair. */
    function readMenuState(props) {
      if (props === null || typeof props !== 'object') return undefined
      if (typeof props.useMenuOpenState !== 'function') return undefined
      try {
        return props.useMenuOpenState()
      } catch {
        return undefined
      }
    }

    /**
     * Close the row menu through the slot-level hook.
     * @param {unknown} menuState the pair returned by `useMenuOpenState`.
     * @returns {void}
     */
    function dismissMenu(menuState) {
      if (Array.isArray(menuState) && typeof menuState[1] === 'function') {
        menuState[1](false)
        return
      }
      if (menuState !== null && typeof menuState === 'object' && typeof menuState.close === 'function') menuState.close()
    }

    // ── frame-wide state: confirm + notice + trash manager ───────────────────
    let snapshot = {
      confirm: null,
      notice: null,
      trash: { open: false, loading: false, error: null, entries: [], count: 0, sizeBytes: 0 },
    }
    const listeners = new Set()
    let noticeTimer

    /** @param {Partial<typeof snapshot>} patch next values. */
    function publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // One listener must not break the others.
        }
      }
    }

    /** @returns {typeof snapshot} current values. */
    function useSnapshot() {
      const [value, setValue] = React.useState(snapshot)
      React.useEffect(() => {
        const listener = () => setValue(snapshot)
        listeners.add(listener)
        setValue(snapshot)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return value
    }

    /**
     * Show one transient notice; `action` renders an Undo-style button.
     * @param {{ kind: 'success' | 'error', text: string, action?: { label: string, onClick: () => void } }} notice the notice.
     * @returns {void}
     */
    function showNotice(notice) {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer)
      publish({ notice })
      noticeTimer = setTimeout(
        () => {
          noticeTimer = undefined
          if (snapshot.notice === notice) publish({ notice: null })
        },
        notice.kind === 'error' ? 9000 : 7000,
      )
    }

    /** @returns {void} dismiss the current notice. */
    function dismissNotice() {
      if (noticeTimer !== undefined) {
        clearTimeout(noticeTimer)
        noticeTimer = undefined
      }
      publish({ notice: null })
    }

    /**
     * @param {{ kind: 'delete' | 'purge' | 'empty', sessionId?: string, trashId?: string, displayTitle?: string, count?: number }} request the row asking for confirmation.
     */
    function openConfirm(request) {
      publish({ confirm: request })
    }

    /** @returns {void} close the confirmation without acting. */
    function dismissConfirm() {
      publish({ confirm: null })
    }

    /** @returns {void} open the trash manager and start loading. */
    function openTrash() {
      publish({ trash: { ...snapshot.trash, open: true, loading: true, error: null } })
      void refreshTrash()
    }

    /** @returns {void} close the trash manager. */
    function closeTrash() {
      publish({ trash: { ...snapshot.trash, open: false } })
    }

    /**
     * Reload the trash listing into the frame-wide state.
     * @returns {Promise<void>} resolution after the state is updated.
     */
    async function refreshTrash() {
      publish({ trash: { ...snapshot.trash, open: true, loading: true, error: null } })
      const t = translator()
      try {
        const value = await callHost({ action: 'list' })
        const entries = Array.isArray(value?.entries) ? value.entries : []
        publish({
          trash: {
            open: true,
            loading: false,
            error: null,
            entries,
            count: typeof value?.count === 'number' ? value.count : entries.length,
            sizeBytes: typeof value?.sizeBytes === 'number' ? value.sizeBytes : 0,
          },
        })
      } catch (error) {
        publish({ trash: { ...snapshot.trash, open: true, loading: false, error: describeFailure(t, error) } })
      }
    }

    // ── host calls ───────────────────────────────────────────────────────────
    let pluginCtx

    /**
     * Turn one parsed envelope into a value or a typed failure.
     * @param {unknown} body parsed response.
     * @returns {unknown} the Host value.
     */
    function unwrapResult(body) {
      if (body !== null && typeof body === 'object' && body.ok === true) return body.value
      const failure = body !== null && typeof body === 'object' ? body.error : undefined
      const error = new Error(failure !== undefined && typeof failure.message === 'string' ? failure.message : 'host call failed')
      error.code = failure !== undefined && typeof failure.code === 'string' ? failure.code : 'failed'
      error.details = failure !== undefined && typeof failure.details === 'object' && failure.details !== null ? failure.details : {}
      throw error
    }

    /**
     * Post one request to this package's Host route.
     * @param {Record<string, unknown>} payload JSON request body.
     * @returns {Promise<unknown>} the Host value.
     */
    async function callHost(payload) {
      let response
      try {
        response = await fetch(routePath(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw Object.assign(new Error(message), { code: 'unavailable' })
      }
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'unavailable' })
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw Object.assign(new Error('response body is not JSON'), { code: 'failed' })
      }
      return unwrapResult(body)
    }

    /** @param {unknown} error a thrown host failure. @returns {string} a readable message. */
    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message
      return String(error)
    }

    /**
     * Map one host failure to localized copy.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @param {unknown} error the thrown failure.
     * @returns {string} user-facing text.
     */
    function describeFailure(t, error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      switch (code) {
        case 'not-found':
          return t('error.notFound')
        case 'invalid':
          return t('error.invalid')
        case 'busy':
          return t('error.busy')
        case 'locked':
          return t('error.locked')
        case 'exists':
          return t('error.exists')
        case 'broken':
          return t('error.broken')
        case 'registry-failed':
          return t('error.registry', { message: messageOf(error) })
        case 'unavailable':
          return t('error.unavailable')
        default:
          return t('error.failed', { message: messageOf(error) })
      }
    }

    /** @param {string} title a row title, possibly blank. @returns {string} display text. */
    function titleOf(t, title) {
      return typeof title === 'string' && title.trim() !== '' ? title : t('unnamed')
    }

    /**
     * @param {number} sizeBytes recursive size.
     * @returns {string} human text like `1.2 MB`.
     */
    function formatSize(sizeBytes) {
      const size = Number(sizeBytes)
      if (!Number.isFinite(size) || size < 0) return '—'
      if (size < 1024) return `${size} B`
      const units = ['KB', 'MB', 'GB']
      let value = size / 1024
      let unit = units[0]
      for (const next of units) {
        unit = next
        if (value < 1024 || next === 'GB') break
        value /= 1024
      }
      return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`
    }

    /**
     * @param {string} iso ISO time.
     * @returns {string} local text, falling back to the raw value.
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = new Date(iso)
      if (Number.isNaN(time.getTime())) return iso
      try {
        return time.toLocaleString()
      } catch {
        return iso
      }
    }

    /**
     * Operations already in flight, keyed per target (`delete:<id>`,
     * `restore:<id>`, …) so acting on one session never blocks another.
     */
    const pending = new Set()

    /**
     * @param {string} key operation key.
     * @returns {boolean} whether the key was free (and is now claimed).
     */
    function claimKey(key) {
      if (pending.has(key)) return false
      pending.add(key)
      return true
    }

    /** @param {string} key operation key. */
    function releaseKey(key) {
      pending.delete(key)
    }

    /**
     * Run one deletion and report its outcome in the frame-wide notice. A
     * trash move offers Undo, which restores the entry straight from trash.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @param {string} sessionId target Session.
     * @param {string} displayTitle row title.
     * @param {'trash' | 'permanent'} mode disposition.
     * @returns {Promise<void>} resolution after the notice is published.
     */
    async function runDelete(t, sessionId, displayTitle, mode) {
      const key = `delete:${sessionId}`
      if (!claimKey(key)) {
        showNotice({ kind: 'error', text: t('error.busy') })
        return
      }
      try {
        await callHost({ action: 'delete', sessionId, mode, displayTitle: typeof displayTitle === 'string' ? displayTitle : '' })
        const title = titleOf(t, displayTitle)
        if (mode === 'trash') {
          showNotice({
            kind: 'success',
            text: t('notice.trashed', { title }),
            action: {
              label: t('notice.undo'),
              onClick: () => {
                dismissNotice()
                void runRestore(translator(), { sessionId, displayTitle })
              },
            },
          })
        } else {
          showNotice({ kind: 'success', text: t('notice.deleted', { title }) })
        }
        if (snapshot.trash.open) void refreshTrash()
      } catch (error) {
        showNotice({ kind: 'error', text: describeFailure(t, error) })
      } finally {
        releaseKey(key)
      }
    }

    /**
     * Restore one trash entry, then refresh the manager and the notice.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @param {{ trashId?: string, sessionId?: string, displayTitle?: string }} target entry.
     * @returns {Promise<void>} resolution after the notice is published.
     */
    async function runRestore(t, target) {
      const id = target.trashId || target.sessionId || ''
      const key = `restore:${id}`
      if (!claimKey(key)) {
        showNotice({ kind: 'error', text: t('error.busy') })
        return
      }
      try {
        await callHost({ action: 'restore', trashId: target.trashId, sessionId: target.sessionId })
        showNotice({ kind: 'success', text: t('notice.restored', { title: titleOf(t, target.displayTitle) }) })
        await refreshTrash()
      } catch (error) {
        showNotice({ kind: 'error', text: describeFailure(t, error) })
      } finally {
        releaseKey(key)
      }
    }

    /**
     * Purge one trash entry for good.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @param {{ trashId?: string, sessionId?: string, displayTitle?: string }} target entry.
     * @returns {Promise<void>} resolution after the notice is published.
     */
    async function runPurge(t, target) {
      const id = target.trashId || target.sessionId || ''
      const key = `purge:${id}`
      if (!claimKey(key)) {
        showNotice({ kind: 'error', text: t('error.busy') })
        return
      }
      try {
        await callHost({ action: 'purge', trashId: target.trashId, sessionId: target.sessionId })
        showNotice({ kind: 'success', text: t('notice.purged', { title: titleOf(t, target.displayTitle) }) })
        await refreshTrash()
      } catch (error) {
        showNotice({ kind: 'error', text: describeFailure(t, error) })
      } finally {
        releaseKey(key)
      }
    }

    /**
     * Empty the whole trash.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @returns {Promise<void>} resolution after the notice is published.
     */
    async function runEmpty(t) {
      if (!claimKey('empty')) {
        showNotice({ kind: 'error', text: t('error.busy') })
        return
      }
      try {
        const value = await callHost({ action: 'empty' })
        const count = typeof value?.count === 'number' ? value.count : 0
        showNotice({ kind: 'success', text: t('notice.emptied', { count }) })
        await refreshTrash()
      } catch (error) {
        showNotice({ kind: 'error', text: describeFailure(t, error) })
      } finally {
        releaseKey('empty')
      }
    }

    // ── menu rows ────────────────────────────────────────────────────────────
    /**
     * "Move to Trash" row.
     * @param {object} props slot props.
     * @returns {import('react').ReactElement} the row.
     */
    function MoveToTrashRow(props) {
      const t = translator()
      const menuState = readMenuState(props)
      return h(
        MenuItemButton,
        {
          separatorBefore: true,
          icon: h(IconTrash, { size: 14 }),
          onSelect: () => {
            dismissMenu(menuState)
            if (pluginCtx === undefined) return
            void runDelete(t, props.sessionId, props.displayTitle, 'trash')
          },
        },
        t('menu.move'),
      )
    }

    /**
     * "Delete Permanently" row; opens the confirmation instead of acting.
     * @param {object} props slot props.
     * @returns {import('react').ReactElement} the row.
     */
    function DeleteForeverRow(props) {
      const t = translator()
      const menuState = readMenuState(props)
      return h(
        MenuItemButton,
        {
          danger: true,
          icon: h(IconTrash, { size: 14 }),
          onSelect: () => {
            dismissMenu(menuState)
            openConfirm({
              kind: 'delete',
              sessionId: props.sessionId,
              displayTitle: typeof props.displayTitle === 'string' ? props.displayTitle : '',
            })
          },
        },
        t('menu.delete'),
      )
    }

    /**
     * "Trash…" row; opens the manager dialog.
     * @param {object} props slot props.
     * @returns {import('react').ReactElement} the row.
     */
    function TrashManagerRow(props) {
      const t = translator()
      const menuState = readMenuState(props)
      return h(
        MenuItemButton,
        {
          icon: h(IconTrash, { size: 14 }),
          onSelect: () => {
            dismissMenu(menuState)
            openTrash()
          },
        },
        t('menu.trash'),
      )
    }

    // ── frame-wide surface ───────────────────────────────────────────────────
    /**
     * One confirmation dialog for delete / purge / empty.
     * @param {{ request: { kind: string, sessionId?: string, trashId?: string, displayTitle?: string, count?: number }, t: Function }} props dialog props.
     * @returns {import('react').ReactElement} the dialog.
     */
    function ConfirmDialog(props) {
      const { request, t } = props
      const cancelRef = React.useRef(null)
      React.useEffect(() => {
        if (cancelRef.current !== null && typeof cancelRef.current.focus === 'function') cancelRef.current.focus()
      }, [])
      const kind = request.kind || 'delete'
      const title =
        kind === 'purge' ? t('confirm.purgeTitle') : kind === 'empty' ? t('confirm.emptyTitle') : t('confirm.title')
      const body =
        kind === 'purge'
          ? t('confirm.purgeBody', { title: titleOf(t, request.displayTitle) })
          : kind === 'empty'
            ? t('confirm.emptyBody', { count: request.count ?? snapshot.trash.count })
            : t('confirm.body', { title: titleOf(t, request.displayTitle) })
      const okLabel =
        kind === 'purge' ? t('confirm.purgeOk') : kind === 'empty' ? t('confirm.emptyOk') : t('confirm.ok')
      return h(
        'div',
        {
          className: 'dsh-st-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) dismissConfirm()
          },
        },
        h(
          'div',
          { className: 'dsh-st-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-st-dialog-title' },
          h('h2', { className: 'dsh-st-title', id: 'dsh-st-dialog-title' }, title),
          h('p', { className: 'dsh-st-body' }, body),
          h(
            'div',
            { className: 'dsh-st-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-st-btn', ref: cancelRef, onClick: dismissConfirm },
              t('confirm.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-st-btn dsh-st-btn--danger',
                onClick: () => {
                  const target = snapshot.confirm
                  dismissConfirm()
                  if (target === null || target === undefined || pluginCtx === undefined) return
                  const tt = translator()
                  if (target.kind === 'purge') void runPurge(tt, target)
                  else if (target.kind === 'empty') void runEmpty(tt)
                  else void runDelete(tt, target.sessionId, target.displayTitle, 'permanent')
                },
              },
              okLabel,
            ),
          ),
        ),
      )
    }

    /**
     * The trash manager dialog: list, restore, purge, refresh, empty.
     * @param {{ t: Function }} props dialog props.
     * @returns {import('react').ReactElement} the dialog.
     */
    function TrashDialog(props) {
      const { t } = props
      const trash = useSnapshot().trash
      const closeRef = React.useRef(null)
      React.useEffect(() => {
        if (closeRef.current !== null && typeof closeRef.current.focus === 'function') closeRef.current.focus()
      }, [])
      return h(
        'div',
        {
          className: 'dsh-st-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeTrash()
          },
        },
        h(
          'div',
          {
            className: 'dsh-st-dialog dsh-st-dialog--wide',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-st-trash-title',
          },
          h('h2', { className: 'dsh-st-title', id: 'dsh-st-trash-title' }, t('trash.title')),
          h('p', { className: 'dsh-st-subtitle' }, t('trash.subtitle', { count: trash.count, size: formatSize(trash.sizeBytes) })),
          trash.loading
            ? h('p', { className: 'dsh-st-body' }, t('trash.loading'))
            : trash.error !== null && trash.error !== undefined
              ? h('p', { className: 'dsh-st-body' }, t('trash.loadFailed', { message: trash.error }))
              : trash.entries.length === 0
                ? h('p', { className: 'dsh-st-body' }, t('trash.emptyState'))
                : h(
                    'div',
                    { className: 'dsh-st-list' },
                    trash.entries.map((entry) =>
                      h(
                        'div',
                        { className: 'dsh-st-row', key: entry.id || entry.sessionId },
                        h(
                          'div',
                          { className: 'dsh-st-row__main' },
                          h('div', { className: 'dsh-st-row__title' }, titleOf(t, entry.displayTitle)),
                          h(
                            'div',
                            { className: 'dsh-st-row__meta' },
                            `${entry.sessionId} · ${formatTime(entry.deletedAt)} · ${formatSize(entry.sizeBytes)}${entry.broken ? ` · ${t('trash.broken')}` : ''}`,
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dsh-st-row__ops' },
                          entry.broken
                            ? null
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-st-btn dsh-st-btn--small',
                                  onClick: () =>
                                    void runRestore(t, {
                                      trashId: entry.id,
                                      sessionId: entry.sessionId,
                                      displayTitle: entry.displayTitle,
                                    }),
                                },
                                t('trash.restore'),
                              ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-st-btn dsh-st-btn--small dsh-st-btn--danger',
                              onClick: () =>
                                openConfirm({
                                  kind: 'purge',
                                  trashId: entry.id,
                                  sessionId: entry.sessionId,
                                  displayTitle: entry.displayTitle,
                                }),
                            },
                            t('trash.purge'),
                          ),
                        ),
                      ),
                    ),
                  ),
          h(
            'div',
            { className: 'dsh-st-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-st-btn', onClick: () => void refreshTrash() },
              t('trash.refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-st-btn dsh-st-btn--danger',
                disabled: trash.count === 0,
                onClick: () => openConfirm({ kind: 'empty', count: trash.count }),
              },
              t('trash.empty'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-st-btn', ref: closeRef, onClick: closeTrash },
              t('trash.close'),
            ),
          ),
        ),
      )
    }

    /**
     * The frame-wide overlay: confirmations, the trash manager, the notice.
     * @returns {import('react').ReactElement | null} overlay content.
     */
    function Overlay() {
      const t = translator()
      const state = useSnapshot()
      const confirm = state.confirm
      const notice = state.notice
      const trash = state.trash

      React.useEffect(() => {
        if (confirm === null && !trash.open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (confirm !== null) dismissConfirm()
          else closeTrash()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [confirm, trash.open])

      return h(
        React.Fragment,
        null,
        confirm === null ? null : h(ConfirmDialog, { request: confirm, t }),
        !trash.open || confirm !== null ? null : h(TrashDialog, { t }),
        notice === null
          ? null
          : h(
              'div',
              {
                className: notice.kind === 'error' ? 'dsh-st-notice dsh-st-notice--error' : 'dsh-st-notice',
                role: notice.kind === 'error' ? 'alert' : 'status',
                onClick: dismissNotice,
              },
              h('span', { className: 'dsh-st-dot', 'aria-hidden': 'true' }),
              h('span', null, notice.text),
              notice.action
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-st-notice__action',
                      onClick: (event) => {
                        event.stopPropagation()
                        const run = notice.action.onClick
                        dismissNotice()
                        run()
                      },
                    },
                    notice.action.label,
                  )
                : null,
            ),
      )
    }

    // ── plugin ───────────────────────────────────────────────────────────────
    /**
     * Insert the plugin stylesheet once for this Client run.
     * @returns {() => void} cleanup.
     */
    function insertStyles() {
      const existing = document.querySelector('style[data-dsh-plugin="dsh-session-trash"]')
      if (existing !== null) return () => undefined
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-session-trash'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx

        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => {
            let dispose
            try {
              // Documented typed form: one namespace, both shipped locales.
              dispose = locale.register(NS, { en: EN, zh: ZH })
            } catch {
              // Language-pack form, for a locale runtime that only accepts it.
              const disposers = [locale.register(NS, 'zh', ZH), locale.register(NS, 'en', EN)]
              dispose = () => {
                for (const remove of disposers) {
                  try {
                    remove()
                  } catch {
                    // Dictionary removal is best effort at teardown.
                  }
                }
              }
            }
            return () => {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                // Dictionary removal is best effort at teardown.
              }
            }
          }, 'session-trash: locale dictionaries')
        }

        ctx.effect(() => insertStyles(), 'session-trash: styles')

        const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return

        slots.inject('sidebar.workspaces.session.menu.item', () =>
          slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-trash.move-to-trash',
              order: 500,
              locale: NS,
              registrant: 'dsh-session-trash',
            },
            MoveToTrashRow,
          ),
        )

        slots.inject('sidebar.workspaces.session.menu.item', () =>
          slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-trash.delete-forever',
              order: 510,
              locale: NS,
              registrant: 'dsh-session-trash',
            },
            DeleteForeverRow,
          ),
        )

        slots.inject('sidebar.workspaces.session.menu.item', () =>
          slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-trash.open-trash',
              order: 520,
              locale: NS,
              registrant: 'dsh-session-trash',
            },
            TrashManagerRow,
          ),
        )

        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: 'session-trash.overlay',
              order: 900,
              locale: NS,
              registrant: 'dsh-session-trash',
            },
            Overlay,
          ),
        )
      },
    }
  },
})
