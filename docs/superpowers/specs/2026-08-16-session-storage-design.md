# Session Storage Redesign

## Goal

Separate Session's in-memory behavior from durable persistence while keeping one
small public Session model. The boundary must support additional durable Session
capabilities and alternative backends without exposing JSONL, file paths, or the
copy-versus-share fork strategy to callers.

Only `core/harness/session` is in scope. Public callers continue to use
`SessionRepository` and `Session`.

## Reference designs

The design combines two proven arrangements:

- Pi separates `Session`, `SessionStorage`, and `SessionRepo`. A repo creates or
  opens a storage-backed Session. Pi's storage also owns Session state; Kea does
  not copy that choice because Kea keeps synchronous in-memory projections on
  `Session`.
- DeepSeek Harness uses one `SessionPersistence` service for many Sessions and
  stores the existing logical `SessionEvent` directly. JSONL and SQLite implement
  the same persistence seam; there is no parallel persistent-message model.

Kea follows Pi's explicit storage boundary and DeepSeek's one-log-record model.
It does not adopt DeepSeek's plugin service, event subscription, coordinator,
recovery cache, or batching framework.

Concrete reference points inspected for this decision:

- Pi: `packages/agent/src/harness/session/types.ts` defines `SessionStorage` and
  `SessionRepo`; `packages/agent/src/harness/session/session.ts` is the Session
  facade; `packages/agent/src/harness/session/jsonl/repo.ts` creates one backend
  object per opened Session. Its Repository contract describes `open` as
  acquiring a writer claim, and the SQLite backend enforces writer leases.
- DeepSeek Harness: `packages/session/session-persistence/src/index.ts` defines
  one persistence service covering many Session IDs;
  `packages/core/session/src/index.ts` uses the canonical `SessionEvent` as its
  durable unit; `packages/session/session-persistence/src/coordinator.ts`
  serializes work per Session ID and maintains one live Session per ID.

These projects support concurrent work on different Sessions. Neither treats
multiple independent writable in-memory objects for the same Session ID as the
ordinary product model. Kea adopts that same boundary without implementing a
lease system that its current single-process use does not require.

## Core concepts

The public concepts remain:

- `SessionNode`: one parent-linked tree node.
- `SessionMetadata`: Session identity and current projected metadata.
- `Session`: one Session's in-memory state and behavior.
- `SessionRepository`: lifecycle for all Sessions in one Project.

One internal concept is added:

- `SessionRecord`: one logical state change accepted into the durable Session
  log. A tree node is a record; a Session-wide title change is a record but is
  not a tree node.

`SessionStorage` is the internal persistence contract. `JsonlSessionStorage` is
its current implementation, not a separate domain concept or public API.

## Durable record model

```ts
type SessionRecord =
  | SessionNode
  | {
      readonly type: "session_title";
      readonly createdAt: string;
      readonly title: string;
    };
```

The JSONL header remains a private physical type. Every later JSONL line encodes
one `SessionRecord` without introducing `StoredSessionRow` or another parallel
message type.

Future built-in capabilities add a record variant only when they represent a
new durable state change. Tree-scoped capabilities add a `SessionNode` variant;
Session-wide facts add a non-node `SessionRecord` variant. Storage methods do not
grow with each capability.

This is an internal extensibility seam, not a plugin system. Third-party runtime
registration and declaration-merging registries remain out of scope until a real
plugin requirement exists.

## Ownership and dependency direction

One Project owns one `SessionRepository`. The Repository owns one
`SessionStorage` backend that manages many Sessions. Every returned `Session`
owns its own in-memory records, node index, head, and metadata projection, and
retains the shared Storage reference for future commits.

```text
types.ts        records.ts
   ^              ^     ^
   |              |     |
session.ts      storage.ts
      ^           ^
       \         /
       repository.ts
```

- `types.ts` owns data contracts and the internal `SessionStorage` interface.
- `records.ts` owns Session-specific record parsing, projection, and tree validation.
- `session.ts` depends only on contracts and record operations, never JSONL or files.
- `storage.ts` depends only on contracts and record operations, never the `Session`
  class.
