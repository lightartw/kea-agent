# Project Directories and Session Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the path-shaped coding-agent configuration with a persistent Project that owns source directories and metadata-rich Sessions, including non-blocking automatic titles.

**Architecture:** The coding-agent package discovers and persists Project state, selects Sessions, and assembles coding capabilities. The harness package owns the versioned JSONL Session format and title-generation timing. Git is only a Project-root discovery aid; Agent, Harness, Tools, and Session storage do not branch on Git.

**Tech Stack:** TypeScript 7, Node.js 24 ESM, `node:test`, JSON and JSONL persistence, existing `StreamFn`, Agent Loop, AgentHarness, Hook Registry, and Coding Tool factories.

## Global Constraints

- Do not add `Workspace`, `GitProject`, `NonGitProject`, `ProjectRepository`, or Session Runtime entities.
- Final public names are `Project`, `ProjectInfo`, `CreateProjectConfig`, and `createProject()`; do not retain aliases for `CodingAgent`, `CodingProject`, `CreateCodingAgentConfig`, or `createCodingAgent()`.
- A Project has a stable random ID, display name, one or more normalized absolute directories, and one primary directory.
- Expose one atomic `Project.update()` operation for future name/directory/primary changes; current CLI does not need editing UI.
- An explicitly supplied unregistered directory becomes the Project root. Without one, discover the Git work-tree root and fall back to process `cwd`.
- A registered Project match always wins. When registered roots are nested, choose the longest and most specific match.
- Git affects discovery only. Every non-Git root receives an independent Project and Session storage.
- A Session stores one selected Project directory plus a relative `cwd`. Changing `primaryDirectory` does not rewrite existing Sessions.
- Session JSONL version 1 is a breaking format. Reject old headerless files; add no compatibility or migration branch.
- A new Session is immediately persisted with title `"unknown"`.
- Automatic title generation begins after the first real user message is persisted, runs concurrently with the first Agent response, and never blocks or fails the Agent Run.
- Automatic title generation uses only the first user message and the Session's current model, has no Tools, returns one line of at most 100 characters, never overwrites a changed title, and never retries on later turns.
- Project metadata and Session title changes are state, not Hook calls and not Harness execution events.
- Preserve unrelated working-tree changes under `src/coding-agent/hooks/builtin/` and `src/coding-agent/tools/builtin/bash/`; stage exact task paths only.

---

## Final File Responsibilities

- `src/coding-agent/project/types.ts` — Project data, update input, creation config, and public Project contract.
- `src/coding-agent/project/storage.ts` — validate/read/write `project.json`, scan registered Projects, discover Git roots, and open or create Project data.
- `src/coding-agent/title-generator.ts` — adapt `StreamFn` into a bounded title request.
- `src/harness/session/types.ts` — versioned Session header, tree records, Session-level records, creation input, and `SessionInfo`.
- `src/harness/session/session.ts` — JSONL parsing/appending, metadata projection, title mutation, and conversation-tree projection.
- `src/harness/session/repository.ts` — create/open Sessions and list `SessionInfo` by stored `updatedAt`.
- `src/harness/agent-harness.ts` — drive Agent Runs and launch the optional title task at the first-user persistence seam.
- `src/coding-agent/factory.ts` — create a Project, select Session location, validate restored Sessions, and assemble each Harness.
- `src/coding-agent/tools/definition.ts` and `tools/factory.ts` — pass Session `cwd` plus all Project directories into Coding Tools.
- `src/utils/workspace.ts` — validate a resolved path against multiple Project directories. Keep the existing filename to avoid an unrelated move.

---

### Task 1: Persistent Project data and root discovery

**Files:**
- Create: `src/coding-agent/project/types.ts`
- Create: `src/coding-agent/project/storage.ts`
- Create: `tests/coding-agent/project/storage.test.ts`

**Interfaces:**

