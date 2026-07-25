# SessionManager Design

**Goal:** Add a `SessionManager` class that owns the lifecycle of multiple `Session` files under one project's `storageDir`, keeping `createHarness` responsible only for assembling `AgentHarness`.

## Architecture

```
main.ts
  → resolveProject(cwd)                    // cwd → HarnessProject
  → SessionManager.create(project)         // ensure storageDir/sessions/ exists
  → sessionManager.createSession()         // (or continueRecent() / openSession())
  → createHarness({ session, ... })        // factory: session is now required
```

## `SessionManager`

### API

```ts
class SessionManager {
  readonly project: HarnessProject;

  /** Ensure the project's sessions directory exists. */
  static create(project: HarnessProject): Promise<SessionManager>;

  // Session lifecycle
  createSession(): Promise<Session>;        // always new session
  openSession(sessionId: string): Promise<Session>;  // open by ID
  continueRecent(): Promise<Session>;       // newest by mtime, fallback to create
  listSessions(): Promise<string[]>;        // all session IDs, newest first
}
```

### Behavior

- **`create(project)`**: calls `mkdir(storageDir/sessions, { recursive: true })` and returns a `SessionManager` instance. Does NOT create a session.
- **`createSession()`**: delegates to `Session.create(project.storageDir)`. Same behavior as today.
- **`openSession(sessionId)`**: delegates to `Session.open(project.storageDir, sessionId)`.
- **`continueRecent()`**: reads `storageDir/sessions/` directory, filters `*.jsonl` files, picks the one with largest `mtimeMs`. If no files exist, falls back to `createSession()`. If the newest file is empty or corrupt, throws (does NOT silently fall back — corrupt data should surface).
- **`listSessions()`**: reads directory, extracts session IDs from `.jsonl` filenames, sorts by mtime descending. Excludes non-`.jsonl` files and files with invalid ID patterns.

### Session ID → filename

Session IDs use the pattern `YYYYMMDDTHHmmss_<uuid8>.jsonl` (from `Session.create()`). `listSessions()` strips the `.jsonl` suffix.

### Error handling

- `openSession()` for a missing session → `SessionError("not_found")`
- `openSession()` for a corrupt session → `SessionError("invalid_session")` or `SessionError("invalid_entry")`
- `create(project)` when `mkdir` fails → `SessionError("storage")`
- `listSessions()` / `continueRecent()` when `readdir` fails → `SessionError("storage")`

## Changes to existing files

### `src/harness/session/manager.ts` — new file

Contains `SessionManager` class.

### `src/harness/session/index.ts` — new file (barrel)

```ts
export { Session } from "./session.js";
export { SessionError } from "./types.js";
export type { SessionContext, SessionErrorCode } from "./types.js";
// SessionManager is exported from harness/index.ts, not here
```

### `src/harness/types.ts` — no change

`HarnessProject` and `CreateHarnessConfig` stay as-is. `session` in `CreateHarnessConfig` becomes semantically required (callers must pass it), but stays `readonly session?: Session` for backward-compatible gradual migration — `createHarness` throws if session is missing.

### `src/harness/factory.ts` — change

```ts
// Before
const session = config.session ?? await Session.create(config.project.storageDir);

// After
if (!config.session) throw new Error("session is required");
const session = config.session;
```

### `src/harness/index.ts` — add export

```ts
export { SessionManager } from "./session/manager.js";
```

### `src/main.ts` — change

```ts
const project = resolveProject(process.cwd());
const sessionManager = await SessionManager.create(project);
const session = await sessionManager.continueRecent();
const harness = await createHarness({ project, streamFn: stream, model: defaultModel, session });
```

### `tests/harness/session-manager.test.ts` — new file

Tests for all SessionManager methods including temp-directory cleanup.

## Non-Goals

- No `--continue` / `--resume` / `--session` CLI flags in this iteration
- No session fork, compaction, or snapshot
- No session metadata header in JSONL
- No `SessionRepo` interface (pi's abstraction for pluggable storage backends)
