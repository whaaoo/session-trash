/**
 * Durable side of the Session trash: locating one stored Session and applying
 * exactly one of the two dispositions (move to the local trash folder, or
 * delete permanently), plus the trash lifecycle every recycle bin needs:
 * listing, restoring, purging a single entry, emptying, and expiring.
 *
 * There is no eligibility gate: a Session that is open, still in memory, or
 * still running work is deleted like any other, because the caller owns that
 * decision. What remains is ownership of the on-disk layout for the shipped
 * JSONL backend:
 *
 *   <home>/sessions/--<normalized-cwd>--/<sessionId>/session.vN.jsonl.zstd
 *   <home>/storages/session_projcache/sessions/<sessionId>.json
 *
 * Accounting (workspace membership, the archive set, the pin set) stays with
 * `ctx.workspaceRegistry`, so a deleted Session also leaves the sidebar.
 *
 * Files are handled before accounting in both dispositions: a Session is only
 * forgotten by the registry once its log is gone (or safely in the trash), so
 * a failed file operation never turns into a row that points at nothing.
 */

import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'

/** Only ids the harness itself mints; also the path-traversal fence for the segment below. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Trash entry directory names: `<iso-stamp>-<sessionId>[-<n>]`, never a path. */
const TRASH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Current restore-record schema; readers still accept version 1. */
const TRASH_SCHEMA_VERSION = 2

/** Error codes a live writer or a scanner can produce for one short moment on Windows. */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

/** Backoff between attempts; the whole sequence stays under two seconds. */
const RETRY_DELAYS_MS = [60, 120, 200, 300, 450, 650]

/** A refusal or failure the caller reports verbatim: `code` is stable, `details` is JSON-safe. */
export class SessionDeleteRefusal extends Error {
  /**
   * @param {string} code stable code understood by the Client half.
   * @param {string} message operator-facing diagnostic.
   * @param {Record<string, unknown>} [details] extra JSON-safe context.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SessionDeleteRefusal'
    this.code = code
    this.details = details
  }
}

/**
 * @param {number} ms delay.
 * @returns {Promise<void>} resolution after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run one filesystem mutation, retrying while a live writer momentarily holds it.
 *
 * The persistence backend opens and closes the log around each batch, so a
 * session that is still running briefly owns its file. Retrying lets the
 * delete win between batches instead of reporting a lock.
 *
 * @template T
 * @param {() => Promise<T>} operation filesystem operation.
 * @returns {Promise<T>} the operation result.
 */
async function withRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (!RETRYABLE_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length) throw error
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * @param {unknown} error a filesystem error.
 * @returns {boolean} whether it describes a file that is still held open.
 */
function isLockError(error) {
  if (error === null || typeof error !== 'object') return false
  return error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'
}

/**
 * @param {unknown} error a thrown value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The harness home this process uses.
 * @returns {string} absolute home directory.
 */
export function dshHome() {
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment
  return join(homedir(), '.dsh')
}

/** @returns {string} root of the JSONL persistence backend. */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** @returns {string} directory holding one projection-cache record per Session. */
export function projectionCacheRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/** @returns {string} root of the local trash. */
export function trashRoot() {
  return join(dshHome(), 'trash', 'session-delete')
}

/**
 * @param {string} path candidate path.
 * @returns {Promise<boolean>} whether it currently resolves to a directory.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} path candidate path.
 * @returns {Promise<boolean>} whether anything currently exists there.
 */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Find one stored Session without assuming which project directory holds it.
 *
 * The session id is escaped to a single path segment by the backend; every id
 * the harness mints is already a safe segment, so the directory name is the id.
 *
 * @param {string} sessionId the Session to find.
 * @returns {Promise<{ sessionDir: string, projectDir: string } | undefined>} location, when stored.
 */
export async function locateSession(sessionId) {
  const root = sessionsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectDir = join(root, entry.name)
    const sessionDir = join(projectDir, sessionId)
    if (await isDirectory(sessionDir)) return { sessionDir, projectDir }
  }
  return undefined
}

