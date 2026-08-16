# Session Storage Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `core/harness/session` so `Session` owns one Session's in-memory behavior, one Repository-owned `SessionStorage` owns durable data for many Sessions, and callers cannot observe the physical fork or storage strategy.

**Architecture:** `SessionRecord` is the single internal durable unit: tree records are `SessionNode`s and Session-wide title changes are non-node records. `Session` validates records, serializes mutations, and maintains memory projections; `JsonlSessionStorage` only creates, loads, lists, appends, and deletes durable records; `SessionRepository` composes the two for lifecycle operations. The normative design is `docs/superpowers/specs/2026-08-16-session-storage-design.md`.

**Tech Stack:** TypeScript 7, Node.js 24, JSONL persistence, native `node:test`.

## Global Constraints

- Production refactoring is limited to `src/core/harness/session/**`; only `src/core/harness/README.md` and focused Session tests change outside that directory.
- Treat the approved design as authoritative. Replace conflicting old helpers instead of preserving them through compatibility aliases.
- Public Session concepts remain `SessionNode`, `SessionMetadata`, `Session`, `SessionRepository`, `SessionError`, and `SessionErrorCode`.
- `SessionRecord`, `SessionStorage`, `JsonlSessionStorage`, JSONL header types, codecs, validators, and path helpers remain internal and must not be re-exported from `src/core/harness/index.ts`.
- Use exactly one internal durable record union and one `SessionStorage.append(sessionId, record)` operation. Do not add per-record storage methods.
- One Project owns one `SessionRepository`; one Repository owns one `SessionStorage`; that Storage manages many Sessions; each returned `Session` owns its own memory state.
- Different Session IDs may persist concurrently. Operations for one Session ID serialize. Multiple independent writable Session objects for the same ID are unsupported; do not add leases, revisions, CAS, or collaborative editing.
- `Session` must not import `storage.ts`, filesystem APIs, JSONL types, storage paths, or storage-directory configuration. It may use `node:path.resolve` only to normalize the logical cwd for `inMemory()`.
- `storage.ts` must not import or construct `Session`.
- Keep generic predicates and ID rules inside `session/records.ts`; do not move Session-only helpers into `core/util`.
- The JSONL backend currently copies forked node paths. Public APIs must remain compatible with a later shared immutable-node backend.
- JSONL remains version `2`; no version-1 migration, compatibility type, cache, index, batching framework, plugin system, or global node-store implementation is part of this refactor.
- Preserve unrelated user changes.
- Do not run the full repository test suite. Run only one pre-implementation failing check and one final focused Session verification.

---

## Target File Map

```text
src/core/harness/session/
  types.ts       # contracts only: public domain types plus internal Record/Storage port
  records.ts     # pure ID generation, parsing, detaching, and tree validation
  session.ts     # one Session's memory state, projections, and serialized commits
  storage.ts     # one JSONL backend serving every Session in one Repository
  repository.ts  # create/open/list/fork/delete orchestration

src/core/harness/README.md
                  # public Session semantics and internal source map

tests/harness/session.test.ts
                  # Session projections, validation, commit ordering, rollback
tests/harness/session-repository.test.ts
                  # JSONL lifecycle, fork, deletion, and per-ID concurrency
```

No new manager, store, factory, base class, node subtype interface, or mapped type is introduced.

---

### Task 1: Replace the Session subsystem with the approved design

This is one review unit because changing only one of `Session`, Storage, or Repository would leave the internal contract inconsistent. Do not make intermediate compatibility commits.

**Files:**
- Modify: `src/core/harness/session/types.ts`
- Create: `src/core/harness/session/records.ts`
- Rewrite: `src/core/harness/session/session.ts`
- Rewrite: `src/core/harness/session/storage.ts`
- Rewrite: `src/core/harness/session/repository.ts`
- Modify: `tests/harness/session.test.ts`
- Modify: `tests/harness/session-repository.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` from `src/core/agent/types.ts`, `ModelConfig` from `src/core/ai/types.ts`, and `<storageDir>/sessions/<sessionId>.jsonl` as the current physical layout.
- Produces: the exact public and internal APIs below. No other Session production file may export an alternative lifecycle or persistence API.

#### `types.ts`: contracts only