```ts
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly directories?: readonly string[];
  readonly primaryDirectory?: string;
}

export interface OpenProjectInput {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
}

export interface OpenedProject {
  readonly info: ProjectInfo;
  readonly storageDir: string;
  readonly initialCwd: string;
}

export function openOrCreateProject(input: OpenProjectInput): Promise<OpenedProject>;
export function applyProjectUpdate(info: ProjectInfo, input: UpdateProjectInput): ProjectInfo;
export function persistProject(keaHome: string, info: ProjectInfo): Promise<string>;
export function assertDirectoryOwnership(
  keaHome: string,
  projectId: string,
  directories: readonly string[],
): Promise<void>;
```

- [ ] **Step 1: Write failing Project-format tests**

```ts
test("creates and reopens one persistent Project", async () => {
  const opened = await openOrCreateProject({ keaHome, directory: projectDir });
  assert.equal(opened.info.name, basename(projectDir));
  assert.deepEqual(opened.info.directories, [resolve(projectDir)]);
  assert.equal(opened.info.primaryDirectory, resolve(projectDir));

  const reopened = await openOrCreateProject({
    keaHome,
    directory: join(projectDir, "src"),
  });
  assert.equal(reopened.info.id, opened.info.id);
  assert.equal(reopened.storageDir, opened.storageDir);
  assert.equal(reopened.initialCwd, resolve(projectDir, "src"));
});

test("updates Project state without changing identity", () => {
  const next = applyProjectUpdate(project, {
    name: "research",
    directories: [first, second],
    primaryDirectory: second,
  });
  assert.equal(next.id, project.id);
  assert.equal(next.name, "research");
  assert.equal(next.primaryDirectory, resolve(second));
});
```

Also reject empty names, empty directory arrays, duplicate normalized paths, malformed timestamps, unsupported versions, and a primary directory absent from `directories`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/tests/coding-agent/project/storage.test.js`

Expected: TypeScript fails because the Project modules do not exist.

- [ ] **Step 3: Implement the Project file format**

Persist this exact shape at `<keaHome>/projects/<projectId>/project.json`:

```json
{
  "version": 1,
  "id": "project_123",
  "name": "research",
  "directories": ["D:\\projects\\research"],
  "primaryDirectory": "D:\\projects\\research",
  "createdAt": "2026-08-13T11:00:00.000Z",
  "updatedAt": "2026-08-13T11:00:00.000Z"
}
```

Generate IDs with `project_${randomUUID()}` and timestamps with `new Date().toISOString()`. Resolve every directory to an absolute path. `persistProject()` writes a sibling temporary file and atomically renames it over `project.json`; it returns the Project storage directory. `applyProjectUpdate()` preserves `id` and `createdAt`, and changes `updatedAt` only when state changes.

- [ ] **Step 4: Write failing discovery tests**

Use this assertion pattern for the registered-directory case:

```ts
const existing = await openOrCreateProject({ keaHome, directory: root });
const reopened = await openOrCreateProject({
  keaHome,
  directory: join(root, "packages", "web"),
});
assert.equal(reopened.info.id, existing.info.id);
assert.equal(reopened.initialCwd, resolve(root, "packages", "web"));
```

Add separate tests that assert: nested registered directories select the longest matching path; persisting the same normalized directory under a second Project ID is rejected; an explicit unregistered directory is used without Git traversal; an implicit Git subdirectory resolves to `git rev-parse --show-toplevel`; and an implicit non-Git directory remains the supplied cwd. Every candidate directory in the fixtures must exist and be a directory; also test that a missing path and a regular file are rejected.

Build the Git fixture with `git init`; do not detect Git by checking only for a `.git` directory because linked worktrees may use a `.git` file.

- [ ] **Step 5: Implement discovery precedence**

Normalize `input.directory ?? input.cwd ?? process.cwd()` as `initialCwd`. Scan valid Project files first. A Project matches when `initialCwd` equals or is below one of its directories; choose the matching directory with the longest normalized path. Exact duplicate directories across Projects are invalid.

If no Project matches, use an explicitly supplied `directory` unchanged. Otherwise run `git rev-parse --show-toplevel` with `cwd: initialCwd`; use successful non-empty output and fall back to `initialCwd` on failure. Git command failure is normal control flow, not a user-facing error.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run build && node --test dist/tests/coding-agent/project/storage.test.js`