/**
 * @param {string} sessionId the Session whose cache record is wanted.
 * @returns {string} projection-cache record path (it may not exist).
 */
export function projectionCachePath(sessionId) {
  return join(projectionCacheRoot(), `${sessionId}.json`)
}

/**
 * Workspace membership of one Session, read before any mutation.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} sessionId the Session to inspect.
 * @returns {{ available: boolean, workspaceIds: string[] }} current membership.
 */
export function workspaceMembership(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return { available: false, workspaceIds: [] }
  const workspaceIds = []
  let workspaces
  try {
    workspaces = registry.list()
  } catch {
    return { available: true, workspaceIds }
  }
  for (const workspace of workspaces) {
    let ids = []
    try {
      ids = Array.from(workspace.sessionIds ?? [])
    } catch {
      ids = []
    }
    if (ids.includes(sessionId)) workspaceIds.push(workspace.id)
  }
  return { available: true, workspaceIds }
}

/**
 * Best-effort snapshot of the archive/pin sets for one Session.
 *
 * The registry surface differs between harness revisions (boolean getters,
 * id sets, list calls), so every shape is probed defensively and `null`
 * means "unknown, manual check needed" rather than false.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} sessionId the Session to inspect.
 * @returns {Promise<{ wasArchived: boolean | null, wasPinned: boolean | null }>} snapshot.
 */
export async function queryArchivePin(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return { wasArchived: null, wasPinned: null }
  const wasArchived = await probeFlag(registry, sessionId, [
    'isArchived',
    'isSessionArchived',
    'isArchivedSession',
    'archivedSessionIds',
    'archivedSessions',
    'listArchived',
    'listArchivedSessions',
  ])
  const wasPinned = await probeFlag(registry, sessionId, [
    'isPinned',
    'isSessionPinned',
    'isPinnedSession',
    'pinnedSessionIds',
    'pinnedSessions',
    'listPinned',
    'listPinnedSessions',
  ])
  return { wasArchived, wasPinned }
}

/**
 * Probe one boolean flag through several possible registry shapes.
 * @param {object} registry the workspace registry service.
 * @param {string} sessionId the Session to test.
 * @param {string[]} names candidate property/method names, getters first.
 * @returns {Promise<boolean | null>} true/false when known, else null.
 */
async function probeFlag(registry, sessionId, names) {
  for (const name of names) {
    let candidate
    try {
      candidate = registry[name]
    } catch {
      continue
    }
    if (candidate === undefined || candidate === null) continue
    try {
      if (typeof candidate === 'function') {
        const value = candidate.length === 0 ? await candidate.call(registry) : await candidate.call(registry, sessionId)
        const decided = decideFlagValue(value, sessionId)
        if (decided !== undefined) return decided
        continue
      }
      const decided = decideFlagValue(candidate, sessionId)
      if (decided !== undefined) return decided
    } catch {
      continue
    }
  }
  return null
}

/**
 * Interpret one registry value as a membership flag.
 * @param {unknown} value the value to interpret.
 * @param {string} sessionId the Session to look for.
 * @returns {boolean | undefined} decision, or undefined when not interpretable.
 */
function decideFlagValue(value, sessionId) {
  if (typeof value === 'boolean') return value
  if (value instanceof Set) return value.has(sessionId)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === sessionId) return true
      if (item !== null && typeof item === 'object' && item.id === sessionId) return true
    }
    return false
  }
  return undefined
}

/**
 * Detach the Session from every Workspace and drop it from the archive and pin
 * sets. Each call is idempotent on the registry side.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} sessionId the Session being removed.
 * @returns {Promise<number>} number of Workspaces the Session left.
 */
