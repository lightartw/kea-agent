# Project Session Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Harness own one Session, make `SessionRepository` own Session discovery, and make `CodingAgent` manage one code Project and create a Harness for each selected Session.

**Architecture:** `Session` remains the durable conversation object and `AgentHarness` remains its runtime driver. A concrete Harness-level `SessionRepository` owns one `storageDir`; the Coding Agent factory owns one Repository plus project-wide coding definitions, and returns a project-level `CodingAgent` whose Session methods create independent Harness instances. The CLI selects one Harness from the Coding Agent and passes both to the frontend.

**Tech Stack:** TypeScript 7, Node.js 24, native `node:test`, JSONL Session persistence, TypeBox.

## Global Constraints

- Do not add `CodingSessionRuntime`, a Project Manager, a Repository interface/implementation pair, or a current-Harness cache.
- Keep `createCodingAgent()` as the public factory.
- `SessionRepository` exposes only `create()`, `open(sessionId)`, and `list()`; `continueRecent()` belongs to Coding Agent.
- `AgentHarness` exposes only the bound Session identity through `sessionId`; it must not expose the writable `Session` object.
- A new Harness gets independent Tool, Hook, Event, model, and run state.
- Preserve the current delayed disk persistence rule: a new Session file appears only after an assistant message has been persisted.
- Do not retain aliases for `SessionManager`, `HarnessProject`, or `CodingAgentRuntime`.
- Rewrite both README files progressively, without images, diagrams, or discussion-only phrases such as “不再……只……”.
- Preserve unrelated user changes and commit each completed task separately.

---

## Target File Structure

```text
src/harness/
  agent-harness.ts
  index.ts
  README.md
  session/
    repository.ts
    session.ts
    types.ts

src/coding-agent/
  factory.ts
  index.ts
  README.md
  types.ts
  ... existing hooks, tools, and ui modules

src/ui/
  cli-frontend.ts

tests/harness/
  agent-harness.test.ts
  session-repository.test.ts
  session.test.ts

tests/coding-agent/
  factory.test.ts

tests/ui/
  cli-frontend.test.ts
```

`repository.ts` owns multi-Session discovery and delegates single-Session creation/opening to `Session`. `factory.ts` remains the Coding Agent composition root. No new runtime or manager file is introduced.

---

### Task 1: Replace SessionManager with SessionRepository

**Files:**
- Rename: `tests/harness/session-manager.test.ts` → `tests/harness/session-repository.test.ts`
- Rename: `src/harness/session/manager.ts` → `src/harness/session/repository.ts`
- Modify: `src/harness/index.ts`

**Interfaces:**
- Consumes: `Session.create(storageDir)`, `Session.open(storageDir, sessionId)`, and `sessionsDir(storageDir)`.
- Produces:

```ts
export class SessionRepository {
  constructor(readonly storageDir: string);
  create(): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<readonly string[]>;
}
```

- [ ] **Step 1: Rename the test and write the Repository contract tests**

Rename the test file, import `SessionRepository` from `session/repository.js`, replace the `manager()` helper, and remove the two `continueRecent` tests. Keep the existing empty-directory, ordering, ignored-file, and invalid-ID cases under the new `list()` name. Add exact create/open coverage:

```ts
function repository(storageDir: string): SessionRepository {
  return new SessionRepository(storageDir);
}

test("create returns a Session owned by this repository", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await repository(storageDir).create();
    assert.ok(session.id.length > 0);
    assert.deepEqual(session.buildContext().messages, []);
    assert.deepEqual(await repository(storageDir).list(), []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open restores a persisted Session by id", async () => {
  const storageDir = await tempStorage();
  try {
    const created = await createPersistedSession(storageDir);
    const opened = await repository(storageDir).open(created.id);
    assert.equal(opened.id, created.id);
    assert.deepEqual(
      opened.buildContext().messages.map((message) => message.role),
      ["user", "assistant"],
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
```

The empty `list()` assertion after `create()` deliberately preserves the current delayed persistence rule.

