/**
 * Route-level smoke test: applies the Host half against a fake Context, then
 * drives the registered Fetch route exactly as the browser does.
 *
 *   node test/channel-smoke.mjs
 *
 * It covers every route action (delete → list → restore → purge → empty →
 * expire), the legacy delete body without `action`, the strict mode check, and
 * the invalid/unknown-action refusals.
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
const OTHER = 'session-bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

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
  const registry = {
    list: () => [],
    unarchiveSession: async () => undefined,
    unpinSession: async () => undefined,
  }
  return {
    get: (name) => {
      if (name === 'sessions') return options.live === true ? { get: () => ({}) } : undefined
      if (name === 'agents') return options.live === true ? { get: () => ({}) } : undefined
      if (name === 'workspaceRegistry') return registry
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

// ── refusals ────────────────────────────────────────────────────────────────
const invalid = await post({ sessionId: '../escape', mode: 'trash' })
assert.equal(invalid.ok, false)
assert.equal(invalid.error.code, 'invalid')

const missing = await post({ sessionId: 'session-not-here', mode: 'trash' })
assert.equal(missing.ok, false)
assert.equal(missing.error.code, 'not-found')

const badMode = await post({ sessionId: SESSION, mode: 'yesterday' })
assert.equal(badMode.ok, false, 'a defined-but-invalid mode is rejected')
assert.equal(badMode.error.code, 'invalid')

const unknown = await post({ action: 'defragment' })
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'invalid')

// ── delete (legacy body, no action) ─────────────────────────────────────────
const trashed = await post({ sessionId: SESSION, mode: 'trash', displayTitle: 'Route test' })
assert.equal(trashed.ok, true, 'a Session held in memory is deleted by the route')
assert.equal(trashed.value.outcome, 'trashed')
assert.equal(trashed.value.sessionId, SESSION)

const again = await post({ sessionId: SESSION, mode: 'trash' })
assert.equal(again.ok, false)
assert.equal(again.error.code, 'not-found', 'a second delete finds no stored session')

// ── list ────────────────────────────────────────────────────────────────────
const listed = await post({ action: 'list' })
assert.equal(listed.ok, true)
assert.equal(listed.value.count, 1)
assert.equal(listed.value.entries[0].sessionId, SESSION)

// ── restore ─────────────────────────────────────────────────────────────────
const restored = await post({ action: 'restore', sessionId: SESSION })
assert.equal(restored.ok, true, 'the trashed Session restores through the route')
assert.equal(restored.value.outcome, 'restored')
assert.equal(restored.value.sessionId, SESSION)

const listedAfterRestore = await post({ action: 'list' })
assert.equal(listedAfterRestore.ok, true)
assert.equal(listedAfterRestore.value.count, 0, 'a restore empties the trash')

// ── purge ───────────────────────────────────────────────────────────────────
await seed(SESSION)
const trashedAgain = await post({ action: 'delete', sessionId: SESSION, mode: 'trash' })
assert.equal(trashedAgain.ok, true)
const purged = await post({ action: 'purge', sessionId: SESSION })
assert.equal(purged.ok, true)
assert.equal(purged.value.outcome, 'purged')
const listedAfterPurge = await post({ action: 'list' })
assert.equal(listedAfterPurge.value.count, 0, 'a purge empties the trash')

// ── empty ───────────────────────────────────────────────────────────────────
await seed(SESSION)
await seed(OTHER)
await post({ action: 'delete', sessionId: SESSION, mode: 'trash' })
await post({ action: 'delete', sessionId: OTHER, mode: 'trash' })
const listedTwo = await post({ action: 'list' })
assert.equal(listedTwo.value.count, 2, 'two sessions wait in the trash')
const emptied = await post({ action: 'empty' })
assert.equal(emptied.ok, true)
assert.equal(emptied.value.count, 2, 'empty reports what it dropped')

// ── expire ──────────────────────────────────────────────────────────────────
await seed(SESSION)
await post({ action: 'delete', sessionId: SESSION, mode: 'trash' })
const kept = await post({ action: 'expire', maxAgeMs: 60 * 60 * 1000 })
assert.equal(kept.ok, true)
assert.equal(kept.value.count, 0, 'a fresh entry survives a one-hour expiry')
const dropped = await post({ action: 'expire', maxAgeMs: 0 })
assert.equal(dropped.ok, true)
assert.equal(dropped.value.count, 1, 'maxAgeMs 0 drops everything already stored')
const badExpire = await post({ action: 'expire', maxAgeMs: -1 })
assert.equal(badExpire.ok, false)
assert.equal(badExpire.error.code, 'invalid')

await rm(home, { recursive: true, force: true })
console.log('session-trash channel smoke: ok')
