/**
 * Smoke test for the durable half, run against a throwaway DSH home:
 *
 *   node test/smoke.mjs
 *
 * It exercises the two delete dispositions, the full trash loop
 * (list → restore → purge → empty → expire), the archive/pin snapshot, the two
 * structural refusals (invalid id, nothing stored), the path-traversal fence,
 * and both failure orderings: permanent deletion removes files before
 * accounting, and a failed trash accounting write restores everything.
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
  listTrash,
  restoreTrashEntry,
  purgeTrashEntry,
  emptyTrash,
  purgeExpiredTrash,
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

/**
 * A richer Context stand-in with archive/pin snapshot and re-attach support,
 * for the full-loop half of the test.
 * @returns {{ ctx: object, calls: object, workspaces: Array<object> }} fake context and spies.
 */
function richContext() {
  const calls = { archive: 0, pin: 0, attach: 0, detach: 0 }
  const workspaces = [
    {
      id: 'ws-1',
      sessionIds: [SESSION],
      detachSession: async () => {
        calls.detach += 1
      },
      attachSession: async () => {
        calls.attach += 1
      },
    },
  ]
  const registry = {
    list: () => workspaces,
    unarchiveSession: async () => undefined,
    unpinSession: async () => undefined,
    isArchived: async () => true,
    isPinned: async () => true,
    archiveSession: async () => {
      calls.archive += 1
    },
    pinSession: async () => {
      calls.pin += 1
    },
  }
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    waterfall: async (_name, _request, next) => next(),
  }
  return { ctx, calls, workspaces }
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
const trashEntriesAfterRollback = (await exists(trashRoot())) ? await readdir(trashRoot()) : []
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

// ── list sees the trashed session ───────────────────────────────────────────
{
  const listed = await listTrash()
  assert.equal(listed.count, 1, 'the trash holds one entry')
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].sessionId, SESSION)
  assert.equal(listed.entries[0].broken, undefined, 'a fresh entry restores cleanly')
  assert.ok(listed.sizeBytes > 0, 'the trash reports a positive size')
}

// ── restore puts the files back ─────────────────────────────────────────────
{
  // The entry above was trashed with the minimal context, whose workspaces
  // have no attach API, so the restore warns instead of re-attaching.
  const restored = await restoreTrashEntry(fakeContext(), { sessionId: SESSION })
  assert.equal(restored.outcome, 'restored')
  assert.equal(restored.sessionId, SESSION)
  assert.ok(await exists(sessionDir), 'the session directory comes back')
  assert.ok(await exists(projectionCachePath(SESSION)), 'the cache record comes back')
  assert.deepEqual((await listTrash()).entries, [], 'the trash is empty after a restore')
  // Restoring twice finds nothing left to restore.
  await assert.rejects(
    () => restoreTrashEntry(fakeContext(), { sessionId: SESSION }),
    (error) => error instanceof SessionDeleteRefusal && error.code === 'not-found',
  )
}

// ── trash again, then purge ─────────────────────────────────────────────────
{
  await performDelete(fakeContext(), { sessionId: SESSION, mode: 'trash' })
  assert.equal((await listTrash()).count, 1, 'the session is trashed again')
  const purged = await purgeTrashEntry({ sessionId: SESSION })
  assert.equal(purged.outcome, 'purged')
  assert.equal(purged.sessionId, SESSION)
  assert.deepEqual((await listTrash()).entries, [], 'a purge empties the trash')
  assert.equal(await exists(sessionDir), false, 'a purge does not bring the files back')
}

// ── archive/pin snapshot round-trips through restore ────────────────────────
{
  const { ctx, calls } = richContext()
  await seed(SESSION)
  await performDelete(ctx, { sessionId: SESSION, mode: 'trash', displayTitle: 'Archived' })
  const listed = await listTrash()
  assert.equal(listed.count, 1)
  const record = JSON.parse(await readFile(join(trashRoot(), listed.entries[0].id, 'restore.json'), 'utf8'))
  assert.equal(record.wasArchived, true, 'the trash note records the real archive flag')
  assert.equal(record.wasPinned, true, 'the trash note records the real pin flag')
  const restored = await restoreTrashEntry(ctx, { sessionId: SESSION })
  assert.equal(restored.outcome, 'restored')
  assert.equal(calls.attach, 1, 'the session re-attaches to its workspace')
  assert.equal(calls.archive, 1, 'the archive flag is re-applied')
  assert.equal(calls.pin, 1, 'the pin flag is re-applied')
  assert.deepEqual(restored.warnings, [], 'a clean restore warns about nothing')
  assert.ok(await exists(sessionDir), 'the archived session comes back')
}

// ── empty drops every entry ─────────────────────────────────────────────────
{
  const secondSession = 'session-22222222-3333-4444-5555-666666666666'
  await seed(secondSession)
  await performDelete(fakeContext(), { sessionId: SESSION, mode: 'trash' })
  await performDelete(fakeContext(), { sessionId: secondSession, mode: 'trash' })
  assert.equal((await listTrash()).count, 2, 'two sessions wait in the trash')
  const emptied = await emptyTrash()
  assert.equal(emptied.count, 2, 'empty reports what it dropped')
  assert.deepEqual((await listTrash()).entries, [], 'empty leaves no entries')
}

// ── expire drops only old entries ───────────────────────────────────────────
{
  await seed(SESSION)
  await performDelete(fakeContext(), { sessionId: SESSION, mode: 'trash' })
  const kept = await purgeExpiredTrash(60 * 60 * 1000)
  assert.equal(kept.count, 0, 'a fresh entry survives a one-hour expiry')
  assert.equal((await listTrash()).count, 1)
  const dropped = await purgeExpiredTrash(0)
  assert.equal(dropped.count, 1, 'maxAgeMs 0 drops everything already stored')
  assert.deepEqual((await listTrash()).entries, [], 'expiry leaves no entries')
}

// ── permanent, from a Session that is open in memory ────────────────────────
const secondSession = 'session-99999999-8888-7777-6666-555555555555'
const secondDir = await seed(secondSession)
const deleted = await performDelete(fakeContext({ live: true }), { sessionId: secondSession, mode: 'permanent' })
assert.equal(deleted.outcome, 'deleted', 'a Session held in memory is deleted like any other')
assert.equal(deleted.trashDir, null)
assert.equal(await exists(secondDir), false)
assert.equal(await exists(projectionCachePath(secondSession)), false)
assert.equal((await listTrash()).count, 0, 'a permanent delete adds no trash entry')

await rm(home, { recursive: true, force: true })
console.log('session-trash smoke: ok')