```ts
export interface SessionMetadata {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSessionId?: string;
}

export type SessionNode =
  | {
      readonly type: "message";
      readonly id: string;
      readonly parentId: string | null;
      readonly createdAt: string;
      readonly message: AgentMessage;
    }
  | {
      readonly type: "model_selection";
      readonly id: string;
      readonly parentId: string | null;
      readonly createdAt: string;
      readonly selection: ModelConfig;
    };

/** @internal */
export type SessionRecord =
  | SessionNode
  | {
      readonly type: "session_title";
      readonly createdAt: string;
      readonly title: string;
    };

/** @internal */
export interface SessionStorage {
  create(stored: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }): Promise<void>;
  load(sessionId: string): Promise<{
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }>;
  list(): Promise<readonly SessionMetadata[]>;
  append(sessionId: string, record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_record"
  | "storage";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}
```

Import `AgentMessage` and `ModelConfig` only as types. Delete `invalid_entry`; do not add a compatibility error code.

#### `records.ts`: five pure Session-specific functions

```ts
export function newId(): string;
export function parseSessionId(raw: unknown): string;
export function parseSessionRecord(raw: unknown): SessionRecord;
export function validateSessionRecords(records: readonly SessionRecord[]): void;
export function isSessionNode(record: SessionRecord): record is SessionNode;
```

- `newId()` returns the current 12-character UUID-derived ID.
- `parseSessionId()` is the only exported path-ID validator. Accept only `/^[A-Za-z0-9_-]+$/`; otherwise throw `SessionError("invalid_session", ...)`.
- `parseSessionRecord()` validates timestamps, IDs, nullable parent IDs, `AgentMessage`, `ModelConfig`, one-line non-empty titles, and JSON-safe tool details. Construct the exact matching union variant and use `structuredClone` for nested message data; do not retain unknown properties or caller-owned object references.
- `validateSessionRecords()` ignores title records for topology, rejects duplicate node IDs and missing/later parents, and accepts zero nodes or exactly one root.
- `isSessionNode()` returns false only for `session_title`.
- Keep `SESSION_ID_PATTERN`, `isRecord`, `isString`, `isTimestamp`, message/content/model predicates, and JSON predicates private. Malformed records and invalid topology throw `SessionError("invalid_record", ...)`.

#### `session.ts`: one in-memory Session aggregate

```ts
export class Session {
  private constructor(options: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
    readonly storage?: SessionStorage;
  });

  static inMemory(options: { readonly cwd: string }): Session;
  static fromStorage(
    stored: {
      readonly metadata: SessionMetadata;
      readonly records: readonly SessionRecord[];
    },
    storage: SessionStorage,
  ): Session;

  get id(): string;
  get metadata(): SessionMetadata;
  get headId(): string | null;
  get nodes(): readonly SessionNode[];
  path(nodeId?: string | null): readonly SessionNode[];
  messages(nodeId?: string | null): readonly AgentMessage[];
  modelSelection(nodeId?: string | null): ModelConfig | null;
  append(input:
    | { readonly type: "message"; readonly message: AgentMessage }
    | { readonly type: "model_selection"; readonly selection: ModelConfig }
  ): Promise<string>;
  setTitle(title: string): Promise<void>;
  setTitleIfUnknown(title: string): Promise<boolean>;
}
```

```ts
private readonly records: SessionRecord[];
private readonly nodeById: Map<string, SessionNode>;
private _headId: string | null;
private metadataState: SessionMetadata;
private readonly storage?: SessionStorage;
private pending: Promise<void>;
```

Private methods:

```ts
private commit(record: SessionRecord): Promise<void>;
private apply(record: SessionRecord): void;
private enqueue<T>(operation: () => Promise<T>): Promise<T>;
private normalizeTitle(title: string): string;
```

The two state-changing primitives are:

```ts
private async commit(record: SessionRecord): Promise<void> {
  if (this.storage !== undefined) {
    await this.storage.append(this.id, record);
  }
  this.apply(record);
}

private apply(record: SessionRecord): void {
  this.records.push(record);
  this.metadataState = {
    ...this.metadataState,
    updatedAt: record.createdAt > this.metadataState.updatedAt
      ? record.createdAt
      : this.metadataState.updatedAt,
    ...(record.type === "session_title" ? { title: record.title } : {}),
  };
  if (record.type !== "session_title") {
    this.nodeById.set(record.id, record);
    this._headId = record.id;
  }
}
```

