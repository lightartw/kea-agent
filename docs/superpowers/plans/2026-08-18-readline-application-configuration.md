# Readline Application and Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary UI and production entry point with a readline application that owns one Config, observes Session-scoped Harness facts, supports Session/model commands, loads layered non-secret configuration plus user-only credentials, and initializes user templates safely.

**Architecture:** Core keeps ModelRuntime, AgentHarness, Session, and internal Events; Coding Agent keeps Project, Tools, Permission, and Interactions. The application layer discovers the Project directory and constructs the single Config, `main.ts` composes dependencies, and ReadlineUi owns the current Harness plus the linear input loop. UI facts cross a typed `AgentHarness.subscribe()` facade; active Permission questions use the existing Promise-based Interactions port.

**Tech Stack:** Node.js 24, TypeScript 7 strict ESM, `node:test`, Node readline/promises and filesystem APIs, TypeBox where already used, existing Anthropic/OpenAI/Gemini SDKs.

**Spec:** `docs/superpowers/specs/2026-08-18-readline-application-configuration-design.md`

## Global Constraints

- Production startup never calls `dotenv` and never reads provider credentials from `process.env`.
- Credentials come only from `~/.kea/auth.json`; every ordinary config source rejects credential fields.
- Ordinary precedence is direct CLI overrides, `--config`, Project config, user config, built-in defaults.
- `Config` is the only application setting entity; parsing and merge intermediates remain private function-local values.
- Project raw `Events` becomes private; UI observes one Session through `AgentHarness.subscribe()`.
- The readline loop awaits each `harness.prompt()`; no steer, follow-up queue, or concurrent normal Prompt.
- Only input beginning at character zero with an exact registered slash token is a command; unknown slash input is a Prompt.
- Runtime policy is not persisted in Session; model selection remains persisted in Session.
- Do not add `maxToolCalls`, memory, verification, multiple configured models per Provider, plugins, or generic UI interactions.
- Preserve Node `>=24 <25`, strict TypeScript options, JSONL Session format, Project storage layout, and existing Permission semantics.

---

## File Structure

### New application files

- `src/application/project-directory.ts` — canonical cwd and Git work-tree discovery.
- `src/application/config.ts` — the single Config class; internal file parsing, merge, validation, auth loading, and redaction.
- `src/application/arguments.ts` — production argv grammar.
- `src/application/init.ts` — exclusive `kea init` template creation.
- `tests/application/project-directory.test.ts`
- `tests/application/config.test.ts`
- `tests/application/arguments.test.ts`
- `tests/application/init.test.ts`

### Rebuilt UI files

- `src/ui/commands.ts` — pure slash command parser.
- `src/ui/interactions.ts` — readline implementation of `Interactions.permission()`.
- `src/ui/renderer.ts` — history and HarnessEvent rendering.
- `src/ui/readline-ui.ts` — current Harness, activation, selections, interrupts, and linear loop.
- `src/ui/index.ts` — focused UI exports.
- `tests/ui/commands.test.ts`
- `tests/ui/interactions.test.ts`
- `tests/ui/renderer.test.ts`
- `tests/ui/readline-ui.test.ts`

### Removed temporary UI files

- `src/ui/cli-frontend.ts`
- `src/ui/cli-harness-renderer.ts`
- `src/ui/cli-interactions.ts`
- `tests/ui/cli-frontend.test.ts`
- `tests/ui/cli-harness-renderer.test.ts`
- `tests/ui/cli-interactions.test.ts`

### Modified trusted/runtime files

- `src/core/ai/factory.ts`, `src/core/ai/index.ts`, `src/core/ai/README.md`
- `src/core/harness/events.ts`, `src/core/harness/types.ts`, `src/core/harness/agent-harness.ts`, `src/core/harness/index.ts`, `src/core/harness/README.md`
- `src/coding-agent/factory.ts`, `src/coding-agent/project/project.ts`, `src/coding-agent/tools/factory.ts`, `src/coding-agent/index.ts`, `src/coding-agent/README.md`
- `src/main.ts`, `src/index.ts`, `package.json`, `package-lock.json`, `docs/architecture.md`
- Existing tests under `tests/ai`, `tests/harness`, `tests/coding-agent`, `tests/main.test.ts`, and `tests/import-smoke.test.ts`.

---

### Task 1: Make ModelRuntime construction explicit

**Files:**
- Modify: `src/core/ai/factory.ts`
- Modify: `src/core/ai/index.ts`
- Modify: `src/main.ts` (temporary compilation bridge; replaced in Task 9)
- Modify: `tests/ai/factory.test.ts`
- Modify: `tests/import-smoke.test.ts`

**Interfaces:**
- Produces: `ProviderId`, `RuntimeProviderConfig`, `createModelRuntime(options): ModelRuntime`.
- Produces: `createModelRuntimeFromEnvironment(env): ModelRuntime` for development/tests only.
- Preserves: `ModelRuntime.stream(modelConfig, context, options)` and `ModelRuntime.complete(...)`.

- [ ] **Step 1: Replace environment-shaped factory tests with explicit Provider tests**

Rewrite the top-level factory cases to require this shape:

```ts
import {
  createModelRuntime,
  createModelRuntimeFromEnvironment,
  createRoutedRuntime,
  lazyAdapter,
} from "../../src/core/ai/factory.js";

test("explicit provider configuration is required and unique", () => {
  assert.throws(() => createModelRuntime({ providers: [] }), /at least one provider/i);
  assert.throws(
    () => createModelRuntime({
      providers: [
        { id: "openai", apiKey: "a" },
        { id: "openai", apiKey: "b" },
      ],
    }),
    /duplicate provider.*openai/i,
  );
});

test("routed runtime selects the adapter and forwards the model", async () => {
  const calls: string[] = [];
  const adapter = (id: string) => ({
    async *stream(model: string) {
      calls.push(`${id}/${model}`);
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          content: [],
          model,
          stopReason: "stop" as const,
          latencyMs: 0,
        },
      };
    },
  });
  const runtime = createRoutedRuntime(new Map([
    ["openai", adapter("openai")],
    ["anthropic", adapter("anthropic")],
  ]));

  for await (const event of runtime.stream(
    { provider: "anthropic", model: "claude-test" },
    { messages: [] },
  )) void event;

  assert.deepEqual(calls, ["anthropic/claude-test"]);
});

test("environment helper does not select a model", () => {
  const runtime = createModelRuntimeFromEnvironment({ OPENAI_API_KEY: "key" });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
});
```