Expected: all Project storage and discovery tests pass.

```powershell
git add -- src/coding-agent/project/types.ts src/coding-agent/project/storage.ts tests/coding-agent/project/storage.test.ts
git commit -m "feat: persist and discover projects"
```

---

### Task 2: Project-level API and versioned Session storage

This is one vertical migration because changing the Session constructor, Repository list result, Project identity, CLI entry point, and direct tests separately would leave intermediate commits unable to compile.

**Files:**
- Modify: `src/harness/session/types.ts`
- Modify: `src/harness/session/session.ts`
- Modify: `src/harness/session/repository.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/coding-agent/project/types.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `src/index.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/cli-frontend.ts`
- Modify: `tests/harness/session.test.ts`
- Modify: `tests/harness/session-repository.test.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/ui/cli-frontend.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**

```ts
export interface CreateSessionInput {
  readonly projectId: string;
  readonly directory: string;
  readonly cwd: string;
}

export interface SessionInfo extends CreateSessionInput {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionHeader extends CreateSessionInput {
  readonly type: "session";
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface SessionTitleEntry {
  readonly type: "session_title";
  readonly createdAt: string;
  readonly title: string;
}

export interface CreateProjectConfig {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

export interface CreateSessionOptions {
  readonly cwd?: string;
}

export interface Project extends ProjectInfo {
  listSessions(): Promise<readonly SessionInfo[]>;
  createSession(options?: CreateSessionOptions): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  update(input: UpdateProjectInput): Promise<ProjectInfo>;
  renderToolEvent(event: HarnessToolEvent): string;
}

export function createProject(config: CreateProjectConfig): Promise<Project>;
```

- [ ] **Step 1: Write failing Session-header tests**

Replace delayed-file and legacy-format expectations with:

```ts
test("create immediately writes an unknown-title Session header", async () => {
  const session = await Session.create(storageDir, input);
  const records = await readRecords(storageDir, session.id);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    type: "session",
    version: 1,
    id: session.id,
    projectId: input.projectId,
    title: "unknown",
    directory: resolve(input.directory),
    cwd: "src",
    createdAt: session.info.createdAt,
  });
  assert.equal(session.info.updatedAt, session.info.createdAt);
});

test("open rejects a headerless old Session", async () => {
  await writeFile(path, JSON.stringify({
    type: "message",
    id: "x",
    parentId: null,
    message: user,
  }));
  await assert.rejects(Session.open(storageDir, id), isInvalidSession);
});
```

Cover mismatched filename/header ID, unsupported version, duplicate header, malformed time, absolute or escaping `cwd`, valid empty Session, and a valid branched tree. Every message/model entry now has `createdAt`.

- [ ] **Step 2: Write failing title-state tests**

```ts
test("title records do not change the conversation tree", async () => {
  await session.setTitle("First title");
  await session.setTitle("Renamed");
  assert.equal(session.info.title, "Renamed");
  assert.deepEqual(session.buildContext().messages, []);
});

test("setTitleIfUnknown does not overwrite a queued manual title", async () => {
  await session.setTitle("Manual");
  assert.equal(await session.setTitleIfUnknown("Generated"), false);
  assert.equal(session.info.title, "Manual");
});
```

Trim titles and reject empty or multiline titles. Verify failed append rolls back title, tree state, and `updatedAt`.

- [ ] **Step 3: Implement Session JSONL version 1**

Keep Session header, Session-level records, and tree entries as separate in-memory concepts. First line must be one valid header whose ID matches the filename. Later lines may be `message`, `model_change`, or `session_title`; another header is invalid. Only message/model entries affect `leafId` and `buildContext()`.