export async function detachFromWorkspaces(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return 0
  const failures = []
  let detached = 0
  if (typeof registry.list === 'function') {
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch (error) {
      failures.push(error)
    }
    for (const workspace of workspaces) {
      let ids = []
      try {
        ids = Array.from(workspace.sessionIds ?? [])
      } catch {
        ids = []
      }
      if (!ids.includes(sessionId)) continue
      try {
        await workspace.detachSession(sessionId)
        detached += 1
      } catch (error) {
        failures.push(error)
      }
    }
  }
  for (const method of ['unarchiveSession', 'unpinSession']) {
    if (typeof registry[method] !== 'function') continue
    try {
      await registry[method](sessionId)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    const first = failures[0]
    throw new SessionDeleteRefusal(
      'registry-failed',
      `the session files were handled but workspace accounting failed: ${messageOf(first)}`,
      { failures: failures.length },
    )
  }
  return detached
}

/**
 * Re-attach a restored Session to its former Workspaces and archive/pin sets.
 * Best-effort: missing methods become warnings instead of failures, because the
 * files are already back and must not be moved into the trash again.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} sessionId the Session being restored.
 * @param {string[]} workspaceIds former membership.
 * @param {{ wasArchived: boolean | null, wasPinned: boolean | null }} flags former archive/pin state.
 * @returns {Promise<{ attached: number, warnings: string[] }>} accounting outcome.
 */
export async function attachToWorkspaces(ctx, sessionId, workspaceIds, flags = {}) {
  const warnings = []
  let attached = 0
  const registry = ctx.get('workspaceRegistry')
  if (!registry) {
    if ((workspaceIds ?? []).length > 0 || flags.wasArchived === true || flags.wasPinned === true) {
      warnings.push('workspace registry is unavailable; re-attach the session manually')
    }
    return { attached, warnings }
  }
  let workspaces = []
  try {
    workspaces = typeof registry.list === 'function' ? registry.list() : []
  } catch (error) {
    warnings.push(`cannot list workspaces: ${messageOf(error)}`)
  }
  const byId = new Map()
  for (const workspace of workspaces ?? []) {
    try {
      if (workspace && workspace.id !== undefined) byId.set(workspace.id, workspace)
    } catch {
      continue
    }
  }
  for (const workspaceId of workspaceIds ?? []) {
    try {
      const workspace = byId.get(workspaceId)
      if (workspace && typeof workspace.attachSession === 'function') {
        await workspace.attachSession(sessionId)
        attached += 1
        continue
      }
      if (workspace && typeof workspace.addSession === 'function') {
        await workspace.addSession(sessionId)
        attached += 1
        continue
      }
      if (typeof registry.attachSessionToWorkspace === 'function') {
        await registry.attachSessionToWorkspace(workspaceId, sessionId)
        attached += 1
        continue
      }
      if (typeof registry.addSessionToWorkspace === 'function') {
        await registry.addSessionToWorkspace(workspaceId, sessionId)
        attached += 1
        continue
      }
      warnings.push(`workspace ${workspaceId} has no attach API; re-attach manually`)
    } catch (error) {
      warnings.push(`workspace ${workspaceId} re-attach failed: ${messageOf(error)}`)
    }
  }
  if (flags.wasArchived === true) {
    try {
      if (typeof registry.archiveSession === 'function') await registry.archiveSession(sessionId)
      else if (typeof registry.archive === 'function') await registry.archive(sessionId)
      else warnings.push('archive API is unavailable; re-archive manually if needed')
    } catch (error) {
      warnings.push(`re-archive failed: ${messageOf(error)}`)
    }
  }
  if (flags.wasPinned === true) {
    try {
      if (typeof registry.pinSession === 'function') await registry.pinSession(sessionId)
      else if (typeof registry.pin === 'function') await registry.pin(sessionId)
      else warnings.push('pin API is unavailable; re-pin manually if needed')
    } catch (error) {
      warnings.push(`re-pin failed: ${messageOf(error)}`)
    }
  }
  return { attached, warnings }
}

/**
 * Move a file or directory, falling back to copy-and-remove across devices.
 * The copy is verified before the source is removed, and a partial copy is
 * cleaned up so a failed cross-device move never leaves duplicates behind.
 * @param {string} source existing path.
 * @param {string} target destination that must not exist.
 * @returns {Promise<void>} resolution after the move is durable enough to report.
 */
async function movePath(source, target) {
  await withRetry(async () => {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!error || error.code !== 'EXDEV') throw error
    }
    try {
      await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
    if (!(await pathExists(target))) {
      throw Object.assign(new Error(`copy to ${target} produced no target`), { code: 'EIO' })
    }
    await rm(source, { recursive: true, force: true })
  })
}