Keep the existing `complete()` terminal-message, missing-terminal, and `lazyAdapter()` tests, updating them to use `createRoutedRuntime()` rather than `modelConfig` returned from the factory.

- [ ] **Step 2: Run the focused typecheck and observe the expected failure**

Run: `npm run typecheck`

Expected: FAIL because the new exports and return signatures do not exist and old tests still expect `{ runtime, modelConfig }`.

- [ ] **Step 3: Implement explicit Provider construction and a separately testable router**

Use these public application-facing types:

```ts
export type ProviderId = "anthropic" | "openai" | "gemini";

export interface RuntimeProviderConfig {
  readonly id: ProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime;
```

Factor routing into a module-exported but package-internal test seam:

```ts
export function createRoutedRuntime(
  adapters: ReadonlyMap<string, Adapter>,
): ModelRuntime {
  const stream = async function* (
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk> {
    const adapter = adapters.get(modelConfig.provider);
    if (adapter === undefined) {
      throw new Error(`Unknown provider: ${modelConfig.provider}`);
    }
    yield* adapter.stream(modelConfig.model, context, resolveOptions(options));
  };
  return {
    stream,
    async complete(modelConfig, context, options) {
      for await (const event of stream(modelConfig, context, options)) {
        if (event.type === "done" || event.type === "error") return event.message;
      }
      throw new Error("Model stream ended without a done or error terminal chunk");
    },
  };
}
```

`createModelRuntime()` validates non-empty unique known providers, constructs the existing lazy built-in adapters, and returns `createRoutedRuntime(adapters)`. `createModelRuntimeFromEnvironment()` maps only provider keys and base URLs into explicit providers; it does not inspect `DEFAULT_PROVIDER` or `MODEL_ID`.

- [ ] **Step 4: Keep the temporary main compiling until application composition is replaced**

Update the current `src/main.ts` only far enough to consume the new return type: call `createModelRuntimeFromEnvironment(process.env)` to obtain the runtime and construct its temporary `ModelConfig` from the existing `DEFAULT_PROVIDER`/`MODEL_ID` environment values. Add a `// Temporary compatibility until Task 9` comment at that block. Do not move this model-selection behavior into either runtime factory.

- [ ] **Step 5: Update package exports**

`src/core/ai/index.ts` exports `createModelRuntime`, `createModelRuntimeFromEnvironment`, `ProviderId`, and `RuntimeProviderConfig`; it does not export `createRoutedRuntime` or the old environment-oriented `ProviderConfig`.

- [ ] **Step 6: Build and run focused tests**

Run: `npm run build && node --test dist/tests/ai/factory.test.js dist/tests/import-smoke.test.js`

Expected: PASS; no test requires `MODEL_ID`, and importing the package performs no provider initialization.

- [ ] **Step 7: Commit**

```bash
git add src/core/ai/factory.ts src/core/ai/index.ts src/main.ts tests/ai/factory.test.ts tests/import-smoke.test.ts
git commit -m "refactor: configure model runtime explicitly"
```

---

### Task 2: Add Session-scoped Harness facts and maxTurns

**Files:**
- Modify: `src/core/harness/events.ts`
- Modify: `src/core/harness/types.ts`
- Modify: `src/core/harness/agent-harness.ts`
- Modify: `src/core/harness/index.ts`
- Modify: `tests/harness/agent-harness.test.ts`

**Interfaces:**
- Produces: `HarnessEvent` discriminated union.
- Produces: `AgentHarness.subscribe(listener: (event: HarnessEvent) => void): () => void`.
- Produces: `HarnessConfig.maxTurns?: number`; later Project construction always supplies a resolved number.

- [ ] **Step 1: Add failing subscription projection tests**

Add tests that drive the shared Events directly and prove Session filtering without exposing Events to the subscriber:

```ts
test("subscribe projects only this Session's facts and unsubscribe is idempotent", async () => {
  const events = new Events();
  const { harness } = makeHarness({ events });
  const facts: HarnessEvent[] = [];
  const unsubscribe = harness.subscribe((event) => facts.push(event));

  await events.emit("agent/text-delta", {
    sessionId: "another-session",
    runId: "ignored",
    text: "ignored",
  });
  await events.emit("agent/text-delta", {
    sessionId: harness.sessionId,
    runId: "run-1",
    text: "hello",
  });
  unsubscribe();
  unsubscribe();
  await events.emit("agent/text-delta", {
    sessionId: harness.sessionId,
    runId: "run-1",
    text: "late",
  });

  assert.deepEqual(facts, [{ type: "text-delta", runId: "run-1", text: "hello" }]);
});
```

Add one table-driven test covering all ten fact projections: run start/end, turn start/end, text/thinking deltas, tool-call start/delta, complete tool call, and tool result. Assert no projected value contains `sessionId`.

- [ ] **Step 2: Add a failing maxTurns propagation test**

Construct a Harness whose model emits one Tool Call every turn and whose Tool returns successfully. Pass `maxTurns: 1`; assert exactly one `runtime.stream()` call and one turn-end event.

```ts
assert.equal(streamCalls, 1);
assert.equal(turnEnds, 1);
```

- [ ] **Step 3: Run focused typecheck to verify failure**

Run: `npm run typecheck`