`Session.create(storageDir, input)` resolves `directory`, validates relative contained `cwd`, creates the sessions directory, and immediately writes the header with `flag: "wx"`. `Session.inMemory(input)` requires the same explicit metadata. Do not invent test-only Project defaults.

All mutations use the existing serialized queue. `setTitleIfUnknown()` compares and appends inside one queued operation. `Session.info` returns an immutable snapshot. `updatedAt` equals the last successfully appended record's `createdAt`.

- [ ] **Step 4: Write failing Repository tests**

```ts
test("new empty Sessions are immediately listed", async () => {
  const first = await repository.create(firstInput);
  const listed = await repository.list();
  assert.deepEqual(listed.map((item) => item.id), [first.id]);
  assert.equal(listed[0]?.title, "unknown");
  assert.equal(listed[0]?.updatedAt, first.info.createdAt);
});

test("a later stored record controls metadata ordering", async () => {
  const first = await repository.create(firstInput);
  const second = await repository.create(secondInput);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await first.setTitle("newest");
  assert.deepEqual(
    (await repository.list()).map((item) => item.id),
    [first.id, second.id],
  );
});
```

Write an invalid JSONL candidate whose filesystem mtime is newest and assert `list()` rejects with `invalid_session`; this proves Repository does not fall back to mtime or silently omit corrupt data.

- [ ] **Step 5: Implement Repository metadata listing**

```ts
class SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly SessionInfo[]>;
}
```

Open every candidate JSONL file through `Session.open()`, map `session.info`, sort by parsed `updatedAt` descending, and break equal timestamps by ID descending. Ignore hidden, non-JSONL, and invalid-ID filenames. Do not call `stat()` and do not silently omit a corrupt Session.

- [ ] **Step 6: Write failing Project API tests**

Migrate tests from `createCodingAgent()` to `createProject()` and cover:

Start with this primary-directory assertion:

```ts
const session = await project.createSession();
const [info] = await project.listSessions();
assert.equal(info?.id, session.sessionId);
assert.equal(info?.directory, project.primaryDirectory);
assert.equal(info?.cwd, ".");
```

Add separate tests with exact assertions that: an empty `continueRecent()` stores startup `initialCwd` relative to its matched Project directory; `openSession()` builds system prompt and Tools from the stored resolved cwd; switching `primaryDirectory` changes a later `createSession()` but not the header of an earlier Session; `Project.update()` survives a second `createProject()` call with the same directory; and `openSession()` rejects a header with a foreign `projectId`, a directory removed from the Project, or a resolved cwd that no longer exists.

- [ ] **Step 7: Implement the Project manager**

`createProject()` calls Task 1 `openOrCreateProject()`, creates `SessionRepository` under that Project storage directory, and returns one object whose Project properties are getters over current state.

Location rules:

- `createSession()` uses current `primaryDirectory` and `cwd: "."`;
- `createSession({ cwd })` resolves from `primaryDirectory`, then chooses the longest Project directory containing the result and stores a relative `cwd`;
- `continueRecent()` opens `list()[0].id`; if the list is empty it creates at `initialCwd`;
- `openSession()` validates header `projectId`, registered directory, resolved containment, and filesystem existence before assembling Harness.

`Project.update()` applies Project validation, calls `assertDirectoryOwnership()`, persists, and swaps in-memory state only after successful write. Removing a directory does not mutate old Session files.

Harness assembly remains in the existing private `createHarness()` helper. For this task, give every Harness the Session's resolved cwd. Tool multi-directory access and automatic title injection arrive in Tasks 3 and 4.

- [ ] **Step 8: Migrate public API and CLI in the same buildable change**

Remove old Coding-prefixed exports and update `CliFrontend.run(project, harness)`. Replace `main.ts` path-derived ID logic with:

```ts
const keaHome = process.env.KEA_HOME ?? resolve(homedir(), ".kea");
const project = await createProject({
  keaHome,
  streamFn: stream,
  model: defaultModel,
  interactions: cli.interactions,
});
const harness = await project.continueRecent();
await cli.run(project, harness);
```

