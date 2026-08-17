# Coding Agent Project Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy Project implementation first, then rebuild only `src/coding-agent/project/` from the approved single-directory Project and ProjectStorage design.

**Architecture:** The rebuilt folder contains `project.ts` for `ProjectInfo` and the runtime `Project`, `storage.ts` for the concrete JSON `ProjectStorage`, and `factory.ts` for cwd/Git resolution plus the `openOrCreateProject()` factory function. This plan deliberately does not adapt the outer coding-agent factory, exports, Tools, Events, Permission, CLI, main, README, or their tests; the wider coding-agent may remain uncompilable until later design stages.

**Tech Stack:** Node.js 24, TypeScript 7 with NodeNext ESM, `node:test`, JSON Project files, and the existing Core `SessionRepository`, `AgentHarness`, `Events`, `AgentToolRegistry`, `ModelRuntime`, and `ModelConfig`.

---

## Implementation boundary

- Delete the old Project source and tests before adding replacements. Do not preserve old files, exports, type aliases, signatures, or compatibility shims.
- Modify implementation and test code only under `src/coding-agent/project/` and `tests/coding-agent/project/`. This plan document is the only file outside those directories changed by planning.
- Do not adapt `src/coding-agent/index.ts`, factories, Tools, Events, Permission, UI, CLI, `src/main.ts`, README files, or their tests.
- The whole repository is explicitly allowed to fail build, typecheck, and tests because untouched callers may still import the deleted API. Those commands are not completion gates for this plan.
- Verify the rebuilt Project in isolation by compiling only its dependency graph and its tests.
- A normalized absolute Project directory is the sole Project identity within one `keaHome`.
- `cwd` is the startup directory. Git discovery may derive a different Project directory; callers cannot supply a Project directory override.
- Keep one concrete internal `ProjectStorage`. Do not add a Storage interface, `JsonProjectStorage`, ProjectRepository, ProjectManager, Factory class, second construction abstraction, generic Project config type, or alternate backend.
- `ProjectStorage` owns only Project persistence. It does not resolve cwd/Git, generate `ProjectInfo`, construct `Project`, or access Session files.
- `Project` owns runtime behavior and does not retain `ProjectStorage` or `keaHome`. It has no update, save, delete, `continueRecent`, `createSession`, or `openSession` operation.
- `createHarness()` always creates a new Session. Only `createHarnessFromSession(id)` restores history explicitly.
- Do not add UI, presentation, interaction, notification, or permission callbacks.
- Construct a fresh, empty `AgentToolRegistry` for each Harness. Built-in Coding Tools are intentionally deferred.
- Do not add locks, retries, or multi-process concurrency. The caller guarantees that Project creation for one `keaHome` is not concurrent.
- Add no dependencies.

## Isolated verification

Run these commands from the repository root after all three source files exist:

```powershell
npm run clean
npx tsc --ignoreConfig --outDir dist --rootDir . --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck --types node src/coding-agent/project/project.ts src/coding-agent/project/storage.ts src/coding-agent/project/factory.ts tests/coding-agent/project/project.test.ts tests/coding-agent/project/storage.test.ts tests/coding-agent/project/factory.test.ts tests/fixtures/model-runtime.ts
node --test "dist/tests/coding-agent/project/*.test.js"
```

During Tasks 2 and 3, remove source and test paths that have not been created yet from the compile command. Do not broaden the command to `src/coding-agent/**`.

### Task 1: Delete the legacy Project before rebuilding

**Files:**

- Delete: `src/coding-agent/project/types.ts`
- Delete: `src/coding-agent/project/storage.ts`
- Delete: `tests/coding-agent/project/storage.test.ts`

- [ ] **Step 1: Record the exact legacy boundary**

Run:

```powershell
rg --files src/coding-agent/project tests/coding-agent/project | Sort-Object
```

Expected: exactly the three files listed above. If additional files exist, inspect them and add them explicitly to this deletion task before continuing; do not leave a mixed old/new implementation.

- [ ] **Step 2: Delete the complete legacy boundary**

Run:

```powershell
git rm -r -- src/coding-agent/project tests/coding-agent/project
```

- [ ] **Step 3: Verify deletion without adapting callers**