/**
 * Create this Session's trash directory.
 * @param {string} sessionId the Session being trashed.
 * @returns {Promise<string>} the created directory.
 */
async function createTrashDirectory(sessionId) {
  const root = trashRoot()
  await mkdir(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = attempt === 0 ? `${stamp}-${sessionId}` : `${stamp}-${sessionId}-${attempt}`
    const candidate = join(root, name)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
  }
  throw new SessionDeleteRefusal('failed', 'cannot allocate a trash directory for this session')
}

/**
 * @param {string} dir directory to measure.
 * @returns {Promise<number>} recursive size in bytes, best-effort (0 on error).
 */
async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await dirSize(full)
      else total += (await stat(full)).size
    } catch {
      continue
    }
  }
  return total
}

/**
 * Resolve a trash entry id to its directory, fenced inside the trash root.
 * @param {string} trashId entry directory basename.
 * @returns {string} absolute trash entry directory.
 */
function resolveTrashDir(trashId) {
  if (typeof trashId !== 'string' || trashId === '' || trashId.length > 220) {
    throw new SessionDeleteRefusal('invalid', `not a trash id: ${JSON.stringify(trashId)}`)
  }
  if (!TRASH_ID_PATTERN.test(trashId) || trashId.includes('..')) {
    throw new SessionDeleteRefusal('invalid', `not a trash id: ${JSON.stringify(trashId)}`)
  }
  const candidate = join(trashRoot(), trashId)
  const root = trashRoot()
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new SessionDeleteRefusal('invalid', `not a trash id: ${JSON.stringify(trashId)}`)
  }
  return candidate
}

/**
 * @typedef {object} TrashEntry
 * @property {string} id trash directory basename.
 * @property {string} trashDir absolute trash directory.
 * @property {string} sessionId the trashed Session id.
 * @property {string} displayTitle row title recorded at delete time.
 * @property {string} deletedAt ISO deletion time.
 * @property {string[]} workspaceIds former membership.
 * @property {boolean | null} wasArchived former archive state.
 * @property {boolean | null} wasPinned former pin state.
 * @property {string | null} originalSessionDir where the log came from.
 * @property {string | null} originalCachePath where the cache record came from.
 * @property {boolean} hasSession whether the trash holds a session copy.
 * @property {boolean} hasCache whether the trash holds a cache copy.
 * @property {number} sizeBytes recursive size of the trash entry.
 * @property {boolean} [broken] true when restore.json is missing or unreadable.
 */

/**
 * List every trash entry, newest first. Entries whose restore.json is missing
 * or unreadable are still reported with `broken: true` so they can be purged.
 * @returns {Promise<{ entries: TrashEntry[], count: number, sizeBytes: number }>} trash contents.
 */
