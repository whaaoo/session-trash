/**
 * Browser half of the Session trash plugin.
 *
 * Two rows in a Session row's "..." menu, one frame-wide overlay that owns the
 * permanent-delete confirmation and the result notices, and the exact Host
 * route call that performs the delete.
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
      'confirm.title': '永久删除会话？',
      'confirm.body': '会话「{title}」的日志将被永久删除，无法恢复。',
      'confirm.cancel': '取消',
      'confirm.ok': '永久删除',
      'notice.trashed': '已将「{title}」移到回收站',
      'notice.deleted': '已永久删除「{title}」',
      'unnamed': '未命名会话',
      'error.notFound': '没有找到该会话的存储文件，可能已经被删除。',
      'error.invalid': '无效的会话标识，已拒绝删除。',
      'error.busy': '该会话正在删除中，请稍候。',
      'error.locked': '无法删除会话文件：文件仍被占用（会话可能还在运行），请稍后重试。',
      'error.registry': '文件已处理，但工作区记录更新失败：{message}',
      'error.unavailable': '当前宿主没有可用的连接服务，无法删除会话。',
      'error.failed': '删除失败：{message}',
    }

    const EN = {
      'menu.move': 'Move to Trash',
      'menu.delete': 'Delete Permanently',
      'confirm.title': 'Delete this session permanently?',
      'confirm.body': 'The stored log of "{title}" will be deleted permanently and cannot be recovered.',
      'confirm.cancel': 'Cancel',
      'confirm.ok': 'Delete Permanently',
      'notice.trashed': 'Moved "{title}" to the trash',
      'notice.deleted': 'Permanently deleted "{title}"',
      'unnamed': 'Untitled session',
      'error.notFound': 'No stored log was found for this session; it may already be deleted.',
      'error.invalid': 'That is not a valid session id, so the deletion was refused.',
      'error.busy': 'This session is already being deleted. Please wait.',
      'error.locked': 'Could not remove the session files: they are still held open (the session may still be running). Please try again.',
      'error.registry': 'The files were handled, but the workspace record could not be updated: {message}',
      'error.unavailable': 'This Host has no usable connection service, so the session cannot be deleted.',
      'error.failed': 'Delete failed: {message}',
    }

    const CSS = `
.dsh-st-backdrop{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.32);pointer-events:auto;z-index:80}
.dsh-st-dialog{width:min(420px,calc(100vw - 48px));display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 44px rgba(0,0,0,.28)}
.dsh-st-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.dsh-st-body{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-st-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.dsh-st-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-st-btn:hover:not(.dsh-st-btn--danger){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-st-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-st-btn--danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.dsh-st-btn--danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 86%,#000)}
.dsh-st-btn--danger:active{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 74%,#000)}
.dsh-st-notice{position:fixed;left:50%;bottom:28px;display:flex;gap:8px;align-items:flex-start;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.22);transform:translateX(-50%);pointer-events:auto;cursor:pointer;overflow-wrap:anywhere}
.dsh-st-notice--error{border-color:var(--dsw-alias-state-error-primary)}
.dsh-st-dot{flex:0 0 auto;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsh-st-notice--error .dsh-st-dot{background:var(--dsw-alias-state-error-primary)}
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

    // ── frame-wide state: one notice plus at most one open confirmation ──────
    let snapshot = { confirm: null, notice: null }
    const listeners = new Set()
    let noticeTimer

    /** @param {Partial<{ confirm: object | null, notice: object | null }>} patch next values. */
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

    /** @returns {{ confirm: object | null, notice: object | null }} current values. */
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
     * Show one transient notice.
     * @param {{ kind: 'success' | 'error', text: string }} notice the notice.
     * @returns {void}
     */
    function showNotice(notice) {
      if (noticeTimer !== undefined) clearTimeout(noticeTimer)
      publish({ notice })
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined
        publish({ notice: null })
      }, notice.kind === 'error' ? 9000 : 5000)
    }

    /** @returns {void} dismiss the current notice. */
    function dismissNotice() {
      if (noticeTimer !== undefined) {
        clearTimeout(noticeTimer)
        noticeTimer = undefined
      }
      publish({ notice: null })
    }

    /** @param {{ sessionId: string, displayTitle: string }} request the row asking for confirmation. */
    function openConfirm(request) {
      publish({ confirm: request })
    }

    /** @returns {void} close the confirmation without acting. */
    function dismissConfirm() {
      publish({ confirm: null })
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

    let deleting = false

    /**
     * Run one deletion and report its outcome in the frame-wide notice.
     * @param {(key: string, params?: Record<string, unknown>) => string} t translator.
     * @param {string} sessionId target Session.
     * @param {string} displayTitle row title.
     * @param {'trash' | 'permanent'} mode disposition.
     * @returns {Promise<void>} resolution after the notice is published.
     */
    async function runDelete(t, sessionId, displayTitle, mode) {
      if (deleting) return
      deleting = true
      try {
        await callHost({ sessionId, mode, displayTitle: typeof displayTitle === 'string' ? displayTitle : '' })
        const title = titleOf(t, displayTitle)
        showNotice({
          kind: 'success',
          text: mode === 'trash' ? t('notice.trashed', { title }) : t('notice.deleted', { title }),
        })
      } catch (error) {
        showNotice({ kind: 'error', text: describeFailure(t, error) })
      } finally {
        deleting = false
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
              sessionId: props.sessionId,
              displayTitle: typeof props.displayTitle === 'string' ? props.displayTitle : '',
            })
          },
        },
        t('menu.delete'),
      )
    }

    // ── frame-wide surface ───────────────────────────────────────────────────
    /**
     * One confirmation dialog.
     * @param {{ request: { sessionId: string, displayTitle: string }, t: Function }} props dialog props.
     * @returns {import('react').ReactElement} the dialog.
     */
    function ConfirmDialog(props) {
      const { request, t } = props
      const cancelRef = React.useRef(null)
      React.useEffect(() => {
        if (cancelRef.current !== null && typeof cancelRef.current.focus === 'function') cancelRef.current.focus()
      }, [])
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
          h('h2', { className: 'dsh-st-title', id: 'dsh-st-dialog-title' }, t('confirm.title')),
          h('p', { className: 'dsh-st-body' }, t('confirm.body', { title: titleOf(t, request.displayTitle) })),
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
                  if (target === null || pluginCtx === undefined) return
                  void runDelete(t, target.sessionId, target.displayTitle, 'permanent')
                },
              },
              t('confirm.ok'),
            ),
          ),
        ),
      )
    }

    /**
     * The frame-wide overlay: the confirmation and the current notice.
     * @returns {import('react').ReactElement | null} overlay content.
     */
    function Overlay() {
      const t = translator()
      const state = useSnapshot()
      const confirm = state.confirm
      const notice = state.notice

      React.useEffect(() => {
        if (confirm === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          dismissConfirm()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [confirm])

      return h(
        React.Fragment,
        null,
        confirm === null ? null : h(ConfirmDialog, { request: confirm, t }),
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