Run:

```powershell
git status --short
rg --files src/coding-agent/project tests/coding-agent/project
```

Expected: the three legacy files are staged as deleted, and `rg` reports that the two directories contain no files. Do not run or repair the full repository build.

- [ ] **Step 4: Commit the deletion as its own architectural change**

```powershell
git commit -m "refactor: remove legacy project implementation"
```

### Task 2: Rebuild ProjectInfo and ProjectStorage

**Files:**

- Create: `src/coding-agent/project/project.ts`
- Create: `src/coding-agent/project/storage.ts`
- Create: `tests/coding-agent/project/storage.test.ts`

- [ ] **Step 1: Write storage tests first**

In `project.ts`, declare only this data contract initially:

```ts
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

In `storage.test.ts`, use a fresh `mkdtemp()` directory per test and deterministic `ProjectInfo` fixtures. Cover all of these exact cases:

1. a missing `<keaHome>/projects` returns `undefined`;
2. `create()` persists version `1` and all five `ProjectInfo` fields, then `findByDirectory()` returns an equal value for the same normalized directory;
3. `findByDirectory()` compares normalized paths exactly and does not use parent/child containment;
4. malformed JSON, unsupported version, missing or extra fields, invalid timestamps, non-absolute directory, invalid Project ID, and parent-directory/JSON-ID mismatch each reject;
5. two valid Project records claiming the same normalized directory reject as duplicate ownership;
6. a missing candidate `project.json` and filesystem read failure reject rather than being treated as no match;
7. `create()` rejects an existing target directory without changing its contents;
8. a failed create removes only its own temporary directory and propagates the original failure;
9. `dataDirectory()` returns `<keaHome>/projects/<id>` for a valid ID and rejects traversal or malformed IDs.

Use one valid persisted document shape throughout the test helpers:

```ts
{
  version: 1,
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "example",
  directory: projectDirectory,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z"
}
```

- [ ] **Step 2: Compile the failing storage test**

Run the isolated TypeScript command with only `project.ts`, `storage.ts`, and `storage.test.ts` included.

Expected: compilation fails because `ProjectStorage` and its behavior have not been implemented.

- [ ] **Step 3: Implement the concrete ProjectStorage**

Implement this internal API in `storage.ts`; do not export it from a package entry point in this plan:

```ts
export class ProjectStorage {
  constructor(keaHome: string);