Expected: FAIL because `HarnessEvent`, `subscribe()`, and `HarnessConfig.maxTurns` do not exist.

- [ ] **Step 4: Define HarnessEvent and export it**

Implement the exact union from the spec in `src/core/harness/events.ts`, importing `AgentMessage`, `AgentToolCall`, and `AgentToolResult`. Export `HarnessEvent` from `src/core/harness/index.ts` alongside `HarnessRunEnd`.

- [ ] **Step 5: Implement subscribe() as an emit-only facade**

Register explicit wrappers for each UI-facing emit fact:

```ts
subscribe(listener: (event: HarnessEvent) => void): () => void {
  const belongsToSession = (sessionId: string): boolean =>
    sessionId === this.session.id;
  const off = [
    this.events.on("harness/run-start", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({ type: "run-start", runId: input.runId });
      }
    }),
    this.events.on("harness/run-end", (input) => {
      if (!belongsToSession(input.sessionId)) return;
      listener(input.reason === "error"
        ? {
            type: "run-end",
            runId: input.runId,
            reason: "error",
            errorMessage: input.errorMessage,
          }
        : { type: "run-end", runId: input.runId, reason: input.reason });
    }),
    this.events.on("agent/turn-start", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({ type: "turn-start", runId: input.runId });
      }
    }),
    this.events.on("agent/turn-end", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "turn-end",
          runId: input.runId,
          message: input.message,
          toolResults: input.toolResults,
        });
      }
    }),
    this.events.on("agent/text-delta", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({ type: "text-delta", runId: input.runId, text: input.text });
      }
    }),
    this.events.on("agent/thinking-delta", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "thinking-delta",
          runId: input.runId,
          thinking: input.thinking,
        });
      }
    }),
    this.events.on("agent/tool-call-start", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "tool-call-start",
          runId: input.runId,
          id: input.id,
          name: input.name,
        });
      }
    }),
    this.events.on("agent/tool-call-delta", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "tool-call-delta",
          runId: input.runId,
          id: input.id,
          argumentsDelta: input.argumentsDelta,
        });
      }
    }),
    this.events.on("agent/tool-call", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "tool-call",
          runId: input.runId,
          cwd: input.cwd,
          call: input.call,
        });
      }
    }),
    this.events.on("agent/tool-result", (input) => {
      if (belongsToSession(input.sessionId)) {
        listener({
          type: "tool-result",
          runId: input.runId,
          cwd: input.cwd,
          call: input.call,
          result: input.result,
        });
      }
    }),
  ];
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of off) unsubscribe();
  };
}
```

Do not create a generic EventMap adapter and do not register intercept events. Let existing `Events.emit()` isolation report synchronous listener errors through `onListenerError`.

- [ ] **Step 6: Thread maxTurns into AgentLoopConfig**

Add `maxTurns?: number` to `HarnessConfig`, store it in AgentHarness, and return it only when present:

```ts
private createLoopConfig(): AgentLoopConfig {
  return {
    model: this.currentModel,
    convertToLlm: (messages) => messages,
    ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
  };
}
```

- [ ] **Step 7: Build and run Harness tests**

Run: `npm run build && node --test dist/tests/harness/agent-harness.test.js`

Expected: PASS, including all fact projections, Session filtering, idempotent unsubscribe, listener isolation, and maxTurns.

- [ ] **Step 8: Commit**

```bash
git add src/core/harness/events.ts src/core/harness/types.ts src/core/harness/agent-harness.ts src/core/harness/index.ts tests/harness/agent-harness.test.ts
git commit -m "feat: expose session-scoped harness facts"
```

---

### Task 3: Simplify Project construction and pass runtime policy

**Files:**
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/project/project.ts`
- Modify: `src/coding-agent/tools/factory.ts`
- Modify: `src/coding-agent/index.ts`
- Modify: `tests/coding-agent/project/factory.test.ts`
- Modify: `tests/coding-agent/project/project.test.ts`
- Modify: `tests/coding-agent/tools/factory.test.ts`

**Interfaces:**
- Consumes: `HarnessConfig.maxTurns` from Task 2.
- Produces: `openOrCreateProject({ keaHome, projectDirectory, runtime, modelConfig, interactions, maxTurns, toolTimeoutSeconds, onListenerError? })`.
- Produces: `createBuiltinToolRegistry(cwd, timeoutSeconds)`.
- Prepares removal: explicit `projectDirectory` is the new path; the old `cwd` branch and public `Project.events` remain temporarily so the old main/UI compile until Task 9.

- [ ] **Step 1: Rewrite Project factory tests around explicit projectDirectory**

Update every call to pass an already canonical directory and policies:

```ts
const project = await openOrCreateProject({
  keaHome,
  projectDirectory: await realpath(dir),
  runtime: runtimeFromStream(simpleStream),
  modelConfig,
  interactions: testInteractions,
  maxTurns: 20,
  toolTimeoutSeconds: 120,
});
```

Move Git-root and Git-process assertions out of this test file; Task 4 recreates them at the application discovery boundary. Add rejection cases for relative, missing, file, and non-canonical `projectDirectory` values. Keep one explicitly named compatibility test for the old `cwd` call shape; Task 9 deletes that test and branch together.

- [ ] **Step 2: Add failing policy-construction tests**

Update the Project test helper to accept `maxTurns` and `toolTimeoutSeconds`. Assert a Harness created by Project stops at the configured turn limit. In the Tool factory test, register a slow test Tool into a registry created with `0.001` seconds and assert execution returns an error containing `timed out`.

- [ ] **Step 3: Verify the tests fail against the old API**

Run: `npm run typecheck`

Expected: FAIL because `projectDirectory`, `maxTurns`, and `toolTimeoutSeconds` are not accepted or propagated yet.

- [ ] **Step 4: Make explicit projectDirectory the primary Coding Agent path**

Add a boundary validator that requires an absolute normalized existing directory and confirms `realpath(projectDirectory) === projectDirectory`. Route new calls through it without Git discovery. Keep the old optional `cwd` input and its existing discovery helpers in a clearly marked compatibility branch used only by the temporary main/UI. Do not export a second options type or compatibility class. Task 9 removes this branch after all callers migrate.

- [ ] **Step 5: Store and pass only consumed policy values**

Project constructor fields become:

```ts
private readonly maxTurns: number;
private readonly toolTimeoutSeconds: number;
private readonly events: Events;
```

`buildHarness()` uses:

```ts
return new AgentHarness({
  session,
  runtime: this.runtime,
  modelConfig: this.modelConfig,
  maxTurns: this.maxTurns,
  toolRegistry: createBuiltinToolRegistry(cwd, this.toolTimeoutSeconds),
  systemPrompt: createSystemPrompt(this.projectDirectory, cwd),
  events: this.events,
});
```

Change `createBuiltinToolRegistry(cwd, timeoutSeconds)` to construct `new AgentToolRegistry(timeoutSeconds)`. Keep the existing public `readonly events` only as temporary UI compatibility; new code must use `harness.subscribe()`, and Task 9 makes this field private.

- [ ] **Step 6: Build and run Coding Agent Project/Tool tests**

Run: `npm run build && node --test dist/tests/coding-agent/project/factory.test.js dist/tests/coding-agent/project/project.test.js dist/tests/coding-agent/tools/factory.test.js`

Expected: PASS; Project storage behavior remains unchanged, new Project tests do not reach raw Events, and the one compatibility test documents the branch scheduled for deletion in Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/coding-agent/factory.ts src/coding-agent/project/project.ts src/coding-agent/tools/factory.ts src/coding-agent/index.ts tests/coding-agent/project/factory.test.ts tests/coding-agent/project/project.test.ts tests/coding-agent/tools/factory.test.ts
git commit -m "refactor: accept explicit project runtime settings"
```