Update every direct `Session.inMemory()` call to pass explicit test metadata. Update import smoke tests to prove `Project`, `ProjectInfo`, `CreateProjectConfig`, `CreateSessionInput`, and `SessionInfo` are public while old names are absent.

- [ ] **Step 9: Run the vertical-slice verification**

Run:

```powershell
npm run typecheck
npm test
```

Expected: all repository tests pass after the breaking API and disk-format migration.

- [ ] **Step 10: Commit exact paths**

```powershell
git add -- src/harness/session/types.ts src/harness/session/session.ts src/harness/session/repository.ts src/harness/index.ts src/coding-agent/project/types.ts src/coding-agent/types.ts src/coding-agent/factory.ts src/coding-agent/index.ts src/index.ts src/main.ts src/ui/cli-frontend.ts tests/harness/session.test.ts tests/harness/session-repository.test.ts tests/harness/agent-harness.test.ts tests/coding-agent/factory.test.ts tests/ui/cli-frontend.test.ts tests/import-smoke.test.ts tests/main.test.ts
git commit -m "feat: manage project sessions with metadata"
```

---

### Task 3: Multi-directory Coding Tool boundaries

**Files:**
- Modify: `src/coding-agent/tools/definition.ts`
- Modify: `src/coding-agent/tools/factory.ts`
- Modify: `src/coding-agent/tools/builtin/files.ts`
- Modify: `src/utils/workspace.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `tests/coding-agent/tools/definition.test.ts`
- Modify: `tests/coding-agent/tools/builtin/bash.test.ts`
- Modify: `tests/coding-agent/tools/builtin/files.test.ts`
- Modify: `tests/coding-agent/tools/builtin/todo.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`

**Interfaces:**

```ts
export interface CodingToolContext {
  readonly cwd: string;
  readonly directories: readonly string[];
}

export function safePath(
  cwd: string,
  directories: readonly string[],
  input: string,
): string;
```

- [ ] **Step 1: Write failing path-boundary tests**

Use this direct helper test as the base case:

```ts
assert.equal(
  safePath(join(primary, "src"), [primary, notes], "index.ts"),
  join(primary, "src", "index.ts"),
);
assert.equal(
  safePath(join(primary, "src"), [primary, notes], join(notes, "plan.md")),
  join(notes, "plan.md"),
);
assert.throws(
  () => safePath(join(primary, "src"), [primary, notes], outside),
  /escapes project directories/,
);
assert.equal(
  safePath(join(primary, "src"), [primary, notes], "../README.md"),
  join(primary, "README.md"),
);
```

Then exercise the same four cases through `read_file`, `write_file`, `edit_file`, and `glob` so the definitions cannot bypass the shared boundary helper.

Use Windows-safe assertions through `resolve()` and `relative()` rather than hard-coded separators.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build && node --test dist/tests/coding-agent/tools/builtin/files.test.js`

Expected: failures because Tools still receive one `cwd` as both base and boundary.

- [ ] **Step 3: Implement multiple-directory containment**

Resolve relative input from Session `cwd`. Accept the resolved target when it equals or lies below at least one normalized Project directory; otherwise throw `Path escapes project directories: <input>`. File and Glob Tools use this helper. Bash starts in Session `cwd`; do not change Bash policy in this task.

Every Harness gets a fresh Tool Registry built with `{ cwd: resolvedSessionCwd, directories: project.directories }`. Project updates affect only Harnesses assembled afterward; running Harness Tool registries stay immutable.

Update every direct test `CodingToolContext` to include `directories: [cwd]`. This is a required consumer migration for definition, Bash, file, and Todo tests; it does not change Bash or Todo behavior.

- [ ] **Step 4: Run focused and factory tests**

Run:

```powershell
npm run build
node --test dist/tests/coding-agent/tools/builtin/files.test.js dist/tests/coding-agent/factory.test.js
```

Expected: all path and factory tests pass.

- [ ] **Step 5: Commit exact paths**