- [ ] **Step 2: Run the focused build to verify the new API fails**

Run:

```powershell
npm run build
```

Expected: FAIL because `session/repository.ts` and `SessionRepository` do not exist yet.

- [ ] **Step 3: Implement the concrete Repository**

Rename the source file and replace its public surface with:

```ts
export class SessionRepository {
  constructor(readonly storageDir: string) {}

  create(): Promise<Session> {
    return Session.create(this.storageDir);
  }

  open(sessionId: string): Promise<Session> {
    return Session.open(this.storageDir, sessionId);
  }

  async list(): Promise<readonly string[]> {
    const dir = sessionsDir(this.storageDir);
    // Preserve the current filtering, stat fallback, and newest-first sort.
  }
}
```

Remove the `HarnessProject` import and `continueRecent()`. Rename `listSessions()` to `list()` without changing its filtering or error normalization. Update `src/harness/index.ts`:

```ts
export { SessionRepository } from "./session/repository.js";
```

and delete the `SessionManager` export.

- [ ] **Step 4: Run focused Repository tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/session-repository.test.js
```

Expected: all Repository tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/harness/session/repository.ts src/harness/session/manager.ts src/harness/index.ts tests/harness/session-repository.test.ts tests/harness/session-manager.test.ts
git commit -m "refactor: replace session manager with repository"
```

---

### Task 2: Expose the Harness Session Identity

**Files:**
- Modify: `src/harness/agent-harness.ts`
- Modify: `tests/harness/agent-harness.test.ts`

**Interfaces:**
- Consumes: private `AgentHarness.session: Session` and `Session.id`.
- Produces: `AgentHarness.sessionId: string` as read-only identity; no writable Session exposure.

- [ ] **Step 1: Write the failing identity test**

Add this test beside the existing construction/state tests:

```ts
test("sessionId exposes the bound Session identity", () => {
  const session = Session.inMemory();
  const harness = createHarness({ session });

  assert.equal(harness.sessionId, session.id);
});
```

Use the test file's existing Harness helper; extend it to accept a supplied `session` if needed. TypeScript
`private` fields remain ordinary runtime properties after compilation, so do not test property reflection. The
public API boundary is protected by adding only the `sessionId` getter and no public `session` getter.

- [ ] **Step 2: Run the focused build to verify it fails**

Run:

```powershell
npm run build
```

Expected: FAIL because `AgentHarness` has no public `sessionId`.

- [ ] **Step 3: Add the minimal getter**

Add to the state section of `AgentHarness`:

```ts
get sessionId(): string {
  return this.session.id;
}
```

Do not change Session persistence or add a `session` getter.

- [ ] **Step 4: Run focused Harness tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/agent-harness.test.js
```

Expected: all Harness tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/harness/agent-harness.ts tests/harness/agent-harness.test.ts
git commit -m "feat: expose harness session identity"
```

---

### Task 3: Make createCodingAgent Return a Project-Level CodingAgent

**Files:**
- Modify: `src/harness/types.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/coding-agent/types.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `tests/coding-agent/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Consumes: `SessionRepository`, `AgentHarness`, current Tool definitions, permission Hook, interactions, and presentation registry.
- Produces:

```ts
export interface CodingProject {
  readonly workDir: string;
  readonly storageDir: string;
}

export interface CreateCodingAgentConfig {
  readonly project: CodingProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly interactions?: CodingAgentInteractions;
  readonly onEventListenerError?: HarnessListenerErrorHandler;
}

export interface CodingAgent {
  listSessions(): Promise<readonly string[]>;
  createSession(): Promise<AgentHarness>;
  openSession(sessionId: string): Promise<AgentHarness>;
  continueRecent(): Promise<AgentHarness>;
  renderToolEvent(event: HarnessToolEvent): string;
}

export function createCodingAgent(
  config: CreateCodingAgentConfig,
): Promise<CodingAgent>;
```