---

### Task 4: Move Project directory discovery into the application

**Files:**
- Create: `src/application/project-directory.ts`
- Create: `tests/application/project-directory.test.ts`

**Interfaces:**
- Produces: `resolveProjectDirectory(startupDirectory: string): Promise<string>`.
- Consumed later by: Config loading and `main.ts`.

- [ ] **Step 1: Write discovery contract tests**

Move the behavior formerly tested through `openOrCreateProject()` into direct application tests:

```ts
test("Git subdirectories resolve to the canonical work-tree root", async () => {
  const root = await tempDir();
  const child = join(root, "src");
  try {
    await mkdir(child);
    await execFileAsync("git", ["init"], { cwd: root });
    assert.equal(await resolveProjectDirectory(child), await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-Git directory resolves to its canonical self", async () => {
  const directory = await tempDir();
  try {
    assert.equal(await resolveProjectDirectory(directory), await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

Also cover missing path, file path, empty successful Git output, missing Git executable, and Git errors other than “not a repository”. For the empty-output case, create a test-only fake `git` launcher in a temporary bin directory (a `git.cmd` on Windows, an executable `git` script on POSIX), prepend it to `PATH`, and have it exit `0` without stdout. For the launch-failure case, set `PATH` to an empty temporary directory. Restore environment values in `finally`. These tests exercise the real child-process boundary; do not introduce a command-runner interface solely for testing.

- [ ] **Step 2: Verify the new module is missing**

Run: `npm run typecheck`

Expected: FAIL because `src/application/project-directory.ts` does not exist.

- [ ] **Step 3: Move the proven discovery logic without changing semantics**

Implement `requireDirectory()`, `findGitRoot()`, and `isNotARepository()` as private functions in the new module. Resolve the caller value first, canonicalize with `realpath`, execute Git in the canonical cwd, and canonicalize a returned Git root before returning it.

Use ordinary `Error` with path context; do not add a Project resolver class or repository abstraction.

- [ ] **Step 4: Build and run discovery tests**

Run: `npm run build && node --test dist/tests/application/project-directory.test.js`

Expected: PASS on Git and non-Git directories; infrastructure failures remain errors rather than non-Git fallbacks.

- [ ] **Step 5: Commit**

```bash
git add src/application/project-directory.ts tests/application/project-directory.test.ts
git commit -m "feat: resolve project directories in application"
```

---

### Task 5: Implement the single Config class

**Files:**
- Create: `src/application/config.ts`
- Create: `tests/application/config.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `RuntimeProviderConfig`, and `ModelConfig` from Task 1.
- Produces: `Config.load(...)`, scalar settings, `models`, `defaultModel`, `runtimeProviders()`, and `redact()`.
- Does not produce: file/auth/resolved wrapper types.

- [ ] **Step 1: Write precedence and single-object tests**

Use a temporary `keaHome` and Project directory. Write user, Project, and override JSON files with conflicting safe values, plus auth credentials:

```ts
test("load applies defaults, user, project, override, and CLI in order", async () => {
  const { keaHome, projectDirectory, overridePath } = await configFixture({
    user: {
      defaultProvider: "openai",
      providers: { openai: { model: "user-model" } },
      agent: { maxTurns: 10 },
    },
    project: {
      providers: { openai: { model: "project-model" } },
      tools: { timeoutSeconds: 30 },
    },
    override: {
      providers: { openai: { model: "override-model" } },
      ui: { thinking: "visible" },
    },
    auth: { providers: { openai: { apiKey: "secret-key" } } },
  });

  const config = await Config.load({
    keaHome,
    projectDirectory,
    configOverride: overridePath,
    verbose: true,
  });

  assert.equal(config.maxTurns, 10);
  assert.equal(config.toolTimeoutSeconds, 30);
  assert.equal(config.thinking, "visible");
  assert.equal(config.toolDetails, "compact");
  assert.equal(config.verbose, true);
  assert.deepEqual(config.defaultModel, { provider: "openai", model: "override-model" });
  assert.deepEqual(config.models, [{ provider: "openai", model: "override-model" }]);
  assert.deepEqual(config.runtimeProviders(), [{ id: "openai", apiKey: "secret-key" }]);
});
```

