/**
 * Route-level smoke test: applies the Host half against a fake Context, then
 * drives the registered Fetch route exactly as the browser does.
 *
 *   node test/channel-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-session-trash-channel-'))
process.env.DSH_HOME = home

const { apply } = await import('../route.js')
const { projectionCachePath, sessionsRoot } = await import('../store.js')

const SESSION = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/**
 * @param {string} sessionId stored Session to create.
 * @returns {Promise<void>} resolution after the files exist.
 */
async function seed(sessionId) {
  const dir = join(sessionsRoot(), '--C-tmp-demo--', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(projectionCachePath(sessionId), '{}')
}

/** @type {Array<object>} */
const routes = []
const connection = {
  fetch: {
    register: (route) => {
      routes.push(route)
      return async () => undefined
    },
  },
}

/**
 * @param {{ live?: boolean }} options fake behavior.
 * @returns {object} Context stand-in.
 */
function context(options = {}) {
  return {
    get: (name) => {
      if (name === 'sessions') return options.live === true ? { get: () => ({}) } : undefined
      if (name === 'agents') return options.live === true ? { get: () => ({}) } : undefined
      if (name === 'connection') return connection
      return undefined
    },
    waterfall: async (_name, _request, next) => next(),
    inject: (_deps, callback) => callback({ get: (name) => (name === 'connection' ? connection : undefined) }),
  }
}

/**
 * Post one body to the captured route.
 * @param {unknown} body JSON body.
 * @returns {Promise<any>} parsed envelope.
 */
async function post(body) {
  const request = new Request('http://127.0.0.1/api/dsh-session-trash', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return routes[0].fetch(request).then((response) => response.json())
}

/** @param {object} ctx fake Context. @returns {void} */
function useContext(ctx) {
  routes.length = 0
  apply(ctx)
  assert.equal(routes.length, 1, 'apply registers exactly one route')
}

await seed(SESSION)

useContext(context({ live: true }))
assert.equal(routes[0].path, '/api/dsh-session-trash')
assert.deepEqual(routes[0].methods, ['POST'])
assert.equal(routes[0].requestBody, 'buffered')

const invalid = await post({ sessionId: '../escape', mode: 'trash' })
assert.equal(invalid.ok, false)
assert.equal(invalid.error.code, 'invalid')

const missing = await post({ sessionId: 'session-not-here', mode: 'trash' })
assert.equal(missing.ok, false)
assert.equal(missing.error.code, 'not-found')

const trashed = await post({ sessionId: SESSION, mode: 'trash', displayTitle: 'Route test' })
assert.equal(trashed.ok, true, 'a Session held in memory is deleted by the route')
assert.equal(trashed.value.outcome, 'trashed')
assert.equal(trashed.value.sessionId, SESSION)

const again = await post({ sessionId: SESSION, mode: 'trash' })
assert.equal(again.ok, false)
assert.equal(again.error.code, 'not-found', 'a second delete finds no stored session')

await rm(home, { recursive: true, force: true })
console.log('session-trash channel smoke: ok')
