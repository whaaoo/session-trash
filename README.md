# dsh-session-trash

Session row actions for the DeepSeek Harness Web UI: **Move to Trash** and
**Delete Permanently** in the `...` menu of every Session row, archived or not.

## What it does

| Action | Files | Accounting |
|---|---|---|
| Move to Trash | session directory and projection-cache record move to `<DSH_HOME>/trash/session-delete/<stamp>-<sessionId>/` with a `restore.json` | the Session leaves every Workspace and the archive/pin sets |
| Delete Permanently | the same files are removed | same accounting change |

There is **no eligibility gate**: a Session that is open in the main view, still
held in memory, or still running work is handled like any other. Deleting the
conversation you are looking at removes its row and its log; the open view keeps
rendering the in-memory conversation until you navigate away, and its further
messages can no longer be persisted.

`restore.json` records the original session directory, the original cache path,
the Workspaces the Session belonged to, and the deletion time, so a trashed
Session can be put back by hand.

## Ordering and failure handling

Files are handled before accounting in both dispositions:

- **Move to Trash** moves the files first and rolls them back if the accounting
  write fails, so a Session is never hidden while its log stays behind.
- **Delete Permanently** removes the files first; a Session only leaves the
  sidebar once its log is gone, so a refused removal leaves the row exactly as
  it was and cannot resurrect a half-deleted Session on the next start.

A live writer opens the log around each batch; the few-millisecond windows in
between are absorbed by a bounded retry (six attempts, under two seconds). If
the files are still held after that, the call fails with `locked` and changes
nothing.

## Surfaces

- Browser: two rows in `sidebar.workspaces.session.menu.item` (`order` 500 and
  510, after the shipped Copy Session ID row), one confirmation dialog and a
  notice stack in `shell.overlay`.
- Host: one exact Connection Fetch route, `POST /api/dsh-session-trash`, with
  the JSON body `{ sessionId, mode: 'trash' | 'permanent', displayTitle }` and
  a `{ ok, value }` / `{ ok: false, error }` envelope. Only the owner browser
  Peer may call it; the shared `/api` carrier answers every other principal
  with 403.

Everything the browser needs to run this operation lives in `route.js` and
`store.js`, so a future agent tool or command can call `performDelete` directly
instead of re-implementing the delete.

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