The fixture helper belongs only in the test file; it is not an application entity.

- [ ] **Step 2: Write strict source and cross-field validation tests**

Table-drive each invalid case and assert source path plus field path:

```ts
for (const [document, field] of [
  [{ agent: { maxTurns: 0 } }, "agent.maxTurns"],
  [{ tools: { timeoutSeconds: 3601 } }, "tools.timeoutSeconds"],
  [{ ui: { thinking: "sometimes" } }, "ui.thinking"],
  [{ providers: { openai: { baseUrl: "relative" } } }, "providers.openai.baseUrl"],
  [{ memory: { maxResults: 5 } }, "memory"],
] as const) {
  await assert.rejects(loadWithUserDocument(document), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.fieldPath, field);
    assert.match(error.message, new RegExp(field.replaceAll(".", "\\.")));
    return true;
  });
}
```

Add separate cases for malformed JSON, null values, unknown Provider IDs, missing model, multiple Providers without default, default referencing a disabled Provider, missing auth, empty API Key, and `apiKey`/`token`/`secret`/`password` in every ordinary source. Prove missing user and Project config files are skipped, a missing explicit `--config` file fails, extra credentials for a known disabled Provider are ignored, and an unknown Provider in auth fails.

- [ ] **Step 3: Write model order and redaction tests**

Configure providers in reverse JSON order and assert `Config.models` follows the built-in Provider order. Assert `runtimeProviders()` includes base URL and credentials, while `config.redact("failed with secret-key")` returns `failed with [REDACTED]` and never includes key length or prefix.

- [ ] **Step 4: Verify the Config module is missing**

Run: `npm run typecheck`

Expected: FAIL because `Config` and `ConfigurationError` do not exist.

- [ ] **Step 5: Implement Config.load() with private parsing helpers**

Export only these application concepts:

```ts
export class ConfigurationError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly fieldPath: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${sourcePath}${fieldPath === undefined ? "" : `: ${fieldPath}`}: ${message}`, options);
    this.name = "ConfigurationError";
  }
}

export class Config {
  readonly defaultProvider: ProviderId;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  #providers: ReadonlyMap<ProviderId, {
    readonly model: string;
    readonly baseUrl?: string;
    readonly apiKey: string;
  }>;

  private constructor(options: {
    readonly defaultProvider: ProviderId;
    readonly maxTurns: number;
    readonly toolTimeoutSeconds: number;
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
    readonly verbose: boolean;
    readonly providers: ReadonlyMap<ProviderId, {
      readonly model: string;
      readonly baseUrl?: string;
      readonly apiKey: string;
    }>;
  });

  static load(options: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly configOverride?: string;
    readonly verbose: boolean;
  }): Promise<Config>;

  get models(): readonly ModelConfig[];
  get defaultModel(): ModelConfig;
  runtimeProviders(): readonly RuntimeProviderConfig[];
  redact(message: string): string;
}
```

Inside the same file, implement small functions `readOptionalJson(path)`, `readRequiredJson(path)`, `assertObject`, `assertOnlyKeys`, `parseOrdinarySource`, `parseAuth`, and `mergeOrdinary`. Keep their return shapes inferred or function-local; do not export or name file/resolved configuration interfaces.

Apply built-in defaults first, validate every source before merge, load auth after all ordinary sources, perform cross-field validation, then call the private Config constructor exactly once.

- [ ] **Step 6: Implement secret encapsulation and derived accessors**

Store the merged Provider map in `#providers`. Return fresh arrays from `models` and `runtimeProviders()`. `defaultModel` returns a fresh `{ provider, model }`. `redact()` replaces every loaded non-empty Key using `split(key).join("[REDACTED]")`; load-time auth diagnostics never interpolate values.

- [ ] **Step 7: Build and run Config tests**

Run: `npm run build && node --test dist/tests/application/config.test.js`

Expected: PASS for precedence, strict validation, credential isolation, deterministic models, and redaction.

- [ ] **Step 8: Commit**

```bash
git add src/application/config.ts tests/application/config.test.ts
git commit -m "feat: load application settings through config"
```

---

### Task 6: Add argv parsing and idempotent `kea init`

**Files:**
- Create: `src/application/arguments.ts`
- Create: `src/application/init.ts`
- Create: `tests/application/arguments.test.ts`
- Create: `tests/application/init.test.ts`

**Interfaces:**
- Produces: `parseArguments(argv)` returning either `{ command: "init" }` or `{ command: "run"; continue: boolean; config?: string; verbose: boolean; directory: string }`.
- Produces: `initializeUserConfiguration(keaHome: string): Promise<{ config: "created" | "skipped"; auth: "created" | "skipped" }>`.

- [ ] **Step 1: Write argv grammar tests**

```ts
test("run arguments parse continue, override, verbose, and directory", () => {
  assert.deepEqual(
    parseArguments(["-c", "--config", "custom.json", "--verbose", "work"]),
    {
      command: "run",
      continue: true,
      config: resolve("custom.json"),
      verbose: true,
      directory: resolve("work"),
    },
  );
});

test("init rejects unrelated arguments", () => {
  assert.throws(() => parseArguments(["init", "--config", "x.json"]), /init.*does not accept/i);
});
```

Cover defaults, unknown flags, duplicate `--config`, missing option value, and multiple directories.

- [ ] **Step 2: Write exclusive init tests**

Run init twice in a temporary home. Assert the first call returns two `created` values, the second returns two `skipped`, file contents exactly match the spec templates with a final newline, and modifying config between calls is never overwritten. Delete only auth and assert a third call skips config and recreates auth.

- [ ] **Step 3: Verify both modules are missing**

Run: `npm run typecheck`

