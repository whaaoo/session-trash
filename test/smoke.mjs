/**
 * Smoke test for the durable half, run against a throwaway DSH home:
 *
 *   node test/smoke.mjs
 *
 * It exercises the two dispositions, the two structural refusals (invalid id,
 * nothing stored), the path-traversal fence, and both failure orderings:
 * permanent deletion removes files before accounting, and a failed trash
 * accounting write restores everything.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-session-trash-'))
process.env.DSH_HOME = home

const {
  performDelete,
  SessionDeleteRefusal,
  locateSession,
  projectionCachePath,
  sessionsRoot,
  trashRoot,
} = await import('../store.js')

const PROJECT = '--C-tmp-demo--'
const SESSION = 'session-11111111-2222-3333-4444-555555555555'

/**
 * Create one stored Session with a projection-cache record.
 * @param {string} sessionId the Session to materialize.
 * @returns {Promise<string>} its directory.
 */
async function seed(sessionId) {
  const sessionDir = join(sessionsRoot(), PROJECT, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'not-a-real-log')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(projectionCachePath(sessionId), '{"ver":1}')
  return sessionDir
}

/**
 * A minimal Context stand-in for the services `performDelete` reads.
 * `live` reports a Session that is open in memory; it must make no difference.
 * @param {{ live?: boolean, registryFails?: boolean }} options behavior.
 * @returns {object} fake context.
 */
function fakeContext(options = {}) {
  const detached = []
  const workspaces = [
    {
      id: 'ws-1',
      sessionIds: [SESSION],
      detachSession: async (sessionId) => {
        if (options.registryFails === true) throw new Error('domain write rejected')
        detached.push(sessionId)
      },
    },
  ]
  const calls = { unarchive: 0, unpin: 0 }
  const registry = {
    list: () => workspaces,
    unarchiveSession: async () => {
      calls.unarchive += 1
    },
    unpinSession: async () => {
      calls.unpin += 1
    },
  }
  return {
    detached,
    calls,
    get: (name) => {
      if (name === 'sessions') return options.live === true ? { get: () => ({ id: SESSION }) } : undefined
      if (name === 'agents') return options.live === true ? { get: () => ({ id: SESSION }) } : undefined
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    waterfall: async (_name, _request, next) => next(),
  }
}

/** @param {string} path candidate. @returns {Promise<boolean>} existence. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const sessionDir = await seed(SESSION)
assert.ok(await locateSession(SESSION), 'seeded session must be locatable')

// ── structural refusals ─────────────────────────────────────────────────────
await assert.rejects(
  () => performDelete(fakeContext(), { sessionId: '../escape', mode: 'trash' }),
  (error) => error instanceof SessionDeleteRefusal && error.code === 'invalid',
)
await assert.rejects(
  () => performDelete(fakeContext(), { sessionId: 'session-does-not-exist', mode: 'trash' }),
  (error) => error instanceof SessionDeleteRefusal && error.code === 'not-found',
)
assert.ok(await exists(sessionDir), 'a refused delete must leave the log in place')

// ── permanent handles files before accounting ───────────────────────────────
await assert.rejects(
  () => performDelete(fakeContext({ registryFails: true }), { sessionId: SESSION, mode: 'permanent' }),
  (error) => error instanceof SessionDeleteRefusal && error.code === 'registry-failed',
)
assert.equal(await exists(sessionDir), false, 'the permanent disposition removes files before accounting')

// ── trash rollback when accounting fails ────────────────────────────────────
await seed(SESSION)
await assert.rejects(
  () => performDelete(fakeContext({ registryFails: true }), { sessionId: SESSION, mode: 'trash' }),
  (error) => error instanceof SessionDeleteRefusal && error.code === 'registry-failed',
)
assert.ok(await exists(sessionDir), 'a failed accounting write must restore the session directory')
assert.ok(await exists(projectionCachePath(SESSION)), 'a failed accounting write must restore the cache record')
const trashEntriesAfterRollback = await exists(trashRoot()) ? await readdir(trashRoot()) : []
assert.deepEqual(trashEntriesAfterRollback, [], 'a rolled-back trash entry must be removed')

// ── trash, from a Session that is open in memory ────────────────────────────
const context = fakeContext({ live: true })
const trashed = await performDelete(context, { sessionId: SESSION, mode: 'trash', displayTitle: 'Demo session' })
assert.equal(trashed.outcome, 'trashed', 'a Session held in memory is trashed like any other')
assert.equal(trashed.detachedWorkspaces, 1)
assert.deepEqual(context.detached, [SESSION])
assert.equal(context.calls.unarchive, 1)
assert.equal(context.calls.unpin, 1)
assert.equal(await exists(sessionDir), false, 'the session directory must leave the persistence root')
assert.equal(await exists(projectionCachePath(SESSION)), false, 'the cache record must leave its domain')
assert.equal(await exists(join(sessionsRoot(), PROJECT)), false, 'an emptied project directory is removed')

const entries = await readdir(trashRoot())
assert.equal(entries.length, 1)
const entryDir = join(trashRoot(), entries[0])
assert.ok(await exists(join(entryDir, 'session', 'session.v4.jsonl.zstd')), 'the log moves into the trash entry')
assert.ok(await exists(join(entryDir, `${SESSION}.json`)), 'the cache record moves into the trash entry')
const restore = JSON.parse(await readFile(join(entryDir, 'restore.json'), 'utf8'))
assert.equal(restore.sessionId, SESSION)
assert.equal(restore.displayTitle, 'Demo session')
assert.equal(restore.originalSessionDir, sessionDir)
assert.equal(restore.originalCachePath, projectionCachePath(SESSION))
assert.deepEqual(restore.workspaceIds, ['ws-1'])

// ── permanent, from a Session that is open in memory ────────────────────────
const secondSession = 'session-99999999-8888-7777-6666-555555555555'
const secondDir = await seed(secondSession)
const deleted = await performDelete(fakeContext({ live: true }), { sessionId: secondSession, mode: 'permanent' })
assert.equal(deleted.outcome, 'deleted', 'a Session held in memory is deleted like any other')
assert.equal(deleted.trashDir, null)
assert.equal(await exists(secondDir), false)
assert.equal(await exists(projectionCachePath(secondSession)), false)
assert.equal((await readdir(trashRoot())).length, 1, 'a permanent delete adds no trash entry')

await rm(home, { recursive: true, force: true })
console.log('session-trash smoke: ok')
