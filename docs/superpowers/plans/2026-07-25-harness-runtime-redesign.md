# Harness Runtime Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current hook-driven, pull-stream Harness with a small session runtime that internally consumes Agent events, persists stable messages, and exposes `Promise<void> + subscribe`.

**Architecture:** `AgentHarness.prompt()` is the single runtime core. It owns the full active-run lifecycle, incrementally reconciles Agent transcript messages into a tree-backed Session, and publishes already-persisted `AgentEvent`s to awaited subscribers. `factory.ts` is the Coding Agent composition root; concrete tools and the coding prompt never enter the generic Harness core.

**Tech Stack:** TypeScript 7, Node.js 24 ESM, Node test runner, JSONL persistence, TypeBox tool schemas.

## Global Constraints

- Implement the approved spec at `docs/superpowers/specs/2026-07-25-harness-runtime-redesign-design.md`.
- Preserve all pre-existing uncommitted AI/Agent/README changes; do not reset, overwrite, stage, or commit unrelated files.
- Do not add Harness hooks, `on()`, EventBus, plugins, queues, retry, compaction, branching APIs, skills, or prompt templates.
- Do not change `Agent.prompt()` or `runAgentLoop()` from their existing `AsyncIterable<AgentEvent>` contracts.
- Do not add pure-renaming aliases such as `HarnessEvent`, `HarnessMessage`, `HarnessModelConfig`, or `HarnessStreamFn`.
- Harness runtime files must not import concrete coding tools or `CODING_SYSTEM_PROMPT`; only `factory.ts` may compose those defaults.
- `project.workDir` is the only Harness cwd source.
- `CreateHarnessConfig.model` remains required; provider/default-model selection stays in `ai.createStreamFn()`.
- Use TDD for each task and commit only the files listed for that task.
- Use `apply_patch` for hand-written file changes.

---

## File Map

### Create

- `src/harness/types.ts` — Harness configs, listener types, and system-prompt types.
- `src/harness/factory.ts` — high-level Coding Agent composition.
- `src/harness/coding-system-prompt.ts` — `CODING_SYSTEM_PROMPT` only.
- `src/harness/session/types.ts` — Session entries, context, and `SessionError`.
- `tests/harness/session.test.ts` — Session persistence, validation, and rollback.
- `tests/harness/agent-harness.test.ts` — core prompt/subscription/state behavior.
- `tests/harness/factory.test.ts` — Coding factory composition and restored sessions.
- `tests/harness/tools/todo-write.test.ts` — Todo tool instance isolation.

### Rewrite or modify

- `src/harness/session/session.ts` — validated append-only tree and delayed JSONL persistence.
- `src/harness/agent-harness.ts` — core class only; no config declarations, hooks, or factory.
- `src/harness/system-prompt.ts` — generic format/builder helpers only.
- `src/harness/tools/bash.ts` — single authoritative Bash safety policy.
- `src/harness/tools/todo-write.ts` — instance-owned state.
- `src/harness/tools/factory.ts` — explicit cwd, fresh default tools.
- `src/harness/tools/index.ts` — remove internal/global exports.
- `src/harness/index.ts` — complete intended Harness public surface.
- `src/index.ts` — remove Hook exports and expose the revised Harness entry.
- `src/cli/frontend.ts` — subscribe once and await `prompt()`.
- `src/main.ts` — import `createHarness` from its new module.
- `src/harness/README.md` — complete public API and dependency documentation.
- `tests/harness/tools/bash.test.ts` — consolidated policy and backend non-execution.
- `tests/harness/tools/factory.test.ts` — explicit cwd/default tool set.
- `tests/import-smoke.test.ts` — public export smoke coverage.

### Delete

- `src/harness/hooks/context-inject.ts`
- `src/harness/hooks/factory.ts`
- `src/harness/hooks/log.ts`
- `src/harness/hooks/permission.ts`
- `src/harness/hooks/registry.ts`
- `src/harness/hooks/summary.ts`
- `src/harness/hooks/todo-reminder.ts`
- `src/harness/hooks/types.ts`
- `tests/agent/hooks/registry.test.ts`
- `tests/harness/permission.test.ts`

---

### Task 1: Make Session a reliable validated tree

**Files:**

- Create: `src/harness/session/types.ts`
- Create: `tests/harness/session.test.ts`
- Rewrite: `src/harness/session/session.ts`
- Modify temporarily for signature compatibility: `src/harness/agent-harness.ts`

**Interfaces:**

- Consumes: `AgentMessage` from `src/agent/types.ts`; `ModelConfig` from `src/ai/types.ts`.
- Produces:

```ts
export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
  | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
}

export interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}

export class Session {
  readonly id: string;
  static create(storageDir: string): Promise<Session>;
  static open(storageDir: string, sessionId: string): Promise<Session>;
  static inMemory(): Session;
  appendMessage(message: AgentMessage): Promise<void>;
  appendModelChange(model: ModelConfig): Promise<void>;
  buildContext(): SessionContext;
}
```

- The raw `SessionEntry` union stays module-internal to the Harness package entry.

- [ ] **Step 1: Write Session behavior tests**

Create `tests/harness/session.test.ts` with concrete message fixtures and temp-directory cleanup:

```ts
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/types.js";
import type { ModelConfig } from "../../src/ai/types.js";
import { Session } from "../../src/harness/session/session.js";
import { SessionError } from "../../src/harness/session/types.js";

const modelA: ModelConfig = { provider: "test-a", model: "model-a" };
const modelB: ModelConfig = { provider: "test-b", model: "model-b" };
const user: AgentMessage = { role: "user", content: "hello" };
const assistant: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "world" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

async function tempStorage(): Promise<string> {
  const path = join(tmpdir(), `kea-session-${randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test("in-memory session rebuilds messages and latest model", async () => {
  const session = Session.inMemory();
  await session.appendModelChange(modelA);
  await session.appendMessage(user);
  await session.appendModelChange(modelB);
  await session.appendMessage(assistant);

  assert.deepEqual(session.buildContext(), {
    messages: [user, assistant],
    model: modelB,
  });
});

test("persistent session delays file creation until first assistant", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir);
    const path = join(storageDir, "sessions", `${session.id}.jsonl`);
    await session.appendMessage(user);
    await assertMissing(path);

    await session.appendMessage(assistant);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).type), [
      "message",
      "message",
    ]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("persistent session appends entries after first assistant", async () => {
  const storageDir = await tempStorage();
  try {
    const session = await Session.create(storageDir);
    await session.appendMessage(user);
    await session.appendMessage(assistant);
    await session.appendModelChange(modelB);

    const reopened = await Session.open(storageDir, session.id);
    assert.deepEqual(reopened.buildContext(), {
      messages: [user, assistant],
      model: modelB,
    });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects missing, empty, malformed, and invalid-entry sessions", async () => {
  const storageDir = await tempStorage();
  const sessionsDir = join(storageDir, "sessions");
  try {
    await mkdir(sessionsDir, { recursive: true });

    await assert.rejects(
      Session.open(storageDir, "missing"),
      (error: unknown) => error instanceof SessionError && error.code === "not_found",
    );

    await writeFile(join(sessionsDir, "empty.jsonl"), "");
    await assert.rejects(
      Session.open(storageDir, "empty"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(join(sessionsDir, "bad-json.jsonl"), "{");
    await assert.rejects(
      Session.open(storageDir, "bad-json"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_session",
    );

    await writeFile(
      join(sessionsDir, "bad-entry.jsonl"),
      `${JSON.stringify({ type: "unknown", id: "x", parentId: null })}\n`,
    );
    await assert.rejects(
      Session.open(storageDir, "bad-entry"),
      (error: unknown) => error instanceof SessionError && error.code === "invalid_entry",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("open rejects session ids that can escape the sessions directory", async () => {
  const storageDir = await tempStorage();
  try {
    await assert.rejects(
      Session.open(storageDir, "../outside"),
      (error: unknown) =>
        error instanceof SessionError && error.code === "invalid_session",
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("failed first flush rolls back the assistant entry and leaf", async () => {
  const storageDir = await tempStorage();
  const session = await Session.create(storageDir);
  await session.appendMessage(user);
  await rm(join(storageDir, "sessions"), { recursive: true, force: true });

  await assert.rejects(session.appendMessage(assistant));
  assert.deepEqual(session.buildContext().messages, [user]);

  await rm(storageDir, { recursive: true, force: true });
});

test("buildContext returns a new messages array", async () => {
  const session = Session.inMemory();
  await session.appendMessage(user);
  const first = session.buildContext();
  first.messages.push(assistant);
  assert.deepEqual(session.buildContext().messages, [user]);
});
```

Add this branch-selection test:

```ts
test("buildContext follows the current leaf parent chain", async () => {
  const storageDir = await tempStorage();
  const sessionsDir = join(storageDir, "sessions");
  const currentAssistant: AgentMessage = {
    ...assistant,
    content: [{ type: "text", text: "current branch" }],
  };
  try {
    await mkdir(sessionsDir, { recursive: true });
    const entries = [
      { type: "message", id: "root", parentId: null, message: user },
      {
        type: "message",
        id: "abandoned",
        parentId: "root",
        message: assistant,
      },
      {
        type: "message",
        id: "current",
        parentId: "root",
        message: currentAssistant,
      },
    ];
    await writeFile(
      join(sessionsDir, "branched.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const session = await Session.open(storageDir, "branched");
    assert.deepEqual(session.buildContext().messages, [user, currentAssistant]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new test to verify the old Session fails**

Run:

```powershell
npm run build
```

Expected: TypeScript fails because `session/types.ts` and `appendModelChange(model)` do not exist.

- [ ] **Step 3: Define Session types and error contract**

Create `src/harness/session/types.ts` with the exact interfaces from the approved spec:

```ts
import type { AgentMessage } from "../../agent/types.js";
import type { ModelConfig } from "../../ai/types.js";

export interface SessionEntryBase {
  readonly id: string;
  readonly parentId: string | null;
}

export interface SessionMessageEntry extends SessionEntryBase {
  readonly type: "message";
  readonly message: AgentMessage;
}

export interface SessionModelChangeEntry extends SessionEntryBase {
  readonly type: "model_change";
  readonly provider: string;
  readonly modelId: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | SessionModelChangeEntry;

export interface SessionContext {
  readonly messages: AgentMessage[];
  readonly model: ModelConfig | null;
}

export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
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

- [ ] **Step 4: Rewrite Session with validation, delayed flush, and rollback**

In `src/harness/session/session.ts`:

- validate IDs with `/^[A-Za-z0-9_-]+$/`;
- distinguish ENOENT from invalid content;
- parse every nonblank line and validate `type`, `id`, `parentId`, message/model fields;
- throw `invalid_session` for an empty file or JSON syntax failure;
- throw `invalid_entry` for structurally invalid/unknown entries;
- keep `entries`, `byId`, and `leafId`;
- make `appendModelChange(model: ModelConfig)` store only provider and `model.model`;
- remove `messages()`;
- on append failure, `pop()` the entry, delete its ID, and restore the previous leaf;
- use `writeFile(path, allLines, { encoding: "utf8", flag: "wx" })` for the first flush and `appendFile()` afterwards;
- return a fresh top-level messages array from `buildContext()`.

Temporarily update the current `AgentHarness.switchModel()` call to:

```ts
await this.session.appendModelChange(config);
```

This temporary edit keeps the tree compiling until Task 3 rewrites the class.

- [ ] **Step 5: Build and run Session tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/session.test.js
```

Expected: build succeeds and all Session tests pass.

- [ ] **Step 6: Run the full existing suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit Session**

```powershell
git add src/harness/session/types.ts src/harness/session/session.ts src/harness/agent-harness.ts tests/harness/session.test.ts
git commit -m "refactor: harden harness sessions"
```

---

### Task 2: Put Coding Tool invariants in tool instances

**Files:**

- Modify: `src/harness/tools/bash.ts`
- Modify: `src/harness/tools/todo-write.ts`
- Modify temporarily: `src/harness/hooks/permission.ts`
- Modify: `tests/harness/tools/bash.test.ts`
- Create: `tests/harness/tools/todo-write.test.ts`

**Interfaces:**

- Consumes: existing `BashOperations`, `AgentTool`, and `AgentToolResult`.
- Produces: the same public `BashTool` and `TodoWriteTool` class names; no global Todo access function.
- Transitional constraint: keep the Bash policy helper exported until Task 4 deletes `PermissionHook`; do not add it to the final Harness package export.

- [ ] **Step 1: Add failing tests for the consolidated Bash policy**

Extend `tests/harness/tools/bash.test.ts`:

```ts
import type { BashOperations } from "../../../src/harness/tools/bash.js";

class RecordingBashOperations implements BashOperations {
  calls: string[] = [];

  async exec(command: string): Promise<string> {
    this.calls.push(command);
    return "executed";
  }
}

test("bash tool blocks the complete policy before invoking its backend", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  const commands = [
    "rm file.txt",
    "rm -rf /",
    "sudo true",
    "chmod 777 script.sh",
    "shutdown now",
    "reboot",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=disk.img",
    "echo x > /etc/hosts",
    "echo x > /dev/sda",
  ];

  for (const command of commands) {
    const result = await tool.execute({ command }, signal());
    assert.equal(result.isError, true, command);
    assert.match(result.content, /Permission denied/, command);
  }

  assert.deepEqual(ops.calls, []);
});

test("bash tool invokes its backend for a safe command", async () => {
  const ops = new RecordingBashOperations();
  const tool = new BashTool(process.cwd(), ops);
  assert.deepEqual(
    await tool.execute({ command: "pwd" }, signal()),
    { content: "executed", isError: false },
  );
  assert.deepEqual(ops.calls, ["pwd"]);
});
```

- [ ] **Step 2: Add a failing Todo instance-state test**

Create `tests/harness/tools/todo-write.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  TodoWriteTool,
  type TodoItem,
} from "../../../src/harness/tools/todo-write.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

type InspectableTodoTool = {
  readonly todos: readonly TodoItem[];
};

test("todo state belongs to each tool instance", async () => {
  const first = new TodoWriteTool();
  const second = new TodoWriteTool();

  await first.execute(
    { todos: [{ content: "first", status: "in_progress" }] },
    signal(),
  );

  assert.deepEqual(
    (first as unknown as InspectableTodoTool).todos,
    [{ content: "first", status: "in_progress" }],
  );
  assert.deepEqual((second as unknown as InspectableTodoTool).todos, []);
});
```

The cast is intentionally confined to the unit test; no public getter is added.

- [ ] **Step 3: Run tool tests to verify failure**

Run:

```powershell
npm run build
node --test dist/tests/harness/tools/bash.test.js dist/tests/harness/tools/todo-write.test.js
```

Expected: the Bash test fails for rules currently present only in `PermissionHook`, and the Todo test fails because state is module-global.

- [ ] **Step 4: Consolidate the Bash rule and remove Todo global state**

In `bash.ts`, replace the duplicate fragments with one function that returns a user-facing reason:

```ts
const FORBIDDEN_BASH_FRAGMENTS = [
  "rm ",
  "rm -rf /",
  "sudo",
  "chmod 777",
  "shutdown",
  "reboot",
  "mkfs",
  "dd ",
  "> /etc/",
  "> /dev/",
] as const;

export function blockedBashReason(command: string): string | undefined {
  const fragment = FORBIDDEN_BASH_FRAGMENTS.find((candidate) =>
    command.includes(candidate),
  );
  if (fragment === undefined) return undefined;
  return fragment === "rm "
    ? "file deletion is not allowed"
    : `command contains forbidden fragment '${fragment}'`;
}
```

Call it at the start of `BashTool.execute()` and return:

```ts
{
  content: `Error: Permission denied: ${reason}`,
  isError: true,
}
```

Until Task 4 deletes the Hook subsystem, update `hooks/permission.ts` to delegate to the same helper and delete its separate fragment list:

```ts
import { blockedBashReason } from "../tools/bash.js";

function checkBash(command: unknown): HookResult | undefined {
  if (typeof command !== "string") {
    return block("invalid Bash command");
  }
  const reason = blockedBashReason(command);
  return reason === undefined ? undefined : block(reason);
}
```

In `todo-write.ts`, delete `currentTodos` and `getCurrentTodos()`, add:

```ts
export class TodoWriteTool extends AgentTool<typeof parameters> {
  private todos: readonly TodoItem[] = [];

  async execute(
    arguments_: Static<typeof parameters>,
    _signal: AbortSignal,
  ): Promise<AgentToolResult> {
    this.todos = arguments_.todos;
    const lines = ["\n## Current Tasks"];
    for (const todo of this.todos) {
      const icon = TODO_ICONS[todo.status] ?? " ";
      lines.push(`  [${icon}] ${todo.content}`);
    }
    const formatted = lines.join("\n");
    return {
      content: `${formatted}\n\nUpdated ${this.todos.length} tasks`,
      isError: false,
    };
  }
}
```

- [ ] **Step 5: Run focused and full tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/tools/bash.test.js dist/tests/harness/tools/todo-write.test.js
npm test
```

Expected: all commands succeed.

- [ ] **Step 6: Commit tool invariants**

```powershell
git add src/harness/tools/bash.ts src/harness/tools/todo-write.ts src/harness/hooks/permission.ts tests/harness/tools/bash.test.ts tests/harness/tools/todo-write.test.ts
git commit -m "refactor: localize coding tool state"
```

---

### Task 3: Rewrite AgentHarness around Promise plus subscribe

**Files:**

- Create: `src/harness/types.ts`
- Create: `src/harness/coding-system-prompt.ts`
- Create: `src/harness/factory.ts`
- Create: `tests/harness/agent-harness.test.ts`
- Rewrite: `src/harness/agent-harness.ts`
- Modify: `src/harness/system-prompt.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/cli/frontend.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Consumes: Task 1 `Session`; existing `Agent`, `AgentEvent`, `AgentMessage`, `AgentTool`, `AgentToolRegistry`, `ModelConfig`, and `StreamFn`.
- Produces:

```ts
export class AgentHarness {
  constructor(config: HarnessConfig);
  prompt(input: string): Promise<void>;
  subscribe(listener: HarnessEventListener): Unsubscribe;
  abort(): void;
  switchModel(model: ModelConfig): Promise<void>;
  registerTool(tool: AgentTool): void;
  unregisterTool(name: string): void;
  get messages(): readonly AgentMessage[];
  get model(): ModelConfig;
  get isRunning(): boolean;
}
```

- Produces `createHarness(config: CreateHarnessConfig): Promise<AgentHarness>` so existing application callers compile after the class-only split.

- `agent-harness.ts` must not import `./tools/*` or `CODING_SYSTEM_PROMPT`.

- [ ] **Step 1: Add reusable AgentHarness fixtures and basic failing tests**

Create `tests/harness/agent-harness.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { AgentHarness } from "../../src/harness/agent-harness.js";
import { Session } from "../../src/harness/session/session.js";
import { AgentToolRegistry } from "../../src/agent/tools/registry.js";
import { AgentTool } from "../../src/agent/tools/types.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";
import { Type } from "typebox";

const modelA: ModelConfig = { provider: "test", model: "model-a" };
const modelB: ModelConfig = { provider: "test", model: "model-b" };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

const stream: StreamFn = async function* () {
  yield { type: "text_delta", text: "done" };
  yield { type: "done", message: assistant };
};

function createHarness(options: {
  session?: Session;
  streamFn?: StreamFn;
  systemPrompt?: () => string | Promise<string>;
} = {}): AgentHarness {
  return new AgentHarness({
    session: options.session ?? Session.inMemory(),
    model: modelA,
    streamFn: options.streamFn ?? stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: options.systemPrompt ?? (() => "system"),
    cwd: process.cwd(),
  });
}

test("prompt resolves after publishing Agent events", async () => {
  const harness = createHarness();
  const events: AgentEvent["type"][] = [];
  harness.subscribe((event) => {
    events.push(event.type);
  });

  await harness.prompt("hello");

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "text_delta",
    "turn_end",
    "agent_end",
  ]);
  assert.equal(harness.isRunning, false);
  assert.deepEqual(harness.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
});

test("messages are in Session before subscribers observe their event", async () => {
  const session = Session.inMemory();
  const harness = createHarness({ session });
  harness.subscribe((event) => {
    if (event.type === "turn_start") {
      assert.deepEqual(
        session.buildContext().messages.map((message) => message.role),
        ["user"],
      );
    }
    if (event.type === "turn_end") {
      assert.deepEqual(
        session.buildContext().messages.map((message) => message.role),
        ["user", "assistant"],
      );
    }
  });
  await harness.prompt("hello");
});
```

- [ ] **Step 2: Add subscription ordering, failure, and unsubscribe tests**

Append:

```ts
test("subscribers are awaited in registration order", async () => {
  const harness = createHarness();
  const calls: string[] = [];
  harness.subscribe(async (event) => {
    if (event.type !== "agent_start") return;
    await Promise.resolve();
    calls.push("first");
  });
  harness.subscribe((event) => {
    if (event.type === "agent_start") calls.push("second");
  });

  await harness.prompt("hello");
  assert.deepEqual(calls, ["first", "second"]);
});

test("unsubscribe is idempotent", async () => {
  const harness = createHarness();
  let calls = 0;
  const unsubscribe = harness.subscribe(() => {
    calls++;
  });
  unsubscribe();
  unsubscribe();

  await harness.prompt("hello");
  assert.equal(calls, 0);
});

test("subscription changes take effect on the next event", async () => {
  const harness = createHarness();
  const calls: string[] = [];
  let removeSecond = () => {};
  harness.subscribe((event) => {
    calls.push(`first:${event.type}`);
    removeSecond();
  });
  removeSecond = harness.subscribe((event) => {
    calls.push(`second:${event.type}`);
  });

  await harness.prompt("hello");

  assert.deepEqual(calls.slice(0, 3), [
    "first:agent_start",
    "second:agent_start",
    "first:turn_start",
  ]);
});

test("subscriber failure rejects prompt and restores idle", async () => {
  const harness = createHarness();
  const failure = new Error("listener failed");
  harness.subscribe((event) => {
    if (event.type === "turn_start") throw failure;
  });

  await assert.rejects(harness.prompt("hello"), (error) => error === failure);
  assert.equal(harness.isRunning, false);
});
```

- [ ] **Step 3: Add active-run, abort, model, tool, and prompt-builder tests**

Append tests using a local deferred helper:

```ts
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Harness is busy while an async system prompt is being built", async () => {
  const gate = deferred();
  const harness = createHarness({
    systemPrompt: async () => {
      await gate.promise;
      return "system";
    },
  });

  const first = harness.prompt("first");
  assert.equal(harness.isRunning, true);
  await assert.rejects(harness.prompt("second"), /busy/);
  await assert.rejects(harness.switchModel(modelB), /busy/);
  assert.throws(() => harness.unregisterTool("missing"), /busy/);
  assert.throws(() => harness.registerTool(
    new class extends AgentTool {
      constructor() {
        super("test", "test", Type.Object({}));
      }
      async execute() {
        return { content: "ok", isError: false };
      }
    }(),
  ), /busy/);

  gate.resolve();
  await first;
});

test("abort during prompt preparation prevents the Agent run", async () => {
  const gate = deferred();
  let streamCalls = 0;
  const harness = createHarness({
    systemPrompt: async () => {
      await gate.promise;
      return "system";
    },
    streamFn: async function* () {
      streamCalls++;
      yield { type: "done", message: assistant };
    },
  });

  const run = harness.prompt("hello");
  harness.abort();
  gate.resolve();
  await run;

  assert.equal(streamCalls, 0);
  assert.equal(harness.isRunning, false);
});

test("restores Session model and persists later switches", async () => {
  const session = Session.inMemory();
  await session.appendModelChange(modelB);
  const harness = createHarness({ session });
  assert.deepEqual(harness.model, modelB);

  await harness.switchModel(modelA);
  assert.deepEqual(harness.model, modelA);
  assert.deepEqual(session.buildContext().model, modelA);
});

test("failed model persistence leaves current model unchanged", async () => {
  const session = Session.inMemory();
  const harness = createHarness({ session });
  session.appendModelChange = async () => {
    throw new Error("storage failed");
  };

  await assert.rejects(harness.switchModel(modelB), /storage failed/);
  assert.deepEqual(harness.model, modelA);
});

test("tool changes and async prompt builder affect the next run", async () => {
  let seenTools: string[] = [];
  let seenPrompt = "";
  const registry = new AgentToolRegistry();
  const tool = new class extends AgentTool {
    constructor() {
      super("dynamic", "dynamic", Type.Object({}));
    }
    async execute() {
      return { content: "ok", isError: false };
    }
  }();
  const harness = new AgentHarness({
    session: Session.inMemory(),
    model: modelA,
    streamFn: async function* (_model, context) {
      seenTools = context.tools?.map((entry) => entry.name) ?? [];
      seenPrompt = context.systemPrompt ?? "";
      yield { type: "done", message: assistant };
    },
    toolRegistry: registry,
    systemPrompt: async ({ tools }) => `tools=${tools.map((entry) => entry.name).join(",")}`,
    cwd: process.cwd(),
  });

  harness.registerTool(tool);
  await harness.prompt("first");
  assert.deepEqual(seenTools, ["dynamic"]);
  assert.equal(seenPrompt, "tools=dynamic");

  harness.unregisterTool("dynamic");
  await harness.prompt("second");
  assert.deepEqual(seenTools, []);
  assert.equal(seenPrompt, "tools=");
});
```

Add:

```ts
test("abort during Agent streaming settles the Harness run", async () => {
  const started = deferred();
  const abortedAssistant: AssistantMessage = {
    ...assistant,
    content: [],
    stopReason: "aborted",
    errorMessage: "aborted",
  };
  const harness = createHarness({
    streamFn: async function* (_model, _context, options) {
      const signal = options?.signal;
      assert.ok(signal);
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", message: abortedAssistant };
    },
  });

  const run = harness.prompt("hello");
  await started.promise;
  harness.abort();
  await run;

  assert.equal(harness.isRunning, false);
  const lastMessage = harness.messages.at(-1);
  assert.equal(
    lastMessage?.role === "assistant"
      ? lastMessage.stopReason
      : undefined,
    "aborted",
  );
});
```

- [ ] **Step 4: Run the tests to verify the old Harness API fails**

Run:

```powershell
npm run build
```

Expected: compilation fails because `harness/types.ts`, Promise prompt behavior, subscribe, async builders, and unregisterTool do not exist.

- [ ] **Step 5: Extract public types and split the coding prompt**

Create `src/harness/types.ts` using the exact approved interfaces:

```ts
import type { AgentEvent } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { ModelConfig, StreamFn } from "../ai/types.js";
import type { Session } from "./session/session.js";

export type HarnessEventListener = (
  event: AgentEvent,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface SystemPromptContext {
  readonly model: ModelConfig;
  readonly tools: readonly AgentTool[];
  readonly cwd: string;
  readonly date: Date;
}

export type SystemPromptBuilder = (
  context: SystemPromptContext,
) => string | Promise<string>;

export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly systemPrompt: SystemPromptBuilder;
  readonly cwd: string;
}

export interface HarnessProject {
  readonly workDir: string;
  readonly storageDir: string;
}

export interface CreateHarnessConfig {
  readonly project: HarnessProject;
  readonly streamFn: StreamFn;
  readonly model: ModelConfig;
  readonly session?: Session;
  readonly systemPrompt?: string | SystemPromptBuilder;
}
```

Move `CODING_SYSTEM_PROMPT` unchanged to `coding-system-prompt.ts`. Keep only `formatSystemPrompt()` and `defaultSystemPrompt()` in `system-prompt.ts`, import builder types from `types.ts`, remove `extraContext`, and allow the builder contract to be async.

- [ ] **Step 6: Rewrite AgentHarness as the runtime core**

Replace `agent-harness.ts` with a class-only implementation:

```ts
export class AgentHarness {
  private readonly session: Session;
  private readonly agent: Agent;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly listeners = new Set<HarnessEventListener>();
  private currentModel: ModelConfig;
  private persistedMessageCount: number;
  private running = false;
  private abortRequested = false;

  constructor(config: HarnessConfig) {
    const context = config.session.buildContext();
    this.session = config.session;
    this.toolRegistry = config.toolRegistry;
    this.buildSystemPrompt = config.systemPrompt;
    this.cwd = config.cwd;
    this.currentModel = context.model ?? config.model;
    this.persistedMessageCount = context.messages.length;
    this.agent = new Agent(
      config.streamFn,
      this.currentModel,
      config.toolRegistry,
      context.messages,
    );
  }
}
```

Implement private helpers:

```ts
private assertIdle(): void {
  if (this.running) throw new Error("AgentHarness is busy");
}

private async prepareAgentForRun(): Promise<void> {
  this.agent.model = this.currentModel;
  this.agent.systemPrompt = await this.buildSystemPrompt({
    model: this.currentModel,
    tools: this.toolRegistry.all(),
    cwd: this.cwd,
    date: new Date(),
  });
}

private async persistNewMessages(): Promise<void> {
  while (this.persistedMessageCount < this.agent.messages.length) {
    const message = this.agent.messages[this.persistedMessageCount]!;
    await this.session.appendMessage(message);
    this.persistedMessageCount++;
  }
}

private async publish(event: AgentEvent): Promise<void> {
  for (const listener of [...this.listeners]) {
    await listener(event);
  }
}
```

```ts
async prompt(input: string): Promise<void> {
  this.assertIdle();
  this.running = true;
  this.abortRequested = false;

  try {
    await this.prepareAgentForRun();
    if (this.abortRequested) return;

    for await (const event of this.agent.prompt(input)) {
      await this.persistNewMessages();
      await this.publish(event);
    }
  } finally {
    try {
      await this.persistNewMessages();
    } finally {
      this.running = false;
      this.abortRequested = false;
    }
  }
}

subscribe(listener: HarnessEventListener): Unsubscribe {
  this.listeners.add(listener);
  return () => {
    this.listeners.delete(listener);
  };
}

abort(): void {
  if (!this.running) return;
  this.abortRequested = true;
  this.agent.abort();
}

async switchModel(model: ModelConfig): Promise<void> {
  this.assertIdle();
  await this.session.appendModelChange(model);
  this.currentModel = model;
  this.agent.model = model;
}

registerTool(tool: AgentTool): void {
  this.assertIdle();
  this.toolRegistry.register(tool);
}

unregisterTool(name: string): void {
  this.assertIdle();
  this.toolRegistry.unregister(name);
}

get messages(): readonly AgentMessage[] {
  return this.agent.messages;
}

get model(): ModelConfig {
  return this.currentModel;
}

get isRunning(): boolean {
  return this.running;
}
```

- [ ] **Step 7: Create the Coding factory and migrate direct callers**

Create `src/harness/factory.ts`:

```ts
import { AgentHarness } from "./agent-harness.js";
import { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
import { Session } from "./session/session.js";
import { defaultSystemPrompt } from "./system-prompt.js";
import { createToolRegistry } from "./tools/factory.js";
import type {
  CreateHarnessConfig,
  SystemPromptBuilder,
} from "./types.js";

function resolveSystemPrompt(
  prompt: string | SystemPromptBuilder | undefined,
): SystemPromptBuilder {
  if (typeof prompt === "function") return prompt;
  return defaultSystemPrompt(prompt ?? CODING_SYSTEM_PROMPT);
}

export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  const session =
    config.session ??
    await Session.create(config.project.storageDir);

  return new AgentHarness({
    session,
    model: config.model,
    streamFn: config.streamFn,
    toolRegistry: createToolRegistry(config.project.workDir),
    systemPrompt: resolveSystemPrompt(config.systemPrompt),
    cwd: config.project.workDir,
  });
}
```

Update the first exports in `src/harness/index.ts` while leaving the Hook exports for Task 4:

```ts
export { AgentHarness } from "./agent-harness.js";
export { createHarness } from "./factory.js";
export type {
  CreateHarnessConfig,
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "./types.js";
export { CODING_SYSTEM_PROMPT } from "./coding-system-prompt.js";
```

Remove the old `SystemPromptBuilder`/`SystemPromptContext` export from `system-prompt.ts`.

Update `src/main.ts`:

```ts
import { createHarness } from "./harness/factory.js";
```

Rewrite `CliFrontend.run()` so the subscription covers the whole input loop:

```ts
async run(harness: AgentHarness): Promise<void> {
  const unsubscribe = harness.subscribe((event) => {
    renderAgentEvent(
      event,
      (text) => process.stdout.write(text),
      (text) => console.log(text),
    );
  });

  console.log("Agent Loop");
  console.log("Press Enter to send. ESC to abort streaming. 'q' to quit.\n");

  try {
    while (true) {
      let query: string;
      try {
        query = await this.readline.question(`${CYAN}>> ${RESET}`);
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

      let onData: ((buf: Buffer) => void) | undefined;
      if (process.stdin.isTTY) {
        onData = (buf: Buffer): void => {
          if (buf[0] === 0x1b) {
            harness.abort();
          } else if (buf[0] === 0x03) {
            process.kill(process.pid, "SIGINT");
          }
        };
        process.stdin.setRawMode(true);
        process.stdin.on("data", onData);
      }

      try {
        await harness.prompt(query);
      } finally {
        if (onData !== undefined) {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(false);
        }
      }
      console.log();
    }
  } finally {
    unsubscribe();
  }
}
```

- [ ] **Step 8: Build and run AgentHarness tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/agent-harness.test.js
```

Expected: all focused tests pass.

- [ ] **Step 9: Run full tests**

Run:

```powershell
npm test
```

Expected: all tests pass with CLI rendering supplied through one Harness subscription.

- [ ] **Step 10: Commit the Harness core and direct callers**

```powershell
git add src/harness/types.ts src/harness/coding-system-prompt.ts src/harness/system-prompt.ts src/harness/agent-harness.ts src/harness/factory.ts src/harness/index.ts src/cli/frontend.ts src/main.ts tests/harness/agent-harness.test.ts
git commit -m "refactor: make harness own agent runs"
```

---

### Task 4: Build the Coding factory and remove the Hook subsystem

**Files:**

- Create: `tests/harness/factory.test.ts`
- Modify: `src/harness/tools/factory.ts`
- Modify: `src/harness/tools/index.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/index.ts`
- Modify: `tests/harness/tools/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Delete: all files under `src/harness/hooks/`
- Delete: `tests/agent/hooks/registry.test.ts`
- Delete: `tests/harness/permission.test.ts`

**Interfaces:**

- Consumes: Task 3 `AgentHarness`, `createHarness`, `CreateHarnessConfig`, and `SystemPromptBuilder`; Task 2 tool classes; Task 1 Session.
- Produces:

```ts
export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness>;

export function createToolRegistry(cwd: string): AgentToolRegistry;
```

- Produces the complete public Harness export surface listed in the approved spec.

- [ ] **Step 1: Add failing Coding factory tests**

Create `tests/harness/factory.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createHarness } from "../../src/harness/factory.js";
import { Session } from "../../src/harness/session/session.js";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
} from "../../src/ai/types.js";

const model: ModelConfig = { provider: "test", model: "model" };
const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

test("factory composes workDir, default tools, and string prompt", async () => {
  let seenPrompt = "";
  let seenTools: string[] = [];
  const stream: StreamFn = async function* (_model, context) {
    seenPrompt = context.systemPrompt ?? "";
    seenTools = context.tools?.map((tool) => tool.name) ?? [];
    yield { type: "done", message: assistant };
  };

  const harness = await createHarness({
    project: {
      workDir: "C:/workspace/project",
      storageDir: "unused-because-session-is-in-memory",
    },
    streamFn: stream,
    model,
    session: Session.inMemory(),
    systemPrompt: "cwd={{cwd}} date={{date}}",
  });

  await harness.prompt("hello");
  assert.match(seenPrompt, /^cwd=C:\/workspace\/project date=\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(seenTools, [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "todo_write",
  ]);
});

test("factory restores the supplied Session", async () => {
  const session = Session.inMemory();
  await session.appendMessage({ role: "user", content: "old" });
  await session.appendMessage(assistant);

  let seenRoles: string[] = [];
  const harness = await createHarness({
    project: { workDir: process.cwd(), storageDir: "unused" },
    streamFn: async function* (_model, context) {
      seenRoles = context.messages.map((message) => message.role);
      yield { type: "done", message: assistant };
    },
    model,
    session,
  });

  await harness.prompt("new");
  assert.deepEqual(seenRoles, ["user", "assistant", "user"]);
});

test("default Harness composition emits no Hook console logs", async () => {
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args);
  };
  try {
    const harness = await createHarness({
      project: { workDir: process.cwd(), storageDir: "unused" },
      streamFn: async function* () {
        yield { type: "done", message: assistant };
      },
      model,
      session: Session.inMemory(),
    });
    await harness.prompt("hello");
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logs, []);
});
```

Add one test without `systemPrompt` and assert the captured prompt contains the stable opening text from `CODING_SYSTEM_PROMPT`.

- [ ] **Step 2: Update public-import tests before implementation**

Extend `tests/import-smoke.test.ts` with a TypeScript-level import block for every intended Harness symbol:

```ts
import {
  AgentHarness,
  BashTool,
  CODING_SYSTEM_PROMPT,
  EditFileTool,
  GlobTool,
  LocalBashOperations,
  ReadFileTool,
  Session,
  SessionError,
  TodoWriteTool,
  WriteFileTool,
  createHarness,
  createToolRegistry,
  defaultSystemPrompt,
  formatSystemPrompt,
} from "../src/harness/index.js";

void [
  AgentHarness,
  BashTool,
  CODING_SYSTEM_PROMPT,
  EditFileTool,
  GlobTool,
  LocalBashOperations,
  ReadFileTool,
  Session,
  SessionError,
  TodoWriteTool,
  WriteFileTool,
  createHarness,
  createToolRegistry,
  defaultSystemPrompt,
  formatSystemPrompt,
];
```

Add type-only imports for `HarnessConfig`, `HarnessProject`, `CreateHarnessConfig`, `HarnessEventListener`, `Unsubscribe`, `SystemPromptBuilder`, `SystemPromptContext`, `SessionContext`, `SessionErrorCode`, `BashOperations`, and `TodoItem`.

- [ ] **Step 3: Run the build to verify factory/export failures**

Run:

```powershell
npm run build
```

Expected: failure because `factory.ts` and the revised exports do not exist.

- [ ] **Step 4: Require an explicit cwd in the default tool factory**

Change `src/harness/tools/factory.ts` to this exact signature and registration order:

```ts
export function createToolRegistry(cwd: string): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.register(new BashTool(cwd));
  registry.register(new ReadFileTool(cwd));
  registry.register(new WriteFileTool(cwd));
  registry.register(new EditFileTool(cwd));
  registry.register(new GlobTool(cwd));
  registry.register(new TodoWriteTool());
  return registry;
}
```

Keep the Task 3 `src/harness/factory.ts` implementation unchanged; the tests in this task verify its composition behavior.

- [ ] **Step 5: Delete hooks and finish tool internals**

Delete the complete Hook directory and its two dedicated test files.

Now make the Task 2 Bash policy helper module-private by removing `export`, and remove it from `tools/index.ts`. Remove `getCurrentTodos` from `tools/index.ts`. Do not replace either with another global API.

- [ ] **Step 6: Define the exact Harness and root exports**

Rewrite `src/harness/index.ts` to export exactly the approved public surface:

```ts
export { AgentHarness } from "./agent-harness.js";
export { createHarness } from "./factory.js";
export {
  CODING_SYSTEM_PROMPT,
} from "./coding-system-prompt.js";
export {
  defaultSystemPrompt,
  formatSystemPrompt,
} from "./system-prompt.js";
export { Session } from "./session/session.js";
export { SessionError } from "./session/types.js";
export { createToolRegistry } from "./tools/factory.js";
export { BashTool } from "./tools/bash.js";
export { LocalBashOperations } from "./tools/bash-ops.js";
export {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
} from "./tools/files.js";
export { GlobTool } from "./tools/glob.js";
export { TodoWriteTool } from "./tools/todo-write.js";

export type {
  CreateHarnessConfig,
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "./types.js";
export type {
  SessionContext,
  SessionErrorCode,
} from "./session/types.js";
export type { BashOperations } from "./tools/bash.js";
export type { TodoItem } from "./tools/todo-write.js";
```

In `src/index.ts`, remove direct Hook exports and replace the direct Harness class export with:

```ts
export * from "./agent/agent.js";
export * from "./agent/agent-loop.js";
export * from "./agent/types.js";
export * from "./agent/tools/index.js";
export * from "./harness/index.js";
export * from "./ai/index.js";
export * from "./utils/timeout.js";
export * from "./utils/workspace.js";
```

This is the complete intended root barrel; do not retain the old direct Hook or `harness/agent-harness` export lines.

- [ ] **Step 7: Build and run focused tests**

Run:

```powershell
npm run build
node --test dist/tests/harness/factory.test.js dist/tests/harness/tools/factory.test.js dist/tests/import-smoke.test.js
```

Expected: all focused tests pass and importing either `src/harness/index.js` or the root package has no credential or console side effects.

- [ ] **Step 8: Run the full suite and scan for deleted APIs**

Run:

```powershell
npm test
rg -n "HookRegistry|createHookRegistry|PermissionHook|getCurrentTodos|registerHook|getHook" src tests
```

Expected: tests pass; ripgrep produces no matches.

- [ ] **Step 9: Commit composition and Hook removal**

Stage only the files in this task, including deletions:

```powershell
git add src/harness/factory.ts src/harness/tools/factory.ts src/harness/tools/index.ts src/harness/tools/bash.ts src/harness/index.ts src/index.ts tests/harness/factory.test.ts tests/harness/tools/factory.test.ts tests/import-smoke.test.ts
git add -u src/harness/hooks tests/agent/hooks tests/harness/permission.test.ts
git commit -m "refactor: compose coding harness without hooks"
```

---

### Task 5: Verify CLI integration and document the complete package

**Files:**

- Rewrite: `src/harness/README.md`
- Modify: `tests/main.test.ts`

**Interfaces:**

- Consumes: Task 3 `AgentHarness.prompt(): Promise<void>` and `subscribe()`, plus the one-subscription CLI migration already committed in Task 3.
- Produces: an integration assertion for the Promise/subscription API and documentation matching `harness/index.ts`.

- [ ] **Step 1: Add a compile-time/runtime assertion for Promise prompt usage**

Extend `tests/main.test.ts` with a small noninteractive Harness integration:

```ts
import { AgentHarness } from "../src/harness/agent-harness.js";
import { Session } from "../src/harness/session/session.js";
import { AgentToolRegistry } from "../src/agent/tools/registry.js";
import type { StreamFn } from "../src/ai/types.js";

test("Harness renders through one subscription while prompt returns a Promise", async () => {
  const rendered: string[] = [];
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "hello" };
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: "stop",
        latencyMs: 0,
      },
    };
  };
  const harness = new AgentHarness({
    session: Session.inMemory(),
    model: { provider: "test", model: "test" },
    streamFn: stream,
    toolRegistry: new AgentToolRegistry(),
    systemPrompt: () => "",
    cwd: process.cwd(),
  });
  const unsubscribe = harness.subscribe((event) => {
    renderAgentEvent(event, (text) => rendered.push(text), () => undefined);
  });

  const run: Promise<void> = harness.prompt("hello");
  await run;
  unsubscribe();

  assert.deepEqual(rendered, ["hello"]);
});
```

- [ ] **Step 2: Run the focused test before final CLI migration**

Run:

```powershell
npm run build
node --test dist/tests/main.test.js
```

Expected: the integration assertion passes and proves that rendering is driven by a subscriber while prompt is a `Promise<void>`.

- [ ] **Step 3: Rewrite the Harness README against the actual exports**

Rewrite `src/harness/README.md` with these sections and concrete code:

1. Minimal usage: `createStreamFn()`, `createHarness()`, one `subscribe()`, `await prompt()`.
2. Overall concept: Coding Agent runtime externally; generic runtime vs coding composition internally.
3. `AgentHarness`: every method/getter and idle-only mutation rule.
4. `createHarness`: exact `CreateHarnessConfig`, required model, `project.workDir`, optional existing Session.
5. Session: factories, exact API, tree semantics, first-assistant delayed persistence.
6. System prompt: async `SystemPromptBuilder`, context fields, formatting helpers, coding default.
7. Tools: factory and every exported tool/type; Bash safety belongs to BashTool; Todo state is per instance.
8. Package boundary: imports from AI and Agent, exports to CLI; no meaningless aliases.
9. Complete export list matching `src/harness/index.ts`.
10. Explicit non-capabilities: no hooks/plugins, retry, compaction, branch APIs, skills, or queues.

Delete every old example using:

```ts
for await (const event of harness.prompt(...))
registerHook()
getHook()
createHookRegistry()
model?: ModelConfig
CreateHarnessConfig.cwd
```

Do not edit `src/agent/README.md`: its AgentLoopConfig callback explanation remains correct and those callbacks are not Harness hooks.

- [ ] **Step 4: Run documentation/API stale-reference scans**

Run:

```powershell
rg -n "registerHook|getHook|createHookRegistry|PermissionHook|for await.*harness\\.prompt|CreateHarnessConfig\\.cwd|model\\?:" src/harness src/agent/README.md src/main.ts src/cli
```

Expected: no stale matches. Mentions that explicitly state “Harness does not provide hooks” are acceptable; inspect them manually.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm run typecheck
npm test
```

Expected: both succeed.

There is no `lint` script in the current `package.json`; report that fact instead of inventing or installing a linter.

- [ ] **Step 6: Review the final dependency and file boundaries**

Run:

```powershell
rg -n "CODING_SYSTEM_PROMPT|from \\\"\\.\\/tools|from \\\"\\.\\/coding-system-prompt" src/harness/agent-harness.ts src/harness/types.ts src/harness/system-prompt.ts src/harness/session
rg -n "from \\\"\\.\\/hooks|from \\\"\\.\\.\\/harness\\/hooks" src tests
git diff --check
```

Expected:

- generic Harness runtime files have no concrete coding imports;
- no Hook imports remain;
- no whitespace errors.

- [ ] **Step 7: Commit integration coverage and documentation**

```powershell
git add src/harness/README.md tests/main.test.ts
git commit -m "docs: document harness runtime"
```

Before committing, use `git diff --cached --stat` to ensure unrelated pre-existing AI/Agent changes are not staged.