export async function listTrash() {
  const root = trashRoot()
  let names
  try {
    names = await readdir(root)
  } catch {
    return { entries: [], count: 0, sizeBytes: 0 }
  }
  const entries = []
  for (const name of names) {
    if (name === '.' || name === '..') continue
    const trashDir = join(root, name)
    if (!(await isDirectory(trashDir))) continue
    const recordPath = join(trashDir, 'restore.json')
    let record
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'))
    } catch {
      entries.push({
        id: name,
        trashDir,
        sessionId: '',
        displayTitle: '',
        deletedAt: '',
        workspaceIds: [],
        wasArchived: null,
        wasPinned: null,
        originalSessionDir: null,
        originalCachePath: null,
        hasSession: await pathExists(join(trashDir, 'session')),
        hasCache: false,
        sizeBytes: await dirSize(trashDir),
        broken: true,
      })
      continue
    }
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    const movedSession = join(trashDir, 'session')
    const movedCache = sessionId !== '' ? join(trashDir, `${sessionId}.json`) : undefined
    entries.push({
      id: name,
      trashDir,
      sessionId,
      displayTitle: typeof record.displayTitle === 'string' ? record.displayTitle : '',
      deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : '',
      workspaceIds: Array.isArray(record.workspaceIds) ? record.workspaceIds.filter((id) => typeof id === 'string') : [],
      wasArchived: typeof record.wasArchived === 'boolean' ? record.wasArchived : null,
      wasPinned: typeof record.wasPinned === 'boolean' ? record.wasPinned : null,
      originalSessionDir: typeof record.originalSessionDir === 'string' ? record.originalSessionDir : null,
      originalCachePath: typeof record.originalCachePath === 'string' ? record.originalCachePath : null,
      hasSession: await pathExists(movedSession),
      hasCache: movedCache === undefined ? false : await pathExists(movedCache),
      sizeBytes: await dirSize(trashDir),
    })
  }
  entries.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''))
  return { entries, count: entries.length, sizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) }
}

/**
 * Find one trash entry by trash id or by session id (newest first).
 * @param {{ trashId?: string, sessionId?: string }} query lookup.
 * @returns {Promise<{ entry: TrashEntry, record: Record<string, unknown> }>} entry and its raw record.
 */
export async function findTrashEntry(query = {}) {
  if (typeof query.trashId === 'string' && query.trashId !== '') {
    const trashDir = resolveTrashDir(query.trashId)
    if (!(await isDirectory(trashDir))) {
      throw new SessionDeleteRefusal('not-found', `trash entry ${query.trashId} does not exist`)
    }
    let record
    try {
      record = JSON.parse(await readFile(join(trashDir, 'restore.json'), 'utf8'))
    } catch {
      throw new SessionDeleteRefusal('broken', `trash entry ${query.trashId} has no readable restore note and cannot be restored; purge it instead`)
    }
    const { entries } = await listTrash()
    const entry = entries.find((item) => item.id === query.trashId)
    if (!entry) throw new SessionDeleteRefusal('not-found', `trash entry ${query.trashId} does not exist`)
    return { entry, record }
  }
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionDeleteRefusal('invalid', `not a session id: ${JSON.stringify(sessionId)}`)
  }
  const { entries } = await listTrash()
  const entry = entries.find((item) => item.sessionId === sessionId && item.broken !== true)
  if (!entry) throw new SessionDeleteRefusal('not-found', `session ${sessionId} has no trash entry to restore`)
  let record
  try {
    record = JSON.parse(await readFile(join(entry.trashDir, 'restore.json'), 'utf8'))
  } catch {
    throw new SessionDeleteRefusal('broken', `trash entry ${entry.id} has no readable restore note and cannot be restored; purge it instead`)
  }
  return { entry, record }
}

/**
 * @typedef {object} DeleteRequest
 * @property {string} sessionId the Session to remove.
 * @property {'trash' | 'permanent'} mode disposition.
 * @property {string} [displayTitle] row title recorded in the restore note.
 */

/**
 * @typedef {object} DeleteResult
 * @property {'trashed' | 'deleted'} outcome what happened.
 * @property {string} sessionId the Session that was handled.
 * @property {string | null} trashDir directory holding the recoverable copy.
 * @property {number} detachedWorkspaces Workspaces the Session left.
 * @property {boolean} removedProjectionCache whether a cache record was removed.
 */

