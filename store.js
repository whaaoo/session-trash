/**
 * Durable side of the Session trash: locating one stored Session and applying
 * exactly one of the two dispositions (move to the local trash folder, or
 * delete permanently).
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

import { cp, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Only ids the harness itself mints; also the path-traversal fence for the segment below. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/

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
 * Move a file or directory, falling back to copy-and-remove across devices.
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
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
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

  if (mode === 'trash') {
    const trashDir = await createTrashDirectory(sessionId)
    const movedSession = located === undefined ? undefined : join(trashDir, 'session')
    const movedCache = hasCache ? join(trashDir, `${sessionId}.json`) : undefined
    const record = {
      schemaVersion: 1,
      sessionId,
      displayTitle,
      deletedAt: new Date().toISOString(),
      mode: 'trash',
      originalSessionDir: located?.sessionDir ?? null,
      originalCachePath: hasCache ? cachePath : null,
      workspaceIds: membership.workspaceIds,
      wasArchived: null,
      wasPinned: null,
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