```powershell
git add -- src/coding-agent/tools/definition.ts src/coding-agent/tools/factory.ts src/coding-agent/tools/builtin/files.ts src/utils/workspace.ts src/coding-agent/factory.ts tests/coding-agent/tools/definition.test.ts tests/coding-agent/tools/builtin/bash.test.ts tests/coding-agent/tools/builtin/files.test.ts tests/coding-agent/tools/builtin/todo.test.ts tests/coding-agent/factory.test.ts
git commit -m "feat: support project source directories"
```

---

### Task 4: End-to-end automatic Session titles

**Files:**
- Create: `src/coding-agent/title-generator.ts`
- Create: `tests/coding-agent/title-generator.test.ts`
- Modify: `src/harness/types.ts`
- Modify: `src/harness/agent-harness.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `tests/harness/agent-harness.test.ts`
- Modify: `tests/coding-agent/factory.test.ts`

**Interfaces:**

```ts
export type SessionTitleGenerator = (
  prompt: string,
  model: ModelConfig,
) => Promise<string>;

export function createSessionTitleGenerator(
  streamFn: StreamFn,
): SessionTitleGenerator;

export interface HarnessConfig {
  readonly titleGenerator?: SessionTitleGenerator;
}

class AgentHarness {
  get title(): string;
  setTitle(title: string): Promise<void>;
}
```

The `HarnessConfig` snippet shows the new field only; preserve all existing fields unchanged.

- [ ] **Step 1: Write failing title-request adapter tests**

```ts
test("title generator makes one bounded Tool-free request", async () => {
  const generate = createSessionTitleGenerator(streamFn);
  assert.equal(await generate("fix parser", model), "Parser fix");
  assert.deepEqual(seenContext.tools, []);
  assert.deepEqual(seenContext.messages, [{ role: "user", content: "fix parser" }]);
});
```

Also test text-delta accumulation, fallback to final assistant text blocks, and rejection when no text exists.

- [ ] **Step 2: Implement the title request adapter**

Call the provided `StreamFn` with the selected model and exactly:

```ts
const context: Context = {
  systemPrompt: "Generate a brief single-line title for this coding session. Return only the title.",
  messages: [{ role: "user", content: prompt }],
  tools: [],
};
```

Do not reuse active Harness history and do not expose a title Agent or Tool.

- [ ] **Step 3: Write failing Harness timing tests**

```ts
test("first persisted user message starts title generation beside the response", async () => {
  const titleStarted = deferred();
  const releaseTitle = deferred();
  const modelStarted = deferred();
  const session = memorySession();
  const harness = makeHarness({
    session,
    titleGenerator: async (prompt, titleModel) => {
      assert.equal(prompt, "design sessions");
      assert.deepEqual(titleModel, modelA);
      assert.equal(session.buildContext().messages[0]?.role, "user");
      titleStarted.resolve();
      await releaseTitle.promise;
      return "Session design";
    },
    streamFn: async function* () {
      modelStarted.resolve();
      yield { type: "done", message: assistant };
    },
  });

  const run = harness.prompt("design sessions");
  await Promise.all([titleStarted.promise, modelStarted.promise]);
  releaseTitle.resolve();
  await run;
  await eventually(() => assert.equal(harness.title, "Session design"));
});
```

Also cover blocked first prompts, generator rejection, empty/multiline/overlength output, manual rename racing with generated output, reopened unknown-title Sessions that already contain a user message, and a later turn after first-attempt failure.

- [ ] **Step 4: Implement the existing persistence seam**

At construction, mark title eligibility only when a generator exists, title is `"unknown"`, and restored messages contain no user message. Do not add an Agent callback or fixed Hook.

`runAgentLoop()` currently pushes the user message after `agent_start` and before yielding `turn_start`. AgentHarness already persists new messages before publishing each event. After that persistence, when the first eligible user is now stored, clear eligibility permanently and launch a detached Promise.

The Promise receives a snapshot of `currentModel` from the first prompt, trims output, takes the first non-empty line, caps it with `slice(0, 97) + "..."`, calls `session.setTitleIfUnknown()`, and catches every failure. It emits no Harness execution event and never joins `prompt()` completion. Manual `setTitle()` delegates to Session. Add one test that switches the model before the first prompt and asserts the generator receives the switched model.

- [ ] **Step 5: Inject the generator from coding-agent**

Every Harness assembled by `createProject()` receives `createSessionTitleGenerator(config.streamFn)`. Harness passes the Session's current model when it launches the first title request, so a model switch made before the first prompt applies to both title generation and that Agent Run. Later switches cannot restart title generation.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
npm run build
node --test dist/tests/coding-agent/title-generator.test.js dist/tests/harness/agent-harness.test.js dist/tests/coding-agent/factory.test.js
```