- `repository.ts` composes Session and Storage because lifecycle operations must
  durably create/load data before returning a usable Session.

Generic predicates stay private to Session validation. They do not move to
`core/util` without independent cross-module reuse.

## Storage API

```ts
interface SessionStorage {
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

The interface is internal and is not re-exported by `core/harness/index.ts`.
There is no storage-specific `setTitle`, `appendMessage`, or `appendModel` method.

## File-by-file implementation blueprint

This section is normative. The refactor may replace the existing implementation
rather than preserving old helper structure.

### `session/types.ts`

This file contains contracts only. It performs no I/O and owns no mutable state.

Public exports retained through `core/harness/index.ts`:

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

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_record"
  | "storage";

export class SessionError extends Error {
  constructor(code: SessionErrorCode, message: string, options?: ErrorOptions);
}
```

Module-internal exports, deliberately omitted from `core/harness/index.ts`:

```ts
export type SessionRecord =
  | SessionNode
  | {
      readonly type: "session_title";
      readonly createdAt: string;
      readonly title: string;
    };

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
```

No storage paths, JSONL headers, codecs, filesystem error types, or backend
configuration appear here.

### `session/records.ts`

This file contains pure operations over Session records. It exports no class and
is not re-exported by the Harness package.

```ts
/** Decode and detach one untrusted value. */
export function parseSessionRecord(raw: unknown): SessionRecord;

/** Generate one ID valid for a Session or SessionNode. */
export function newId(): string;

/** Validate an untrusted Session ID before resolving a storage path. */
export function parseSessionId(raw: unknown): string;

/** Validate IDs, parent-before-child ordering, one root, and no missing parent. */
export function validateSessionRecords(records: readonly SessionRecord[]): void;

/** Whether a durable record participates in the parent-linked tree. */
export function isSessionNode(record: SessionRecord): record is SessionNode;
```

Private helpers validate timestamps, Agent messages, model selections, and
JSON-safe tool details. `isRecord`, `isString`, and similar predicates remain
private here. `SESSION_ID_PATTERN` is also private to this module; Session and
Repository call `newId`, while Storage calls `parseSessionId`, instead of any
caller importing or duplicating the regular expression.

### `session/session.ts`

This file owns the in-memory aggregate and all logical state transitions.

```ts
export class Session {
  private constructor(options: {
    readonly metadata: SessionMetadata;
    readonly records: readonly SessionRecord[];
    readonly storage?: SessionStorage;
  });

  static inMemory(options: { readonly cwd: string }): Session;

  /** Internal: build from data already accepted by SessionStorage. */
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

Private state:

```ts
private readonly records: SessionRecord[];
private readonly nodeById: Map<string, SessionNode>;
private _headId: string | null;
private metadataState: SessionMetadata;
private readonly storage?: SessionStorage;
private pending: Promise<void>;
```

Construction responsibilities:

- the private constructor copies records and rebuilds all projections by calling
  `apply`; it never performs I/O;
- `inMemory` creates fresh metadata and calls the private constructor without
  Storage;
- `fromStorage` calls the same private constructor with the Storage reference;
- no exported factory function duplicates these construction paths.

Private methods and their single responsibilities:

```ts
private commit(record: SessionRecord): Promise<void>;
// Serialize, durably append when storage exists, then apply to memory.

private apply(record: SessionRecord): void;
// Update records plus the relevant node/head/title/updatedAt projection.

private enqueue<T>(operation: () => Promise<T>): Promise<T>;
// Serialize mutations and allow later work after a rejected operation.

private normalizeTitle(title: string): string;
// Enforce one non-empty trimmed line.
```

`fromStorage` copies already validated records and rebuilds indexes by applying
them. It performs no filesystem operation and never imports from `storage.ts`.

### `session/storage.ts`

This file owns the concrete JSONL backend for all Sessions in one Repository.
It exports `JsonlSessionStorage` only for `repository.ts` and focused internal
tests; the Harness package entry does not re-export it.

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

Private state:

```ts
private readonly storageDir: string;
private readonly pendingById: Map<string, Promise<void>>;
```

Private physical type:

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

Private functions and responsibilities:

```ts
function sessionsDir(storageDir: string): string;
function sessionPath(storageDir: string, sessionId: string): string;
// Resolve backend-owned locations and reject unsafe IDs.