- [ ] **Step 1: Convert factory tests to the project-level usage**

Remove direct `Session` injection from every factory call. Each test creates a temporary `storageDir`, then follows this pattern:

```ts
const codingAgent = await createCodingAgent({
  project: { workDir: process.cwd(), storageDir },
  streamFn,
  model,
});
const harness = await codingAgent.createSession();
await harness.prompt("hello");
```

Replace `runtime.harness` with the returned `harness` and `runtime.renderToolEvent` with
`codingAgent.renderToolEvent`. For restoration tests, persist through the first Harness and reopen through
`codingAgent.openSession(first.sessionId)` instead of calling `Session.open()` directly.

Add these contract tests:

```ts
test("CodingAgent lists, creates, opens, and continues project Sessions", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });

    assert.deepEqual(await codingAgent.listSessions(), []);

    const created = await codingAgent.createSession();
    await created.prompt("persist me");
    assert.deepEqual(await codingAgent.listSessions(), [created.sessionId]);

    const opened = await codingAgent.openSession(created.sessionId);
    assert.equal(opened.sessionId, created.sessionId);
    assert.deepEqual(opened.messages.map((message) => message.role), ["user", "assistant"]);

    const continued = await codingAgent.continueRecent();
    assert.equal(continued.sessionId, created.sessionId);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("continueRecent creates a Session when the project has no history", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });
    const harness = await codingAgent.continueRecent();
    assert.ok(harness.sessionId.length > 0);
    assert.deepEqual(harness.messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("Harnesses created for one Project do not share mutable state", async () => {
  const storageDir = await tempStorage();
  try {
    const codingAgent = await createCodingAgent({
      project: { workDir: process.cwd(), storageDir },
      streamFn: oneTurnStream,
      model,
    });
    const first = await codingAgent.createSession();
    const second = await codingAgent.createSession();

    await first.switchModel({ provider: "test", model: "other" });
    assert.deepEqual(second.model, model);

    const secondEvents: string[] = [];
    second.subscribe((event) => { secondEvents.push(event.type); });
    await first.prompt("only first");
    assert.deepEqual(secondEvents, []);
    assert.deepEqual(second.messages, []);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
```

Keep the existing assertions for default Tools, prompt formatting, permission behavior, Todo content/details,
and presentation. They now run through a Harness returned by the project-level object.

- [ ] **Step 2: Update import-smoke expectations before implementation**

In `tests/import-smoke.test.ts`:

- replace the value import `SessionManager` with `SessionRepository`;
- replace `CodingAgentRuntime` type imports with `CodingAgent`;
- add `CodingProject` to the public Coding Agent type tuple;
- delete the second direct `CodingAgentRuntimeFromTypes` alias check;
- retain `CreateCodingAgentConfig` and the other public contracts.

The type tuple must include:

```ts
type PublicCodingAgentTypes = [
  CodingAgent,
  CodingProject,
  CreateCodingAgentConfig,
  CodingAgentInteractions,
  CodingToolContext,
  CodingToolDefinition,
  CodingToolPresentation<unknown, unknown>,
  ConfirmationRequest,
  Notification,
  TodoDetails,
  TodoItem,
  ToolPresentationCall<unknown>,
  ToolPresentationRejected<unknown>,
];
```

- [ ] **Step 3: Run the build to verify the public API migration fails**

Run:

```powershell
npm run build
```

Expected: FAIL on the removed `session` input and missing `CodingAgent`/`CodingProject` APIs.

- [ ] **Step 4: Define the project-level types and remove HarnessProject**

Delete `HarnessProject` from `src/harness/types.ts` and its export from `src/harness/index.ts`.

Replace `src/coding-agent/types.ts` with the interfaces shown in this task. Import `AgentHarness`,
`SystemPromptBuilder`, `HarnessListenerErrorHandler`, `HarnessToolEvent`, `StreamFn`, `ModelConfig`, and
`CodingAgentInteractions` from their owning modules. Do not import `Session` or `HarnessProject`.