Expected: title timing and isolation tests pass; generator failure never changes `run_end`.

```powershell
git add -- src/coding-agent/title-generator.ts src/harness/types.ts src/harness/agent-harness.ts src/harness/index.ts src/coding-agent/factory.ts tests/coding-agent/title-generator.test.ts tests/harness/agent-harness.test.ts tests/coding-agent/factory.test.ts
git commit -m "feat: generate session titles in background"
```

---

### Task 5: README, architecture, stale-name removal, and final verification

**Files:**
- Modify: `src/harness/README.md`
- Modify: `src/coding-agent/README.md`
- Modify: `src/agent/README.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify public or test files only if the stale scan reveals a real missed migration.

**Interfaces:**
- Documents the final Task 1–4 contracts without adding new APIs.

- [ ] **Step 1: Rewrite Harness README progressively**

Explain in this order:

1. Session header, conversation-tree records, and Session-level title records;
2. `directory + cwd`, and why Harness receives one resolved cwd;
3. immediate Session persistence, `SessionInfo`, stored `updatedAt`, and Repository ordering;
4. automatic title timing as a background Session auxiliary task;
5. complete final Harness public API.

- [ ] **Step 2: Rewrite coding-agent README progressively**

Assume the reader understands Harness, then explain:

1. Project as stable logical identity;
2. `directories` and `primaryDirectory`, without a Workspace concept;
3. registered-directory, Git, and non-Git discovery;
4. many Sessions with Session-specific cwd;
5. `createProject()`, Session selection, and atomic `Project.update()`;
6. coding prompt, Tools, Hooks, interactions, and Tool presentation;
7. title-generator assembly;
8. complete public API and folder responsibilities.

- [ ] **Step 3: Align root README and architecture**

Use the same core narrative everywhere: AI performs one LLM request, Agent Loop performs one Agent Run, Harness drives one Session, and coding-agent manages one Project containing Sessions and source directories. State that WebUI/network transport is not part of this implementation.

- [ ] **Step 4: Run stale-contract scans**

Run:

```powershell
rg -n "\bCodingAgent\b|\bCodingProject\b|\bCreateCodingAgentConfig\b|\bcreateCodingAgent\b|\bworkDir\b|persistent session delays|title.*null" src tests README.md docs/architecture.md
rg -n "Session\.create\([^,\)]*\)|Session\.inMemory\(\)" src tests
```

Expected: no old public name, old delayed-persistence statement, nullable title, or metadata-free Session constructor remains. Historical specs and plans may mention superseded names only when explicitly marked as history.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm run typecheck
npm test
git diff --check
```

Expected: all commands exit 0 and every test passes.

- [ ] **Step 6: Commit docs and any narrowly scoped cleanup**

```powershell
git add -- src/agent/README.md src/harness/README.md src/coding-agent/README.md README.md docs/architecture.md
git commit -m "docs: explain projects and session metadata"
```

- [ ] **Step 7: Verify repository scope**

Run:

```powershell
git status --short
git log -6 --oneline
```

Expected: only pre-existing user-owned hooks/tools path-organization changes remain uncommitted; the implementation commits and this plan commit are visible, with no unrelated files included.