- The constructor clones metadata and the already accepted records, then calls `apply` in stored order. It performs neither validation nor I/O; `SessionStorage.load/create` and `Session.append` validate before this construction path.
- `fromStorage()` only invokes that constructor with Storage. Do not add `restore`, `hydrate`, or a free factory.
- `inMemory()` resolves cwd and creates ID/timestamps/title `"unknown"` without a fake Storage.
- `metadata`, `nodes`, `path`, and `messages` return fresh values. `path(null)` returns `[]`; an unknown node ID throws `not_found`.
- `append()` runs in `enqueue`, creates a complete record with `newId()`, current head, and current timestamp, detaches it through `parseSessionRecord()`, awaits `commit()`, and returns its ID.
- `normalizeTitle()` trims the input and rejects an empty or multi-line result with `invalid_record`.
- Both title methods create `session_title` records and call the same `commit()`. Check `"unknown"` inside the mutation queue.
- `enqueue()` must continue after rejection. Because `commit()` applies only after Storage succeeds, do not implement rollback mutation code.

#### `storage.ts`: one backend for many Sessions

```ts
export class JsonlSessionStorage implements SessionStorage {
  constructor(storageDir: string);
  create(stored: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }): Promise<void>;
  load(sessionId: string): Promise<{
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
  }>;
  list(): Promise<readonly SessionMetadata[]>;
  append(sessionId: string, record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

```ts
private readonly storageDir: string;
private readonly pendingById = new Map<string, Promise<void>>();
```

The only physical type is private:

```ts
interface StoredSessionHeader {
  readonly type: "session";
  readonly version: 2;
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
}
```

Implement, but do not export:

```ts
function sessionsDir(storageDir: string): string;
function sessionPath(storageDir: string, sessionId: string): string;
function parseJson(line: string): unknown;
function parseHeader(raw: unknown): StoredSessionHeader;
function metadataFrom(
  header: StoredSessionHeader,
  records: readonly SessionRecord[],
): SessionMetadata;
function asStorageError(message: string, error: unknown): SessionError;
function enqueueById<T>(
  pendingById: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T>;
```

- Constructor resolves one Repository-level storage directory.
- `sessionPath()` calls `parseSessionId()` before joining `<storageDir>/sessions/<id>.jsonl`.
- `parseHeader()` requires `type: "session"`, `version: 2`, a valid ID, an absolute cwd, a valid title and creation timestamp, and an optional valid `parentSessionId`; it returns a detached header and rejects every other physical shape as `invalid_session`.
- `create()` derives and parses a header from metadata, detaches and validates all records before I/O, writes header plus records to a unique hidden temporary file with exclusive creation, renames it to the final path, and always cleans the temporary file after failure.
- `load()` runs through `enqueueById`, requires a non-empty file and matching header/file IDs, parses and validates all records, and returns detached logical data. Map missing file to `not_found`, bad header/JSON to `invalid_session`, bad record/tree to `invalid_record`.
- `metadataFrom()` applies the last title record and uses the maximum header/record timestamp as `updatedAt`.
- `list()` ignores hidden/temp/non-JSONL/unsafe-ID files, calls `load()` for all remaining IDs, propagates corruption, and sorts by `updatedAt` then ID descending.
- `append()` runs through `enqueueById`, validates/detaches one complete record, and appends exactly one JSONL line to the matching Session.
- `delete()` runs through `enqueueById`, deletes only the matching artifact, and treats `ENOENT` as success.
- `create`, `load`, `append`, and `delete` share a queue only when their Session IDs match. Remove a settled map entry only if it still points to that operation's chain.
- Never import, return, or construct `Session`.

#### `repository.ts`: lifecycle composition

```ts
export class SessionRepository {
  private readonly storage: SessionStorage;

  constructor(storageDir: string) {
    this.storage = new JsonlSessionStorage(storageDir);
  }

  create(options: { readonly cwd: string }): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly SessionMetadata[]>;
  fork(sourceSessionId: string, nodeId: string | null): Promise<Session>;
  delete(sessionId: string): Promise<void>;
}
```

```ts
async create(options: { readonly cwd: string }): Promise<Session> {
  const now = new Date().toISOString();
  const stored = {
    metadata: {
      id: newId(),
      title: "unknown",
      cwd: resolve(options.cwd),
      createdAt: now,
      updatedAt: now,
    },
    records: [] as readonly SessionRecord[],
  };
  await this.storage.create(stored);
  return Session.fromStorage(stored, this.storage);
}

async open(sessionId: string): Promise<Session> {
  const stored = await this.storage.load(sessionId);
  return Session.fromStorage(stored, this.storage);
}

list(): Promise<readonly SessionMetadata[]> {
  return this.storage.list();
}

delete(sessionId: string): Promise<void> {
  return this.storage.delete(sessionId);
}
```

- `fork()` opens the source, selects `source.path(nodeId)`, builds fresh child metadata with source cwd/title `"unknown"`/`parentSessionId`, and passes only those selected nodes through the same `storage.create()` then `Session.fromStorage()` flow.
- Preserve copied node IDs and parents. Do not copy titles or siblings. `nodeId === null` creates an empty child.
- Repository contains no filesystem call, JSONL codec, path helper, parser, or tree validator.
- Delete `createPersistentSession`, `openPersistentSession`, `listSessions`, and `deleteSession` rather than wrapping them.

- [ ] **Step 1: Rewrite focused tests against the new boundary**

Replace expected `invalid_entry` with `invalid_record`. Import `SessionStorage` from `session/types.ts`, not `storage.ts`. Because backend paths are private, define test-only paths locally:

```ts
const sessionsDir = (storageDir: string): string => join(storageDir, "sessions");
const sessionPath = (storageDir: string, id: string): string =>
  join(sessionsDir(storageDir), `${id}.jsonl`);
```

Update the rejecting fake and construction call:

```ts
const failure = new Error("storage rejected append");
const storage: SessionStorage = {
  create: async () => {},
  load: async () => { throw new Error("unused load"); },
  list: async () => [],
  append: async () => { throw failure; },
  delete: async () => {},
};
const session = Session.fromStorage({ metadata, records: [] }, storage);
```

Retain existing coverage and ensure it asserts:

```text
title records never enter session.nodes
fromStorage rebuilds head, title, updatedAt, messages, and model selection
append failure changes no memory projection
a rejected queued mutation does not block the next mutation
different Session IDs can append concurrently and both reopen
fork remains readable after its source is deleted
```

- [ ] **Step 2: Run one expected-failure check**

```powershell
npm run build
```

Expected: FAIL because tests reference the new Storage contract, construction input, and error code before production code is rewritten. Do not run a test command here.

- [ ] **Step 3: Replace `types.ts` and create `records.ts`**

Implement the exact contracts and five functions above. No I/O, mutable state, JSONL header, or Storage implementation belongs in either file.

- [ ] **Step 4: Rewrite `session.ts`**

Implement the exact class/state/flows above. Remove exported validators, imports from `storage.ts`, `StoredSessionRow`, `StoredTitleChange`, `storedRows`, `appendNode`, `storage.setTitle`, rollback mutations, and the no-op Storage.

- [ ] **Step 5: Rewrite `storage.ts`**

Implement `JsonlSessionStorage` and its private helpers above. Remove all imports from `session.ts`, all free lifecycle functions, per-Session Storage closures, and exported physical/path helpers.

- [ ] **Step 6: Rewrite `repository.ts`**

Construct exactly one Storage and implement the five lifecycle methods above. Both `create()` and `fork()` must durably create before constructing memory from the same logical value.

- [ ] **Step 7: Scan the dependency boundary**

```powershell
rg -n 'from "\./storage|node:fs|node:path|StoredSession|appendNode|storage\.setTitle|createPersistentSession|openPersistentSession|listSessions|deleteSession|invalid_entry' src/core/harness/session
```

Expected matches are limited to `repository.ts` importing `JsonlSessionStorage`, `storage.ts` importing filesystem/path APIs, and `session.ts` plus `repository.ts` importing `resolve`. There must be no `storage.ts` import in `session.ts`, no `session.ts` import in `storage.ts`, and no old symbol.

- [ ] **Step 8: Run the only passing implementation verification**

```powershell
npm run build
node --test dist/tests/harness/session.test.js dist/tests/harness/session-repository.test.js
```

Expected: build PASS; both focused test files PASS. Do not run `npm test` or unrelated Harness tests.

- [ ] **Step 9: Commit the refactor**

```powershell
git add src/core/harness/session/types.ts src/core/harness/session/records.ts src/core/harness/session/session.ts src/core/harness/session/storage.ts src/core/harness/session/repository.ts tests/harness/session.test.ts tests/harness/session-repository.test.ts
git commit -m "refactor: separate session state and storage"
```

---

### Task 2: Document the final design and lock the package boundary

**Files:**
- Modify: `src/core/harness/README.md`
- Verify only: `src/core/harness/index.ts`

**Interfaces:**
- Consumes: Task 1's final public Session APIs.
- Produces: one authoritative Session chapter and exact source map; no persistence internals become package API.

- [ ] **Step 1: Correct the existing Session chapter**

Keep the current public example and semantics, but apply these exact corrections:

```text
invalid_entry -> invalid_record
private session_title storage row -> internal SessionRecord variant
Session owns one Session's records, head, node index, and metadata projection
SessionStorage owns durable create/load/list/append/delete for many Sessions
SessionRepository owns one Storage and composes durable data with Session objects
append persists one complete SessionRecord, then Session applies it to memory
```

State that `SessionStorage` and `JsonlSessionStorage` are internal implementation boundaries, not application concepts.

- [ ] **Step 2: Add the create and append data flows**

```text
create:
  Repository builds { metadata, records: [] }
  -> Storage.create durably publishes it
  -> Session.fromStorage builds memory

append:
  Session builds and validates one SessionRecord
  -> Storage.append durably accepts it
  -> Session applies it to records/head/metadata
```

Explain that persistence failure therefore leaves memory unchanged.

- [ ] **Step 3: Document ownership, concurrency, and fork abstraction**

```text
one Project -> one SessionRepository -> one SessionStorage -> many durable Sessions
one returned Session -> only that Session's in-memory state
different Session IDs may write concurrently
one Session ID serializes operations and has one authoritative writer
same-ID collaborative multi-writer behavior is unsupported
fork may copy JSONL today or share immutable nodes later without changing callers
```

Do not document leases, CAS, revisions, global garbage collection, plugins, or a future database schema.

- [ ] **Step 4: Replace the Session source map**

In `## 包边界和源码位置`, list:

```text
session/types.ts       public contracts plus internal SessionRecord/SessionStorage contracts
session/records.ts     pure parsing, detaching, ID, and tree validation
session/session.ts     one Session's memory state and behavior
session/storage.ts     JSONL persistence for all Sessions in one Repository
session/repository.ts  public lifecycle orchestration
```

- [ ] **Step 5: Verify the package exports remain exact**

`src/core/harness/index.ts` must export this Session surface and nothing internal:

```ts
export { Session } from "./session/session.js";
export { SessionRepository } from "./session/repository.js";
export { SessionError } from "./session/types.js";
export type {
  SessionErrorCode,
  SessionMetadata,
  SessionNode,
} from "./session/types.js";
```

- [ ] **Step 6: Run documentation and boundary checks without rerunning tests**

```powershell
rg -n 'invalid_entry|appendNode|StoredSessionRow|StoredTitleChange|createPersistentSession|openPersistentSession' src/core/harness/README.md src/core/harness/session src/core/harness/index.ts
npm run typecheck
```

Expected: search has no matches; typecheck PASS. Do not rerun focused or full tests because this task changes documentation only.

- [ ] **Step 7: Commit the documentation**

```powershell
git add src/core/harness/README.md
git commit -m "docs: explain session storage boundary"
```

---

## Final Review Checklist

```text
Public:
  Session, SessionRepository, SessionNode, SessionMetadata,
  SessionError, SessionErrorCode

Internal:
  SessionRecord, SessionStorage, JsonlSessionStorage,
  record validators, JSONL header, paths, codecs, queues

Dependencies:
  session.ts -> types.ts + records.ts
  storage.ts -> types.ts + records.ts
  repository.ts -> session.ts + storage.ts + types.ts + records.ts
  session.ts -X-> storage.ts
  storage.ts -X-> session.ts

Removed:
  StoredSessionRow, StoredTitleChange, storedRows,
  appendNode, SessionStorage.setTitle,
  createPersistentSession, openPersistentSession,
  listSessions, deleteSession, invalid_entry,
  exported generic predicates and SESSION_ID_PATTERN
```