Update `src/coding-agent/index.ts` to export `CodingAgent`, `CodingProject`, and
`CreateCodingAgentConfig`, and remove `CodingAgentRuntime`.

- [ ] **Step 5: Refactor the factory around one Repository and one Harness builder**

At factory creation time resolve both Project paths once:

```ts
const project: CodingProject = {
  workDir: resolve(config.project.workDir),
  storageDir: resolve(config.project.storageDir),
};
const repository = new SessionRepository(project.storageDir);
```

Create Tool definitions and the presentation registry once. Define a package-local builder that allocates
all mutable Harness dependencies per Session:

```ts
function createHarness(session: Session): AgentHarness {
  const tools = new AgentToolRegistry();
  for (const definition of definitions) {
    tools.register(toAgentTool(definition, { cwd: project.workDir }));
  }

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: tools,
    systemPrompt,
    cwd: project.workDir,
    hooks: createPermissionHooks(interactions),
    ...(config.onEventListenerError !== undefined
      ? { onEventListenerError: config.onEventListenerError }
      : {}),
  });
}
```

Return the project-level object:

```ts
return {
  listSessions: () => repository.list(),
  createSession: async () => createHarness(await repository.create()),
  openSession: async (sessionId) => createHarness(await repository.open(sessionId)),
  continueRecent: async () => {
    const [sessionId] = await repository.list();
    return sessionId === undefined
      ? createHarness(await repository.create())
      : createHarness(await repository.open(sessionId));
  },
  renderToolEvent: (event) => presentations.render(event),
};
```

Do not store any returned Harness in the Coding Agent. Do not swallow an `open()` error from the newest ID.

- [ ] **Step 6: Run Coding Agent and import-smoke tests**

Run:

```powershell
npm run build
node --test dist/tests/coding-agent/factory.test.js dist/tests/import-smoke.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/harness/types.ts src/harness/index.ts src/coding-agent/types.ts src/coding-agent/factory.ts src/coding-agent/index.ts tests/coding-agent/factory.test.ts tests/import-smoke.test.ts
git commit -m "refactor: make coding agent project scoped"
```

---

### Task 4: Migrate the CLI to Select and Run One Harness

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/cli-frontend.ts`
- Modify: `tests/ui/cli-frontend.test.ts`

**Interfaces:**
- Consumes: project-level `CodingAgent`, selected `AgentHarness`, `CodingAgentInteractions`.
- Produces:

```ts
CliFrontend.run(
  codingAgent: CodingAgent,
  harness: AgentHarness,
): Promise<void>;
```

- [ ] **Step 1: Rewrite the CLI test around separate project and Session objects**

Replace the `CodingAgentRuntime` stub with two typed stubs:

```ts
const harness = {
  subscribe() { return () => undefined; },
  abort() { aborts++; },
  async prompt() {
    assert.equal(input.listenerCount("data"), 1);
    assert.equal(await cli.interactions.confirm(confirmation), true);
    assert.equal(input.listenerCount("data"), 1);
    assert.equal(input.rawModes.at(-1), true);
    input.emit("data", Buffer.from([0x1b]));
  },
} as unknown as AgentHarness;

const codingAgent = {
  renderToolEvent: () => "tool",
} as unknown as CodingAgent;