  findByDirectory(directory: string): Promise<ProjectInfo | undefined>;
  create(info: ProjectInfo): Promise<void>;
  dataDirectory(projectId: string): string;
}
```

Implementation rules:

- Canonicalize `keaHome` once in the constructor and derive `<keaHome>/projects` from it.
- Use one strict UUID-shaped Project ID rule for scanning, validation, and `dataDirectory()`.
- Parse `project.json` as `unknown`; validate the exact disk shape, version `1`, exact own keys, finite valid UTC ISO timestamps, an absolute normalized directory, and equality between the file ID and parent directory name.
- Return a fresh `ProjectInfo` value rather than the parsed mutable object.
- Treat only a missing Projects root as empty. Propagate all candidate and filesystem errors with contextual messages and the original error as `cause`.
- Normalize the input to `findByDirectory()` with the same path function used for stored directories, collect all exact matches, and fail if more than one record owns the directory.
- In `create()`, validate `ProjectInfo`, create `<keaHome>/projects`, create a uniquely named temporary sibling directory with exclusive semantics, write the full JSON file, and atomically rename the directory to its final ID.
- Never overwrite the final directory. On failure, remove only the temporary directory created by this call and rethrow the original failure.
- `dataDirectory()` performs no I/O.

- [ ] **Step 4: Run isolated storage verification**

Compile only `project.ts`, `storage.ts`, and `storage.test.ts`, then run:

```powershell
node --test dist/tests/coding-agent/project/storage.test.js
```

Expected: all storage tests pass.

- [ ] **Step 5: Commit Project persistence**

```powershell
git add src/coding-agent/project/project.ts src/coding-agent/project/storage.ts tests/coding-agent/project/storage.test.ts
git commit -m "feat: add project storage"
```

### Task 3: Complete the runtime Project

**Files:**

- Modify: `src/coding-agent/project/project.ts`
- Create: `tests/coding-agent/project/project.test.ts`

- [ ] **Step 1: Write runtime Project tests first**

Create a real temporary `SessionRepository`, use `runtimeFromStream()` from `tests/fixtures/model-runtime.ts`, and instantiate `Project` directly. Cover these cases:

1. `info` is a defensive snapshot and cannot mutate Project state;
2. `listSessions()` delegates to the Project-owned repository;
3. `createHarness()` defaults Session cwd to `ProjectInfo.directory` and creates a new Session every call;
4. relative cwd resolves from the Project directory; an absolute cwd is accepted only when it is inside the Project directory;
5. missing paths, files instead of directories, and paths outside the Project directory reject;
6. `createHarnessFromSession(id)` opens exactly that Session and never creates a replacement;
7. restoration rejects when the recorded cwd is missing or outside the Project directory;
8. every Harness receives a distinct empty `AgentToolRegistry`, while all Harnesses receive the same `Project.events` instance;
9. the system prompt contains the Project directory and Session cwd without importing coding-agent Tools, Events, UI, or Permission modules.

Observe the public Harness through `sessionId`, `messages`, and a deterministic ModelRuntime stream. Where identity must be asserted for internal collaborators, register a listener on `project.events` and run the Harness rather than exposing new getters solely for tests.

- [ ] **Step 2: Compile the failing runtime tests**

Run the isolated TypeScript command with `project.ts`, `storage.ts`, `project.test.ts`, `storage.test.ts`, and `tests/fixtures/model-runtime.ts`.

Expected: compilation fails because the runtime `Project` class does not exist yet.

- [ ] **Step 3: Implement Project as the runtime aggregate**

Add this public shape to `project.ts`:

```ts
export class Project {
  readonly events: Events;

  constructor(options: {
    readonly info: ProjectInfo;
    readonly sessions: SessionRepository;
    readonly runtime: ModelRuntime;
    readonly modelConfig: ModelConfig;
  });

