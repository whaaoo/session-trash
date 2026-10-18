# dsh-session-trash

Session row actions for the DeepSeek Harness Web UI: **Move to Trash**,
**Delete Permanently**, and a **Trash Manager** in the `...` menu of every
Session row, archived or not.

## What it does

| Action | Files | Accounting |
|---|---|---|
| Move to Trash | session directory and projection-cache record move to `<DSH_HOME>/trash/session-delete/<stamp>-<sessionId>/` with a `restore.json` | the Session leaves every Workspace and the archive/pin sets |
| Restore | the same files move back to their recorded locations | the Session re-attaches to its former Workspaces and archive/pin flags, best-effort |
| Purge / Empty | the trash entry (or every entry) is removed | nothing else changes |
| Delete Permanently | the live session files are removed directly | same accounting change as Move to Trash |

There is **no eligibility gate**: a Session that is open in the main view, still
held in memory, or still running work is handled like any other. Deleting the
conversation you are looking at removes its row and its log; the open view keeps
rendering the in-memory conversation until you navigate away, and its further
messages can no longer be persisted.

`restore.json` (`schemaVersion: 2`) records the original session directory, the
original cache path, the Workspaces the Session belonged to, the real
archive/pin flags, and the deletion time. Version 1 notes without the schema
marker still read back; they restore with `wasArchived`/`wasPinned` unknown.

## Ordering and failure handling

Files are handled before accounting in every disposition:

- **Move to Trash** moves the files first and rolls them back if the accounting
  write fails, so a Session is never hidden while its log stays behind.
- **Restore** moves the files back first; workspace re-attachment is best-effort
  afterwards and surfaces as `warnings` instead of failing the restore, because
  the log is already home and must not be pushed back into the trash.
- **Delete Permanently** removes the files first; a Session only leaves the
  sidebar once its log is gone, so a refused removal leaves the row exactly as
  it was and cannot resurrect a half-deleted Session on the next start.

A live writer opens the log around each batch; the few-millisecond windows in
between are absorbed by a bounded retry (six attempts, under two seconds). If
the files are still held after that, the call fails with `locked` and changes
nothing. Cross-device moves fall back to verified copy-and-remove so a failed
move never leaves duplicates behind.

## Surfaces

- Browser: three rows in `sidebar.workspaces.session.menu.item` (`order` 500,
  510, and 520, after the shipped Copy Session ID row), confirmation dialogs, an
  Undo notice after every trash move, and a Trash Manager dialog listing every
  entry with Restore / Delete / Empty-all actions in `shell.overlay`.
- Host: one exact Connection Fetch route, `POST /api/dsh-session-trash`,
  dispatching on `action`:

  | `action` | Body | Result |
  |---|---|---|
  | `delete` (default; legacy `{ sessionId, mode }` bodies still work) | `{ sessionId, mode: 'trash' \| 'permanent', displayTitle }` | `{ outcome: 'trashed' \| 'deleted', ... }` |
  | `list` | `{}` | `{ entries, count, sizeBytes }`, newest first |
  | `restore` | `{ trashId }` or `{ sessionId }` | `{ outcome: 'restored', attachedWorkspaces, warnings }` |
  | `purge` | `{ trashId }` or `{ sessionId }` | `{ outcome: 'purged', trashId, sessionId }` |
  | `empty` | `{}` | `{ outcome: 'emptied', count }` |
  | `expire` | `{ maxAgeMs }` | `{ outcome: 'expired', count }` |

  Every reply uses a `{ ok, value }` / `{ ok: false, error }` envelope. Only the
  owner browser Peer may call it; the shared `/api` carrier answers every other
  principal with 403. A missing `mode` defaults to `trash`; a defined-but-wrong
  `mode` is rejected with `invalid`.

Everything the browser needs to run this operation lives in `route.js` and
`store.js`, so a future agent tool or command can call `performDelete`,
`restoreTrashEntry`, `listTrash`, `purgeTrashEntry`, `emptyTrash`, or
`purgeExpiredTrash` directly instead of re-implementing the loop.

## Limits

- The shipped JSONL persistence backend has no deletion API, so this package
  owns the documented on-disk layout (`sessions/--<cwd>--/<sessionId>/`,
  `storages/session_projcache/sessions/<sessionId>.json`). A different
  persistence backend would need its own store implementation.
- Deleting a Session that is still running cannot stop that work. Its later
  appends may recreate a headerless log fragment beside the other Sessions of
  the same project; the backend omits a file without a valid header from
  discovery and listing, so the Session does not come back, but the fragment can
  remain on disk until removed.
- Child Sessions of a deleted parent are not removed; they are hidden from the
  sidebar anyway (`origin: 'subagent'`).
- The workspace registry surface differs between harness revisions, so the
  archive/pin snapshot probes several getter shapes defensively. When nothing
  answers, the flags record as `null` and the manager shows them as unknown.