function parseHeader(raw: unknown): StoredSessionHeader;
function parseJson(line: string): unknown;
// Decode only the physical header and JSON syntax.

function metadataFrom(
  header: StoredSessionHeader,
  records: readonly SessionRecord[],
): SessionMetadata;
// Fold title and updatedAt for load/list without constructing Session.

function asStorageError(message: string, error: unknown): SessionError;
// Normalize filesystem failures.

function enqueueById<T>(
  pendingById: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T>;
// Serialize mutations for one Session ID, without blocking other IDs.
```

Method behavior:

- `create`: validate all records before I/O; write header plus records to a
  temporary file; publish with rename; clean up the temporary file on failure.
- `load`: validate ID; read; parse header and every record; validate the complete
  record tree; return detached logical data.
- `list`: ignore hidden, temporary, non-JSONL, and unsafe-ID files; load every
  candidate; propagate corruption; sort by `updatedAt`, then ID, descending.
- `append`: serialize one complete `SessionRecord` as one JSONL line; resolve
  only after durable acceptance; validate and detach the record before writing;
  normalize I/O failure.
- `delete`: remove one Session artifact; missing already means deleted.

`create`, `load`, `append`, and `delete` run through `enqueueById`, so a read
cannot overlap a mutation of the same Session artifact. `list` discovers files
without taking a global lock and calls `load` for each candidate. Completed and
rejected queues are removed from `pendingById`, so failures neither leak entries
nor block later operations.

No method returns or constructs `Session`. No Session-wide behavior such as
`setTitle`, `path`, `messages`, or `modelSelection` exists here.

### `session/repository.ts`

This file owns lifecycle orchestration and one backend instance.

```ts
export class SessionRepository {
  constructor(storageDir: string);

  create(options: { readonly cwd: string }): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly SessionMetadata[]>;
  fork(sourceSessionId: string, nodeId: string | null): Promise<Session>;
  delete(sessionId: string): Promise<void>;
}
```

Private state:

```ts
private readonly storage: SessionStorage;
```

Constructor behavior:

```ts
constructor(storageDir: string) {
  this.storage = new JsonlSessionStorage(storageDir);
}
```

Method behavior:

- `create`: generate ID/timestamps and absolute cwd; validate the initial value;
  await `storage.create`; return `Session.fromStorage` with that same value.
- `open`: await `storage.load`; pass the result and shared Storage to
  `Session.fromStorage`.
- `list`: delegate directly to `storage.list`.
- `fork`: open the source; select `source.path(nodeId)`; build fresh metadata
  with `parentSessionId`; create the child using only selected node records;
  return the child Session. Source title records are not copied.
- `delete`: delegate directly to `storage.delete`.

Repository performs no direct filesystem operation and contains no JSONL codec.

### `session/index` exposure through `core/harness/index.ts`

Keep exporting only:

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

Do not export `SessionRecord`, `SessionStorage`, `JsonlSessionStorage`, header
types, record parsers, path helpers, or codecs.

### Structures removed by the refactor

Delete rather than adapt these old structures:

- `StoredSessionRow` and `StoredTitleChange` imports in `Session`;
- `storedRows` as Session state;
- storage-specific `setTitle` from `SessionStorage`;
- free `createPersistentSession`, `openPersistentSession`, `listSessions`, and
  `deleteSession` functions;
- `SESSION_ID_PATTERN`, generic value predicates, node parsers, and tree
  validators exported from `session.ts`;
- any import cycle or mutual dependency between `session.ts` and `storage.ts`.

## Session construction

`Session.fromStorage` remains the single internal construction path for durable
Sessions. The name is retained to avoid introducing another restore/hydrate term.

```ts
class Session {
  /** Build a Session from already created or loaded Storage data. @internal */
  static fromStorage(
    stored: {
      readonly metadata: SessionMetadata;
      readonly records: readonly SessionRecord[];
    },
    storage: SessionStorage,
  ): Session;

  static inMemory(options: { readonly cwd: string }): Session;
}
```

`fromStorage` validates no untrusted input and performs no I/O. Storage load and
the shared validators complete before it runs, so construction after a durable
create cannot fail and leave an unpublished file behind.

An in-memory Session has no Storage. It applies the same records and projections
but skips the durable commit. This avoids adding a fake public memory backend.

## Data flows

### Create

1. Repository creates and validates initial metadata and an empty record list.
2. `storage.create(stored)` durably accepts the initial state.
3. `Session.fromStorage(stored, storage)` builds the in-memory Session.
4. Repository returns the Session.

The same immutable `stored` value enters both representations. Storage never
constructs a Session, and Session never creates a file.

### Open

1. Repository calls `storage.load(sessionId)`.
2. Storage reads and decodes the physical format, validates every record and the
   tree, and returns logical data.
3. Repository passes the returned value to `Session.fromStorage`.

### Append

1. Session serializes the operation on its per-instance queue.
2. Session creates and validates one complete `SessionRecord`.
3. Session awaits `storage.append(session.id, record)`.
4. Only after durable acceptance does Session apply the record to memory.

Failure leaves records, head, and metadata unchanged. A failed operation does not
poison the queue.

### Title change

`setTitle` creates a `session_title` record and uses the same commit path as a
node. Applying that record changes title and `updatedAt` but never nodes or head.

### Fork

Repository opens the source, selects the root-to-node records required by the
new Session, creates fresh child metadata with `parentSessionId`, and performs
the normal create flow. The JSONL backend may copy records. A future global store
may retain shared node references without changing public APIs or logical data.

### List and delete

Repository delegates both operations to Storage. Listing returns projected
`SessionMetadata`; JSONL may derive it by scanning records, while an indexed
backend may read it directly.

## Concurrency

The supported concurrency model matches the default used by Pi and DeepSeek
Harness:

- different Session IDs may execute and persist concurrently;
- operations for one Session ID are serialized;
- one Session ID has one authoritative writable in-memory Session;
- multiple independent writers for the same Session ID are not supported.

A shared backend must use per-ID queues or transactions, never one global write
queue. This permits unrelated Sessions to make progress independently and keeps
backend-specific locking inside Storage.

Collaborative multi-writer editing of one Session would require revision/CAS,
refresh, and conflict semantics because Session owns an in-memory head. That is a
different product behavior, not a transparent persistence optimization, and is
therefore outside this design.

## Extension guarantees

The stable seams support these changes without public Session API changes:

- new built-in durable capabilities through new `SessionRecord` variants;
- new tree projections and derived Session queries;
- JSONL, SQLite, remote, or shared immutable-node backends;
- backend-local indexing, caching, batching, compression, and per-ID locking;
- fork changing from physical copy to shared-node references.

The following remain backend details: storage root, file paths, JSONL version,
atomic publication, indexes, compression, and garbage collection.

## Error semantics

Session exposes four error categories:

- `not_found`: requested Session or node does not exist;
- `invalid_session`: invalid header or whole-session structure;
- `invalid_record`: malformed record or invalid tree relationship;
- `storage`: durable operation failure.

Storage normalizes backend errors. Session validation errors occur before a
write. No cancellation API is added for short append operations; future long
reads or remote backends may add internal cancellation without changing the
public Repository and Session semantics.

## Verification scope

Implementation verification stays focused on `core/harness/session`:

- create/open round trip;
- append publishes memory only after durable acceptance;
- title uses the unified record path and never enters `session.nodes`;
- fork preserves the selected path and remains independent after source delete;
- multiple Session IDs can write without sharing one global queue;
- Storage and Session have no circular dependency;
- Storage internals are not exported from the Harness package entry.

No full repository test run is required for this refactor.