await cli.run(codingAgent, harness);
```

Import `CodingAgent` and `AgentHarness` from their public package entries.

- [ ] **Step 2: Run the build to verify the CLI signature fails**

Run:

```powershell
npm run build
```

Expected: FAIL because `CliFrontend.run()` still accepts `CodingAgentRuntime`.

- [ ] **Step 3: Update CliFrontend without adding a UI runtime wrapper**

Change the signature and replace all `runtime.*` usage:

```ts
async run(codingAgent: CodingAgent, harness: AgentHarness): Promise<void> {
  const renderer = new CliHarnessRenderer(
    { write: this.writeFn, log: this.logFn },
    (event) => codingAgent.renderToolEvent(event),
  );
  const unsubscribe = harness.subscribe((event) => {
    renderer.render(event);
  });
  // Existing input loop uses harness.abort() and harness.prompt(query).
}
```

The frontend owns only the selected Harness reference for the duration of `run()`; it does not mutate Coding
Agent or invent a current-Session field.

- [ ] **Step 4: Change main to select the recent Session through CodingAgent**

Delete the direct `Session` import and change startup to:

```ts
const codingAgent = await createCodingAgent({
  project,
  streamFn: stream,
  model: defaultModel,
  interactions: cli.interactions,
});
const harness = await codingAgent.continueRecent();
await cli.run(codingAgent, harness);
```

Keep `resolveProject()` and the remaining startup/error behavior unchanged.

- [ ] **Step 5: Run UI, main, and import tests**

Run:

```powershell
npm run build
node --test dist/tests/ui/cli-frontend.test.js dist/tests/main.test.js dist/tests/import-smoke.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/main.ts src/ui/cli-frontend.ts tests/ui/cli-frontend.test.ts
git commit -m "refactor: select project sessions before cli run"
```

---

### Task 5: Rewrite the Harness README Around Session Ownership

**Files:**
- Rewrite: `src/harness/README.md`
- Modify: `src/agent/README.md`

**Interfaces:**
- Consumes: final exports from `src/harness/index.ts` and actual `AgentHarness`, `Session`,
  `SessionRepository`, Event Bus, Hook, and Tool behavior.
- Produces: a progressive Harness README whose public inventory exactly matches the package entry.

- [ ] **Step 1: Rewrite the Harness opening and minimal example**

The first paragraphs must establish this minimum model:

```md
一次 `StreamFn` 调用完成一次 LLM 请求；一次 `runAgentLoop()` 调用完成一次 Agent Run；
`AgentHarness` 驱动一个 Session，在同一份会话历史中执行多次 Run。

- Session 保存会话数据；
- AgentHarness 运行这个 Session；
- SessionRepository 创建、打开和列举多个 Session。
```

Follow it with one in-memory example that creates `Session.inMemory()`, `AgentHarness`, one subscription,
and one `prompt()`. Do not introduce Repository in the first example.

- [ ] **Step 2: Explain prompt, Session, Repository, then Event Bus**

Use this exact progression:

1. one `prompt()` may contain several LLM requests and Tool calls;
2. Harness persists new messages and preserves the Session for the next Run;
3. Session owns data and `buildContext()` reconstruction;
4. Repository owns `create/open/list` across Session files;
5. Event Bus reports facts through `subscribe`, while Hook controls pre-commit behavior.

The Repository example must use only public API:

```ts
const repository = new SessionRepository(".kea");
const session = await repository.create();
const ids = await repository.list();
const restored = await repository.open(ids[0]!);
```

State explicitly that `AgentHarness` does not hold the Repository and that `sessionId` identifies its bound
Session without exposing the writable object.

- [ ] **Step 3: Finish configuration, source layout, and complete export inventory**

Explain Harness consumption of `StreamFn`, model, Tool Registry, Hook Trigger, system prompt builder, and cwd.
List every export from `src/harness/index.ts`, grouped into values and types. Include
`AgentHarness.sessionId`; remove `SessionManager` and `HarnessProject` everywhere.

Update the stale Harness export inventory in `src/agent/README.md` to use `SessionRepository` and remove
`HarnessProject`. Add `sessionId` to its short `AgentHarness` interface excerpt.

- [ ] **Step 4: Verify documentation against code**

Run:

```powershell
rg -n "SessionManager|HarnessProject|CodingAgentRuntime|runtime\.harness" src/harness/README.md src/agent/README.md
rg -n "AgentHarness|SessionRepository|sessionId|HarnessEventBus|HarnessConfig" src/harness/README.md
git diff --check
```

Expected: the first command returns no matches; the second shows each public core concept; diff check is clean.

- [ ] **Step 5: Commit**

```powershell
git add src/harness/README.md src/agent/README.md
git commit -m "docs: explain harness through sessions"
```

---

### Task 6: Rewrite the Coding Agent README and Architecture Documentation

**Files:**
- Rewrite: `src/coding-agent/README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: final `CodingAgent`, `CodingProject`, Session methods, Tool/Hook/UI boundaries, and CLI signature.
- Produces: documentation matching the project-level API and a repository-wide stale-reference audit.

