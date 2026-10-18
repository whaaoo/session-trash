/**
 * Host half of the Session trash plugin: one exact Connection Fetch route the
 * browser rows call.
 *
 * The route is the single place the operation lives, so a future agent tool or
 * command can call `performDelete` directly instead of re-implementing it.
 *
 * Why an exact Fetch route rather than a generic RPC channel: the generic
 * `connection.rpc` registry registers its HTTP route through the *reading*
 * Context's `webServer`, which a plugin of this size has no other use for.
 * `connection.fetch` owns its own registration, so the only dependency here is
 * `connection` itself.
 */

import { performDelete, SessionDeleteRefusal } from './store.js'

/** Exact route under the shared `/api` carrier; reachable by the owner Peer only. */
const ROUTE_PATH = '/api/dsh-session-trash'

/** Sessions whose deletion is already in flight, so a double click cannot race. */
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
 * Answer one deletion request.
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
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (sessionId === '') return json(failure('invalid', 'sessionId is required'))
  if (inFlight.has(sessionId)) return json(failure('busy', `session ${sessionId} is already being deleted`))

  inFlight.add(sessionId)
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
    inFlight.delete(sessionId)
  }
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