Expected: FAIL because `parseArguments()` and `initializeUserConfiguration()` do not exist.

- [ ] **Step 4: Implement the pure parser**

Use an index loop over argv. Resolve `--config` and the optional directory against `process.cwd()`. Do not read files or environment variables during parsing. Throw ordinary Error messages naming the invalid option.

- [ ] **Step 5: Implement exclusive template creation**

Use `mkdir(keaHome, { recursive: true })` and `writeFile(path, content, { flag: "wx", encoding: "utf8", mode })`. Treat only `EEXIST` as `skipped`; propagate every other error. Use mode `0o600` for auth and do not roll back a file already created if the second write fails.

- [ ] **Step 6: Build and run application argument/init tests**

Run: `npm run build && node --test dist/tests/application/arguments.test.js dist/tests/application/init.test.js`

Expected: PASS with byte-stable templates and no overwrite behavior.

- [ ] **Step 7: Commit**

```bash
git add src/application/arguments.ts src/application/init.ts tests/application/arguments.test.ts tests/application/init.test.ts
git commit -m "feat: parse startup arguments and initialize config"
```

---

### Task 7: Rebuild command parsing, Interaction, and rendering

**Files:**
- Create: `src/ui/commands.ts`
- Create: `src/ui/interactions.ts`
- Create: `src/ui/renderer.ts`
- Create: `tests/ui/commands.test.ts`
- Create: `tests/ui/interactions.test.ts`
- Create: `tests/ui/renderer.test.ts`

**Interfaces:**
- Consumes: `HarnessEvent`, `AgentMessage`, `PermissionRequest`, and `PermissionReply`.
- Produces: `parseInput(input): UiAction`.
- Produces: `ReadlineInteractions` implementing Coding Agent `Interactions`.
- Produces: `Renderer` for user input, history, HarnessEvent, errors, selections, and help.

- [ ] **Step 1: Write exact slash parser tests**

```ts
test("only exact registered tokens at character zero are commands", () => {
  assert.deepEqual(parseInput("/new"), { kind: "new-session" });
  assert.deepEqual(parseInput("/model"), { kind: "switch-model" });
  assert.deepEqual(parseInput("/unknown"), { kind: "prompt", text: "/unknown" });
  assert.deepEqual(parseInput(" /new"), { kind: "prompt", text: " /new" });
  assert.deepEqual(parseInput("read /tmp/a"), { kind: "prompt", text: "read /tmp/a" });
  assert.deepEqual(parseInput("/new extra"), {
    kind: "command-error",
    message: "/new does not accept arguments",
  });
});
```

Cover all five commands and verify Prompt text is never trimmed.

- [ ] **Step 2: Write Permission answer and cancellation tests**

Inject a fake `question(prompt, { signal })` function. Assert `once`/`o`, `always`/`a`, and default/`deny` map correctly; query text contains the command or external path and reason. If the supplied Run signal aborts, assert the exact abort reason rejects rather than returning deny. Empty input returns deny.

- [ ] **Step 3: Write Renderer mode tests**

Test `thinking: "hidden"` suppresses thinking, `visible` writes it, compact Tool facts omit full result content, full Tool facts include JSON-safe arguments and result content, run error renders once, and history renders user/assistant/tool messages in order. Pass HarnessEvent values directly; Renderer tests must not construct or access Events.

- [ ] **Step 4: Verify the new modules are missing**

Run: `npm run typecheck`

Expected: FAIL because `commands.ts`, `interactions.ts`, and `renderer.ts` do not exist.

- [ ] **Step 5: Implement UiAction and parseInput()**

```ts
export type UiAction =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "new-session" }
  | { readonly kind: "switch-session" }
  | { readonly kind: "switch-model" }
  | { readonly kind: "help" }
  | { readonly kind: "exit" }
  | { readonly kind: "command-error"; readonly message: string };
```

Compare only the first whitespace-delimited token when `input.startsWith("/")`; known commands with trailing non-whitespace become command-error, and unknown tokens return Prompt.

- [ ] **Step 6: Implement the readline Permission adapter**

The constructor accepts an inline options object containing only `question` and `write/log` dependencies. Call `question()` with the external signal. In catch, call `signal?.throwIfAborted()` before treating an ordinary terminal cancellation as deny. Do not register Events or create a pending request map.

- [ ] **Step 7: Implement Renderer as a HarnessEvent consumer**

Renderer holds only display policy and per-run Tool count. Its main entry is:

```ts
handle(event: HarnessEvent): void {
  switch (event.type) {
    case "text-delta": this.write(event.text); break;
    case "thinking-delta": if (this.thinking === "visible") this.write(event.thinking); break;
    case "tool-call": this.renderToolCall(event.call); break;
    case "tool-result": this.renderToolResult(event.call, event.result); break;
    case "run-end": this.renderRunEnd(event); break;
    default: break;
  }
}
```

Use bounded JSON previews in compact mode and complete JSON-safe values in full mode. Catch renderer serialization errors at the public rendering method and report them through its injected logger.

- [ ] **Step 8: Run the new focused tests alongside the temporary UI**

Keep `cli-interactions.ts`, `cli-harness-renderer.ts`, and their tests unchanged for now because the temporary main/frontend still imports them. Task 9 deletes the complete old UI slice after `ReadlineUi` and production composition are ready.

Run: `npm run build && node --test dist/tests/ui/commands.test.js dist/tests/ui/interactions.test.js dist/tests/ui/renderer.test.js`

Expected: PASS; no new UI test imports Core Events, and the unchanged temporary UI still compiles.

- [ ] **Step 9: Commit**

```bash
git add src/ui/commands.ts src/ui/interactions.ts src/ui/renderer.ts tests/ui/commands.test.ts tests/ui/interactions.test.ts tests/ui/renderer.test.ts
git commit -m "refactor: rebuild readline commands and rendering"
```

---

### Task 8: Implement the linear ReadlineUi Session loop