/**
 * Delete one stored Session.
 *
 * The recoverable disposition moves the files first and rolls them back if the
 * accounting write fails. The permanent disposition also handles files first:
 * once the log is gone the Session cannot come back on the next bootstrap, and
 * a refused removal leaves the row exactly as it was.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {DeleteRequest} request requested disposition.
 * @returns {Promise<DeleteResult>} what was done.
 */
export async function performDelete(ctx, request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const mode = request?.mode === 'permanent' ? 'permanent' : 'trash'
  const displayTitle = typeof request?.displayTitle === 'string' ? request.displayTitle : ''

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionDeleteRefusal('invalid', `not a session id: ${JSON.stringify(sessionId)}`)
  }

  const located = await locateSession(sessionId)
  const cachePath = projectionCachePath(sessionId)
  const hasCache = await pathExists(cachePath)
  if (located === undefined && !hasCache) {
    throw new SessionDeleteRefusal('not-found', `session ${sessionId} has no stored log to delete`)
  }

  const membership = workspaceMembership(ctx, sessionId)
  const flags = await queryArchivePin(ctx, sessionId)

  if (mode === 'trash') {
    const trashDir = await createTrashDirectory(sessionId)
    const movedSession = located === undefined ? undefined : join(trashDir, 'session')
    const movedCache = hasCache ? join(trashDir, `${sessionId}.json`) : undefined
    const record = {
      schemaVersion: TRASH_SCHEMA_VERSION,
      sessionId,
      displayTitle,
      deletedAt: new Date().toISOString(),
      mode: 'trash',
      originalSessionDir: located?.sessionDir ?? null,
      originalCachePath: hasCache ? cachePath : null,
      workspaceIds: membership.workspaceIds,
      wasArchived: flags.wasArchived,
      wasPinned: flags.wasPinned,
    }
    try {
      if (located !== undefined && movedSession !== undefined) await movePath(located.sessionDir, movedSession)
      if (movedCache !== undefined) await movePath(cachePath, movedCache)
      await writeFile(join(trashDir, 'restore.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } catch (error) {
      await restoreFromTrash({ trashDir, located, hasCache, cachePath, movedCache })
      throw new SessionDeleteRefusal(
        isLockError(error) ? 'locked' : 'failed',
        isLockError(error)
          ? `the session log is still held open: ${messageOf(error)}`
          : `cannot move the session into the trash: ${messageOf(error)}`,
        { path: typeof error?.path === 'string' ? error.path : undefined },
      )
    }

    let detached
    try {
      detached = await detachFromWorkspaces(ctx, sessionId)
    } catch (error) {
      await restoreFromTrash({ trashDir, located, hasCache, cachePath, movedCache })
      throw error
    }
    await removeEmptyProjectDirectory(located?.projectDir)
    return {
      outcome: 'trashed',
      sessionId,
      trashDir,
      detachedWorkspaces: detached,
      removedProjectionCache: hasCache,
    }
  }

  try {
    if (located !== undefined) await withRetry(() => rm(located.sessionDir, { recursive: true, force: true }))
    if (hasCache) await withRetry(() => rm(cachePath, { force: true }))
  } catch (error) {
    throw new SessionDeleteRefusal(
      isLockError(error) ? 'locked' : 'failed',
      isLockError(error)
        ? `the session log is still held open: ${messageOf(error)}`
        : `cannot remove the session files: ${messageOf(error)}`,
      { path: typeof error?.path === 'string' ? error.path : undefined },
    )
  }

  const detached = await detachFromWorkspaces(ctx, sessionId)
  await removeEmptyProjectDirectory(located?.projectDir)
  return {
    outcome: 'deleted',
    sessionId,
    trashDir: null,
    detachedWorkspaces: detached,
    removedProjectionCache: hasCache,
  }
}

/**
 * Restore one trashed Session to its original location.
 *
 * Files move back first; workspace re-attachment is best-effort afterwards and
 * surfaces as `warnings` instead of failing the restore, because the log is
 * already home and must not be pushed back into the trash.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ trashId?: string, sessionId?: string }} query entry to restore.
 * @returns {Promise<{ outcome: 'restored', sessionId: string, trashId: string, attachedWorkspaces: number, warnings: string[] }>} restore outcome.
 */
export async function restoreTrashEntry(ctx, query = {}) {
  const { entry, record } = await findTrashEntry(query)
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : entry.sessionId
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionDeleteRefusal('broken', `trash entry ${entry.id} records an invalid session id and cannot be restored`)
  }
  const originalSessionDir = typeof record.originalSessionDir === 'string' ? record.originalSessionDir : null
  const originalCachePath = typeof record.originalCachePath === 'string' ? record.originalCachePath : projectionCachePath(sessionId)
  const movedSession = join(entry.trashDir, 'session')
  const movedCache = join(entry.trashDir, `${sessionId}.json`)
  const wantsSession = originalSessionDir !== null && (await pathExists(movedSession))
  const wantsCache = (await pathExists(movedCache))
  if (!wantsSession && !wantsCache) {
    throw new SessionDeleteRefusal('broken', `trash entry ${entry.id} holds no session files to restore`)
  }
  if (await locateSession(sessionId)) {
    throw new SessionDeleteRefusal('exists', `session ${sessionId} already exists; purge or rename the live copy before restoring`)
  }
  if (wantsCache && (await pathExists(originalCachePath))) {
    throw new SessionDeleteRefusal('exists', `a cache record for ${sessionId} already exists; remove it before restoring`)
  }
  try {
    if (wantsSession && originalSessionDir !== null) {
      await mkdir(join(originalSessionDir, '..'), { recursive: true })
      await movePath(movedSession, originalSessionDir)
    }
    if (wantsCache) {
      await mkdir(join(originalCachePath, '..'), { recursive: true })
      await movePath(movedCache, originalCachePath)
    }
  } catch (error) {
    throw new SessionDeleteRefusal(
      isLockError(error) ? 'locked' : 'failed',
      isLockError(error)
        ? `the trash files are still held open: ${messageOf(error)}`
        : `cannot restore the session files: ${messageOf(error)}`,
      { path: typeof error?.path === 'string' ? error.path : undefined },
    )
  }
  const workspaceIds = Array.isArray(record.workspaceIds) ? record.workspaceIds.filter((id) => typeof id === 'string') : []
  const { attached, warnings } = await attachToWorkspaces(ctx, sessionId, workspaceIds, {
    wasArchived: typeof record.wasArchived === 'boolean' ? record.wasArchived : null,
    wasPinned: typeof record.wasPinned === 'boolean' ? record.wasPinned : null,
  })
  await rm(entry.trashDir, { recursive: true, force: true })
  return { outcome: 'restored', sessionId, trashId: entry.id, attachedWorkspaces: attached, warnings }
}

