/**
 * Host half of the Session trash plugin: one exact Connection Fetch route the
 * browser rows call.
 *
 * The route is the single place the operation lives, so a future agent tool or
 * command can call the store functions directly instead of re-implementing
 * them. The body dispatches on `action`:
 *
 *   delete (default, legacy `{sessionId, mode}`) · list · restore · purge ·
 *   empty · expire
 *
 * Why an exact Fetch route rather than a generic RPC channel: the generic
 * `connection.rpc` registry registers its HTTP route through the *reading*
 * Context's `webServer`, which a plugin of this size has no other use for.
 * `connection.fetch` owns its own registration, so the only dependency here is
 * `connection` itself.
 */

import {
  emptyTrash,
  listTrash,
  performDelete,
  purgeExpiredTrash,
  purgeTrashEntry,
  restoreTrashEntry,
  SessionDeleteRefusal,
} from './store.js'

/** Exact route under the shared `/api` carrier; reachable by the owner Peer only. */
const ROUTE_PATH = '/api/dsh-session-trash'

/**
 * Operation keys already in flight, so a double click cannot race. Keys are
 * namespaced per operation (`delete:<id>`, `restore:<id>`, …) instead of one
 * global flag, so deleting session A never blocks restoring session B.
 */
const inFlight = new Set()

export const name = 'session-trash'

/** The route needs the Host Connection service; elsewhere the row stays inert. */
export const inject = ['connection']

/**
 * @param {{ ok: boolean, value?: unknown, error?: object }} body response envelope.
 * @returns {Response} JSON response.
 */
function json(body) {
  return Response.json(body)
}

/**
 * Build one failure envelope.
 * @param {string} code stable code the Client maps to localized copy.
 * @param {string} message operator-facing diagnostic.
 * @param {Record<string, unknown>} [details] extra JSON-safe context.
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }} envelope.
 */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Try to claim an in-flight key.
 * @param {string} key operation key.
 * @param {string} label human label for the busy message.
 * @returns {{ ok: false, error: object } | null} busy envelope, or null when claimed.
 */
function claim(key, label) {
  if (inFlight.has(key)) return failure('busy', `${label} is already in progress`)
  inFlight.add(key)
  return null
}

/**
 * Answer one trash request, dispatching on `action`.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {Request} request buffered request.
 * @returns {Promise<Response>} JSON envelope.
 */
async function handleRequest(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(failure('invalid', 'request body is not JSON'))
  }
  const args = body !== null && typeof body === 'object' ? body : {}
  const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'delete'

  try {
    switch (action) {
      case 'delete':
        return await handleDelete(ctx, args)
      case 'list':
        return json({ ok: true, value: await listTrash() })
      case 'restore':
        return await handleRestore(ctx, args)
      case 'purge':
        return await handlePurge(args)
      case 'empty':
        return await handleEmpty()
      case 'expire':
        return await handleExpire(args)
      default:
        return json(failure('invalid', `unknown action: ${JSON.stringify(action)}`))
    }
  } catch (error) {
    if (error instanceof SessionDeleteRefusal) return json(failure(error.code, error.message, error.details))
    return json(failure('failed', error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Delete one stored Session. `mode` defaults to `trash` when omitted for
 * backward compatibility, but an explicit unknown mode is rejected instead of
 * silently becoming a trash move.
 */
async function handleDelete(ctx, args) {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (sessionId === '') return json(failure('invalid', 'sessionId is required'))
  if (args.mode !== undefined && args.mode !== 'trash' && args.mode !== 'permanent') {
    return json(failure('invalid', `unknown mode: ${JSON.stringify(args.mode)}`))
  }
  const key = `delete:${sessionId}`
  const busy = claim(key, `session ${sessionId}`)
  if (busy) return json(busy)
  try {
    const value = await performDelete(ctx, {
      sessionId,
      mode: args.mode === 'permanent' ? 'permanent' : 'trash',
      displayTitle: typeof args.displayTitle === 'string' ? args.displayTitle : '',
    })
    return json({ ok: true, value })
  } catch (error) {
    if (error instanceof SessionDeleteRefusal) return json(failure(error.code, error.message, error.details))
    return json(failure('failed', error instanceof Error ? error.message : String(error)))
  } finally {
    inFlight.delete(key)
  }
}

/** Restore one trash entry by `trashId` or `sessionId`. */
async function handleRestore(ctx, args) {
  const trashId = typeof args.trashId === 'string' ? args.trashId : ''
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (trashId === '' && sessionId === '') return json(failure('invalid', 'trashId or sessionId is required'))
  const key = `restore:${trashId !== '' ? trashId : sessionId}`
  const busy = claim(key, 'this restore')
  if (busy) return json(busy)
  try {
    const value = await restoreTrashEntry(ctx, {
      trashId: trashId !== '' ? trashId : undefined,
      sessionId: sessionId !== '' ? sessionId : undefined,
    })
    return json({ ok: true, value })
  } catch (error) {
    if (error instanceof SessionDeleteRefusal) return json(failure(error.code, error.message, error.details))
    return json(failure('failed', error instanceof Error ? error.message : String(error)))
  } finally {
    inFlight.delete(key)
  }
}

/** Permanently purge one trash entry by `trashId` or `sessionId`. */
async function handlePurge(args) {
  const trashId = typeof args.trashId === 'string' ? args.trashId : ''
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (trashId === '' && sessionId === '') return json(failure('invalid', 'trashId or sessionId is required'))
  const key = `purge:${trashId !== '' ? trashId : sessionId}`
  const busy = claim(key, 'this purge')
  if (busy) return json(busy)
  try {
    const value = await purgeTrashEntry({
      trashId: trashId !== '' ? trashId : undefined,
      sessionId: sessionId !== '' ? sessionId : undefined,
    })
    return json({ ok: true, value })
  } catch (error) {
    if (error instanceof SessionDeleteRefusal) return json(failure(error.code, error.message, error.details))
    return json(failure('failed', error instanceof Error ? error.message : String(error)))
  } finally {
    inFlight.delete(key)
  }
}

/** Permanently purge every trash entry. */
async function handleEmpty() {
  const busy = claim('empty', 'emptying the trash')
  if (busy) return json(busy)
  try {
    return json({ ok: true, value: await emptyTrash() })
  } catch (error) {
    if (error instanceof SessionDeleteRefusal) return json(failure(error.code, error.message, error.details))
    return json(failure('failed', error instanceof Error ? error.message : String(error)))
  } finally {
    inFlight.delete('empty')
  }
}

/** Purge trash entries older than `maxAgeMs`. */
async function handleExpire(args) {
  const maxAgeMs = typeof args.maxAgeMs === 'number' ? args.maxAgeMs : Number.NaN
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return json(failure('invalid', 'maxAgeMs must be a non-negative number'))
  return json({ ok: true, value: await purgeExpiredTrash(maxAgeMs) })
}

/**
 * Register the route for as long as `connection` is composed.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    const fetch = connection === undefined || connection === null ? undefined : connection.fetch
    if (fetch === undefined || typeof fetch.register !== 'function') {
      console.warn('session-trash: this Host exposes no connection.fetch; the Session menu rows cannot delete anything')
      return
    }
    fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(ctx, request),
    })
  })
}