- [ ] **Step 1: Rewrite the Coding Agent README progressively**

Assume the reader already understands Harness. Open with:

```md
Coding Agent 管理一个代码 Project。一个 Project 包含工作目录和一组 Session；每个打开的
Session 由独立的 AgentHarness 驱动。

Coding Agent 给 Harness 提供完成代码任务所需的各种能力：

- coding system prompt；
- Tools：Bash、文件、Glob 和 Todo；
- Hooks：如 permission Hook；
- UI 接口：confirm、notify 和工具展示。
```

Then cover, in order:

1. `CodingProject.workDir/storageDir`;
2. minimal `createCodingAgent()` plus `continueRecent()` usage;
3. `listSessions/createSession/openSession/continueRecent`;
4. per-Session Harness assembly;
5. Bash and file/Glob behavior;
6. stateless Todo with Session-persisted `content/details`;
7. Hook, interactions, Harness Event, and presentation;
8. source layout and complete public API.

Do not repeat the Event Bus implementation already taught by Harness README. Do not use diagrams or the old
Runtime vocabulary.

- [ ] **Step 2: Update architecture.md to the same ownership model**

Replace:

- `SessionManager` with `SessionRepository(create/open/list)`;
- `HarnessProject` with Coding Agent-owned `CodingProject`;
- `CodingAgentRuntime` with project-level `CodingAgent`;
- direct `Session.create` startup with `codingAgent.continueRecent()`;
- `CliFrontend.run(runtime)` with `run(codingAgent, harness)`.

Document that `AgentHarness` binds one Session and exposes `sessionId`, while Repository manages the set. Keep
the existing Hook/Event/Tool/UI boundary text where it remains accurate.

- [ ] **Step 3: Verify every public inventory and remove current-code stale references**

Run:

```powershell
rg -n "SessionManager|HarnessProject|CodingAgentRuntime|runtime\.harness|runtime\.renderToolEvent|session/manager" src tests docs/architecture.md --glob '!docs/superpowers/**'
rg -n "CodingAgent|CodingProject|SessionRepository|continueRecent|renderToolEvent" src/coding-agent/README.md docs/architecture.md
git diff --check
```

Expected: the first command returns no matches. The second confirms every new public concept is documented.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm test
npm run typecheck
git diff --check
git status --short
```

Expected:

- all tests PASS;
- typecheck exits 0;
- diff check prints nothing;
- status shows only the intended documentation changes before commit.

- [ ] **Step 5: Commit**

```powershell
git add src/coding-agent/README.md docs/architecture.md
git commit -m "docs: explain coding agent through projects"
```

---

## Final Review Checklist

- [ ] `SessionRepository` is the only multi-Session Harness entity.
- [ ] `AgentHarness` binds exactly one Session and exposes only `sessionId`.
- [ ] `CodingAgent` owns Project-level Session selection and returns `AgentHarness` directly.
- [ ] No Session Runtime, current-Harness state, Repository abstraction pair, or compatibility alias exists.
- [ ] Every Harness allocation creates independent mutable Tool, Hook, Event, model, and run state.
- [ ] CLI startup selects a Session through Coding Agent.
- [ ] Harness README independently teaches Session, Repository, and Event Bus.
- [ ] Coding Agent README builds on Harness and teaches Project, Tools, Hooks, and UI seams.
- [ ] `src/harness/index.ts` and `src/coding-agent/index.ts` exactly match their README inventories.
- [ ] Full tests, typecheck, stale scan, and diff check pass on a clean worktree.