**Files:**
- Create: `src/ui/readline-ui.ts`
- Modify: `src/ui/index.ts`
- Create: `tests/ui/readline-ui.test.ts`

**Interfaces:**
- Consumes: Task 7 parser, renderer, and interactions; `Project`; `AgentHarness`; configured `ModelConfig[]`.
- Produces: `ReadlineUi.interactions`, `run(project, initialHarness)`, and idempotent `close()`.

- [ ] **Step 1: Build a small fake Harness/Project test fixture**

The test fixture records `prompt`, `switchModel`, `abort`, subscribe/unsubscribe, Session list, Harness creation, and restore calls. It is test-only and cast to public types; do not add a production Harness interface.

- [ ] **Step 2: Write the sequential Prompt/Interaction test**

Queue answers `"hello"`, then `"/exit"`. Make fake `harness.prompt()` append `prompt:start`, await a deferred permission answer through `ui.interactions.permission()`, then append `prompt:end`. Assert question order and calls prove the outer question is not requested before prompt completion:

```ts
assert.deepEqual(calls, [
  "question:kea> ",
  "render-user:hello",
  "prompt:start",
  "question:permission",
  "prompt:end",
  "question:kea> ",
]);
```

- [ ] **Step 3: Write Session activation tests**

Test `/new` creates a Harness; `/session` lists newest-first metadata and restores the numbered choice; successful activation unsubscribes old, assigns candidate, renders candidate history, then subscribes candidate. Make candidate creation reject and assert old subscription/current Harness remain active.

- [ ] **Step 4: Write model and control tests**

Test `/model` selects only configured models, same model is a no-op, another model calls `switchModel`, and a restored unavailable model requires selection before activation. Test EOF exits, command errors continue, Prompt errors render and continue, SIGINT during `isRunning` calls `abort()`, and `close()` is idempotent.

- [ ] **Step 5: Verify ReadlineUi is missing**

Run: `npm run typecheck`

Expected: FAIL because `ReadlineUi` and its exports do not exist.

- [ ] **Step 6: Implement constructor and stable Interaction ownership**

Accept injected `readline`, `input`, `write`, `log`, and `reportError: (error: unknown) => void` in an inline options object for tests; production defaults create Node readline/promises. Construct exactly one `ReadlineInteractions` using the same question function. `ReadlineUi` reports caught action/render errors through `reportError` but does not import Config or inspect secrets. Do not create an application/controller object.

- [ ] **Step 7: Implement atomic activate()**

```ts
private async activate(candidate: AgentHarness): Promise<boolean> {
  if (!await this.ensureConfiguredModel(candidate)) return false;
  this.unsubscribe();
  this.current = candidate;
  this.renderer.renderSession(candidate);
  this.unsubscribe = candidate.subscribe((event) => this.renderer.handle(event));
  return true;
}
```

`ensureConfiguredModel()` returns `false` when selection is cancelled and is called before changing old state. Initial `run()` calls `activate(initial)` once and returns without entering the prompt loop if it returns `false`; later command activation simply retains the old Harness on `false`.

- [ ] **Step 8: Implement the exact while loop and command dispatch**

Echo a Prompt before awaiting `current.prompt(text)`. Catch errors around each action, pass them to the injected `reportError`, and continue unless action is exit/EOF. Numbered selectors accept a one-based integer and treat blank input as cancel. Task 9 supplies a callback that applies `config.redact()` before terminal output.

- [ ] **Step 9: Install and remove SIGINT handling with the UI lifecycle**

When `current.isRunning` is true, SIGINT always calls `current.abort()`, including while Permission owns the readline question; the Run signal then rejects that Interaction. When no Run is active, leave ordinary readline input cancellation to the adapter. Remove the handler in `close()`, unsubscribe the current Harness, and close readline once.

- [ ] **Step 10: Export the new UI alongside temporary compatibility exports and run focused tests**

`src/ui/index.ts` exports `ReadlineUi`, `ReadlineInteractions`, `Renderer`, `UiAction`, and `parseInput`. Keep existing `Cli*` exports only until Task 9 so `src/index.ts`, import smoke tests, and the temporary main continue to compile.

Run: `npm run build && node --test dist/tests/ui/readline-ui.test.js dist/tests/ui/commands.test.js dist/tests/ui/interactions.test.js dist/tests/ui/renderer.test.js`

Expected: PASS, including sequential input and atomic Session switching.

- [ ] **Step 11: Commit**

```bash
git add src/ui/readline-ui.ts src/ui/index.ts tests/ui/readline-ui.test.ts
git commit -m "feat: run sessions through readline ui"
```

---

### Task 9: Compose production main, clean exports/dependencies, and update docs

**Files:**
- Replace: `src/main.ts`
- Modify: `src/index.ts`
- Modify: `src/coding-agent/factory.ts`
- Modify: `src/coding-agent/project/project.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/import-smoke.test.ts`
- Modify: `tests/coding-agent/project/factory.test.ts`
- Delete: `src/ui/cli-frontend.ts`
- Delete: `src/ui/cli-harness-renderer.ts`
- Delete: `src/ui/cli-interactions.ts`
- Delete: `tests/ui/cli-frontend.test.ts`
- Delete: `tests/ui/cli-harness-renderer.test.ts`
- Delete: `tests/ui/cli-interactions.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/architecture.md`
- Modify: `src/core/ai/README.md`
- Modify: `src/core/harness/README.md`
- Modify: `src/coding-agent/README.md`

**Interfaces:**
- Consumes: all Tasks 1–8.
- Produces: side-effect-free imported `main.ts`, executable guarded production entry, final public exports, and documented startup behavior.

- [ ] **Step 1: Replace main tests with composition behavior**

Export `main(argv = process.argv.slice(2))` without running it on import. Add tests for `selectInitialHarness(project, continueFlag)` using a fake Project:

```ts
test("continue opens the newest Session and falls back to create", async () => {
  assert.equal(await selectInitialHarness(projectWithSessions([newest, older]), true), restored);
  assert.equal(await selectInitialHarness(projectWithSessions([]), true), created);
  assert.equal(await selectInitialHarness(projectWithSessions([newest]), false), created);
});
```

Keep the child-process import test proving `import('./dist/src/main.js')` produces no stdout/stderr and does not open readline.

- [ ] **Step 2: Add production source guards to import smoke**

Update imports from `CliFrontend` to `ReadlineUi` and add type-only imports for `HarnessEvent`, `ProviderId`, and `RuntimeProviderConfig`. Add a source scan assertion that `src/main.ts` contains neither `dotenv` nor `process.env` credential names.

- [ ] **Step 3: Verify old main and exports fail the new tests**

Run: `npm run typecheck`

Expected: FAIL on missing new main helpers and stale CliFrontend exports.

- [ ] **Step 4: Implement production composition in the approved order**

Implement the startup sequence explicitly in this order:

1. Parse argv.
2. Compute `keaHome = resolve(homedir(), ".kea")`; for `init`, create missing templates and return before Project discovery.
3. Resolve the startup directory to its canonical Project directory.
4. Call `Config.load()` with user, Project, optional override, and CLI verbose inputs; its internals apply defaults and load auth in the specified order.
5. Create `ModelRuntime` from `config.runtimeProviders()`.
6. Define one downstream error callback that converts `unknown` to a message, applies `config.redact()`, and writes it once.
7. When `config.verbose` is true, use the same redacted output path to report the Project directory, configured Provider/model pairs, and `configured` credential status without values, lengths, prefixes, raw auth objects, or exception causes.
8. Construct `ReadlineUi` with `config.models`, display settings, and that `reportError` callback.
9. Call `openOrCreateProject()` with the canonical directory, `config.defaultModel`, UI interactions, flat runtime policies, and an `onListenerError` callback that uses the same redacted reporter.
10. For ordinary `kea`, create a new Harness. For `kea -c`, restore `project.listSessions()[0]` or create one when the list is empty.
11. Let the initial activation in `ui.run()` validate/repair the Harness model through the same configured-model selection used by later Session activation; cancellation during initial repair exits without entering the prompt loop.
12. Await the readline loop within `ui.run(project, initial)`.
13. Always call idempotent `ui.close()` in `finally`.

Do not unfold Config's internal file-reading stages back into main and do not add an Application object merely to represent this sequence.

Guard execution with an ESM main-module check:

```ts
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
```

After Config exists, route downstream diagnostics through `config.redact()`. Config-load errors are already source-aware and never include auth values.

- [ ] **Step 5: Remove dotenv from production dependencies**

Run: `npm uninstall dotenv`

Expected: `package.json` and `package-lock.json` no longer contain dotenv. Do not add another env-file package; Node 24 development scripts can use `node --env-file` directly.

- [ ] **Step 6: Remove the temporary compatibility slice and align package exports**

Delete the three old `cli-*` UI modules and their tests. Remove the temporary `cwd` branch and Git discovery helpers from `openOrCreateProject()`, delete its compatibility test, and make `Project.events` private. Keep root exports for core, coding-agent, and the new UI entry; remove every stale `Cli*` export. Application Config and argv/init helpers remain application-internal and are imported directly only by `main.ts` and tests.

- [ ] **Step 7: Update architecture and package READMEs from the implemented contracts**

Document:

- explicit Runtime providers and ModelConfig request routing;
- private Project Events plus Harness Session subscription;
- application-owned Project discovery;
- flat Project runtime policy;
- one Config, layered safe files, user-only auth, and no production dotenv;
- readline commands, linear prompt/Interaction flow, Session activation, and `kea init`.

Delete stale examples using `{ runtime, modelConfig } = createModelRuntime()`, `project.events`, `cwd` in `openOrCreateProject()`, or `CliFrontend`.

- [ ] **Step 8: Run focused main/import verification**

Run: `npm run build && node --test dist/tests/main.test.js dist/tests/import-smoke.test.js`

Expected: PASS; importing main is silent, and initial Session selection follows `kea`/`kea -c` rules.

- [ ] **Step 9: Run the complete verification suite**

Run: `npm run typecheck && npm test`

Expected: PASS with zero failing tests. Confirm `rg -n "dotenv|CliFrontend|CliHarnessRenderer|CliInteractions|project\\.events|LoadedConfiguration|ResolvedConfig" src tests docs/architecture.md src/core/*/README.md src/coding-agent/README.md` returns no stale production/design API references.

- [ ] **Step 10: Commit**

```bash
git add -A -- src/main.ts src/index.ts src/ui src/coding-agent/factory.ts src/coding-agent/project/project.ts tests/main.test.ts tests/import-smoke.test.ts tests/ui tests/coding-agent/project/factory.test.ts package.json package-lock.json docs/architecture.md src/core/ai/README.md src/core/harness/README.md src/coding-agent/README.md
git commit -m "feat: compose configured readline application"
```

---

## Final Review Checklist

- [ ] `git status --short` contains only intentional plan-execution changes before the final commit and is empty afterward.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0 with zero failing tests.
- [ ] Production `main.ts` never imports dotenv and never reads API Key environment variables.
- [ ] Ordinary config sources reject credential fields; only auth supplies API Keys.
- [ ] Config is the only application settings entity and keeps Provider credentials private.
- [ ] Project has no public raw Events; Harness subscriptions filter by Session and are idempotently removable.
- [ ] The outer readline loop never reads a second normal Prompt while Harness is running.
- [ ] Permission Interaction runs inside `await harness.prompt()` and propagates Run cancellation.
- [ ] Session/model switching preserves old state on candidate failure.
- [ ] `kea init` never overwrites either target file.
- [ ] No removed feature (`maxToolCalls`, memory, verification, multi-model Provider) appears in implementation config schema.