/**
 * Permanently purge one trash entry.
 * @param {{ trashId?: string, sessionId?: string }} query entry to purge.
 * @returns {Promise<{ outcome: 'purged', trashId: string, sessionId: string }>} purge outcome.
 */
export async function purgeTrashEntry(query = {}) {
  let trashDir
  let sessionId = ''
  if (typeof query.trashId === 'string' && query.trashId !== '') {
    trashDir = resolveTrashDir(query.trashId)
    if (!(await isDirectory(trashDir))) {
      throw new SessionDeleteRefusal('not-found', `trash entry ${query.trashId} does not exist`)
    }
    try {
      const record = JSON.parse(await readFile(join(trashDir, 'restore.json'), 'utf8'))
      if (typeof record.sessionId === 'string') sessionId = record.sessionId
    } catch {
      sessionId = ''
    }
    try {
      await withRetry(() => rm(trashDir, { recursive: true, force: true }))
    } catch (error) {
      throw new SessionDeleteRefusal(
        isLockError(error) ? 'locked' : 'failed',
        `cannot purge trash entry ${query.trashId}: ${messageOf(error)}`,
      )
    }
    return { outcome: 'purged', trashId: query.trashId, sessionId }
  }
  const found = await findTrashEntry(query)
  try {
    await withRetry(() => rm(found.entry.trashDir, { recursive: true, force: true }))
  } catch (error) {
    throw new SessionDeleteRefusal(
      isLockError(error) ? 'locked' : 'failed',
      `cannot purge trash entry ${found.entry.id}: ${messageOf(error)}`,
    )
  }
  return { outcome: 'purged', trashId: found.entry.id, sessionId: found.entry.sessionId }
}