  get info(): ProjectInfo;
  listSessions(): Promise<readonly SessionMetadata[]>;
  createHarness(options?: { readonly cwd?: string }): Promise<AgentHarness>;
  createHarnessFromSession(sessionId: string): Promise<AgentHarness>;
}
```

Implementation rules:

- Copy and validate `ProjectInfo` at construction; return a new snapshot from `info`.
- Create exactly one `Events` instance per Project.
- Resolve omitted Harness cwd to the Project directory, relative cwd from the Project directory, and absolute cwd directly. Resolve its real path, require a directory, and verify containment with `node:path.relative()` rather than string-prefix comparison.
- `createHarness()` calls `SessionRepository.create({ cwd })` after validation.
- `createHarnessFromSession()` calls `SessionRepository.open(id)`, validates the stored Session cwd with the same function, and does not call `create()` on failure.
- Route both paths through one private `buildHarness(session)` method.
- `buildHarness()` creates a new empty `AgentToolRegistry`, generates a concise coding system prompt containing both directories, and constructs `AgentHarness` with the stored runtime, default model, shared Events, and Session.
- Do not cache a current Session or Harness.

- [ ] **Step 4: Run isolated Project and storage tests**

Compile the Task 3 dependency graph, then run:

```powershell
node --test "dist/tests/coding-agent/project/*.test.js"
```

Expected: runtime Project and ProjectStorage tests pass.

- [ ] **Step 5: Commit the runtime aggregate**

```powershell
git add src/coding-agent/project/project.ts tests/coding-agent/project/project.test.ts
git commit -m "feat: add runtime project"
```

### Task 4: Rebuild the Project factory

**Files:**

- Create: `src/coding-agent/project/factory.ts`
- Create: `tests/coding-agent/project/factory.test.ts`

- [ ] **Step 1: Write openOrCreateProject tests first**

Exercise the public function through real temporary directories, a temporary `keaHome`, and temporary Git repositories created by the test process. Cover these cases:

1. omitted `cwd` uses `process.cwd()`;
2. a non-Git cwd becomes the canonical Project directory;
3. a cwd below a Git work-tree resolves to the canonical work-tree root while the newly created Session preserves the startup cwd;
4. two startups in the same Git work-tree reuse one stable Project ID;
5. two startups from the same non-Git cwd reuse one stable Project ID, while parent and child non-Git cwd values remain distinct Projects;
6. first open persists Project data and constructs the SessionRepository below `storage.dataDirectory(projectId)`;
7. every startup followed by `createHarness({ cwd: startupCwd })` creates a new Session ID even when historical Sessions exist;
8. missing cwd and cwd that is a file reject;
9. an explicit Git “not a repository” result falls back to cwd, while inability to launch Git or another Git error rejects;
10. corrupt, unsupported, unreadable, or duplicate Project records reject without creating another Project.

For the Git process failure cases, exercise the real Git process boundary with test-scoped environment changes. Do not introduce a public test setter, Git service, resolver interface, or manager.

- [ ] **Step 2: Compile the failing open tests**

Run the complete isolated TypeScript command from “Isolated verification”.

Expected: compilation fails because `factory.ts` and `openOrCreateProject()` have not been implemented.

- [ ] **Step 3: Implement cwd/Git resolution and openOrCreateProject**

Implement only this public entry in `factory.ts`:

```ts
export function openOrCreateProject(options: {
  readonly keaHome: string;
  readonly cwd?: string;
  readonly runtime: ModelRuntime;
  readonly modelConfig: ModelConfig;
}): Promise<Project>;
```

Use this exact order:

1. resolve `options.cwd ?? process.cwd()` to an absolute path;
2. obtain its real path and require it to be a directory;
3. run `git rev-parse --show-toplevel` with that directory as cwd;
4. use the canonical Git root when the command succeeds;
5. use canonical startup cwd only for Git's explicit “not a repository” result;
6. propagate process-launch failures and all other Git failures;
7. construct internal `ProjectStorage(options.keaHome)`;
8. call `findByDirectory(projectDirectory)`;
9. when absent, generate a UUID, directory basename, and one UTC timestamp used for both `createdAt` and `updatedAt`, then call `create(info)`;
10. construct `SessionRepository(storage.dataDirectory(info.id))`;
11. return `new Project({ info, sessions, runtime, modelConfig })`.

Do not create a Harness inside `openOrCreateProject()`. The application startup sequence is explicitly `openOrCreateProject(...)` followed by `project.createHarness({ cwd: startupCwd })`, which makes the “new Session every startup” choice visible.

- [ ] **Step 4: Run complete isolated verification**

Run the exact two commands from “Isolated verification”.

Expected: every test under `dist/tests/coding-agent/project/` passes.

- [ ] **Step 5: Verify the architectural boundary**

Run:

```powershell
rg -n "ProjectRepository|ProjectManager|JsonProjectStorage|continueRecent|createSession|openSession|confirmPermission|Interaction|Notification|src/ui|coding-agent/tools|coding-agent/events" src/coding-agent/project tests/coding-agent/project
rg --files src/coding-agent/project tests/coding-agent/project | Sort-Object
git diff --check
```

Expected: the forbidden-concept search returns no matches; the file list contains exactly these six files:

```text
src/coding-agent/project/factory.ts
src/coding-agent/project/project.ts
src/coding-agent/project/storage.ts
tests/coding-agent/project/factory.test.ts
tests/coding-agent/project/project.test.ts
tests/coding-agent/project/storage.test.ts
```

Do not run the full repository build or repair failures outside this list.

- [ ] **Step 6: Commit the Project factory**

```powershell
git add src/coding-agent/project/factory.ts tests/coding-agent/project/factory.test.ts
git commit -m "feat: add project factory"
```

## Completion criteria

- The deletion commit precedes every rebuilt Project file.
- Only the six Project source/test files are added after deletion.
- The isolated TypeScript compilation succeeds.
- All isolated Project tests pass.
- Project creation, lookup, runtime Harness construction, explicit Session restoration, Git discovery, path boundaries, and corrupt-data failures match the approved design.
- No outside coding-agent caller is adapted, and no compatibility layer is introduced.
- Failures in the wider coding-agent, CLI, or full repository are documented as expected follow-up work, not treated as failures of this implementation plan.