/**
 * Permanently purge every trash entry.
 * @returns {Promise<{ outcome: 'emptied', count: number, failures: Array<{ id: string, message: string }> }>} empty outcome.
 */
export async function emptyTrash() {
  const { entries } = await listTrash()
  let count = 0
  const failures = []
  for (const entry of entries) {
    try {
      await withRetry(() => rm(entry.trashDir, { recursive: true, force: true }))
      count += 1
    } catch (error) {
      failures.push({ id: entry.id, message: messageOf(error) })
    }
  }
  return { outcome: 'emptied', count, failures }
}

/**
 * Purge trash entries older than a maximum age.
 * @param {number} maxAgeMs entries at least this old are purged.
 * @returns {Promise<{ outcome: 'expired', count: number, failures: Array<{ id: string, message: string }> }>} expiry outcome.
 */
export async function purgeExpiredTrash(maxAgeMs) {
  const age = Number(maxAgeMs)
  if (!Number.isFinite(age) || age < 0) {
    throw new SessionDeleteRefusal('invalid', 'maxAgeMs must be a non-negative number')
  }
  const now = Date.now()
  const { entries } = await listTrash()
  let count = 0
  const failures = []
  for (const entry of entries) {
    const deletedAt = entry.deletedAt !== '' ? Date.parse(entry.deletedAt) : Number.NaN
    if (!Number.isFinite(deletedAt) || now - deletedAt < age) continue
    try {
      await withRetry(() => rm(entry.trashDir, { recursive: true, force: true }))
      count += 1
    } catch (error) {
      failures.push({ id: entry.id, message: messageOf(error) })
    }
  }
  return { outcome: 'expired', count, failures }
}

/**
 * Put a rolled-back trash entry back where it came from.
 * @param {{ trashDir: string, located: { sessionDir: string, projectDir: string } | undefined, hasCache: boolean, cachePath: string, movedCache: string | undefined }} entry moved pieces.
 * @returns {Promise<void>} resolution after the best-effort rollback.
 */
async function restoreFromTrash(entry) {
  const { trashDir, located, hasCache, cachePath, movedCache } = entry
  const movedSession = located === undefined ? undefined : join(trashDir, 'session')
  try {
    if (located !== undefined && movedSession !== undefined && (await pathExists(movedSession))) {
      await movePath(movedSession, located.sessionDir)
    }
    if (hasCache && movedCache !== undefined && (await pathExists(movedCache))) {
      await movePath(movedCache, cachePath)
    }
    const recordPath = join(trashDir, 'restore.json')
    if (await pathExists(recordPath)) await rm(recordPath, { force: true })
    await removeEmptyProjectDirectory(trashDir)
  } catch {
    // A rollback failure is reported through the original error; leaving the
    // copy in the trash is still recoverable by hand.
  }
}

/**
 * Drop a project directory the deletion emptied, leaving the root untouched.
 * @param {string | undefined} projectDir directory that may now be empty.
 * @returns {Promise<void>} resolution after the best-effort cleanup.
 */
async function removeEmptyProjectDirectory(projectDir) {
  if (projectDir === undefined) return
  try {
    await rmdir(projectDir)
  } catch {
    // Not empty (other sessions live there) or already gone.
  }
}
