# Provider 与协议分离、多模型配置实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 "provider" 与 "协议格式" 分离，支持任意命名的 provider（如 `deepseek`）配置 protocol/baseUrl/apiKey 与多个 model，并用显式 `defaultModel` 取代 `defaultProvider`；`/model` 按 provider 分组选择。

**Architecture:** `ModelConfig = { provider, model }` 形状不变，`provider` 语义改为"配置的 provider 名"；adapter map 以 provider 名为键，adapter 按 provider 的 `protocol`（`anthropic`/`openai`/`gemini`）构造。Config 的 `providers` 改为以任意 provider 名为键的对象，每项含 `protocol`、`baseUrl`、`models[]`；`defaultModel` 取代 `defaultProvider`。`/model` 两步选择。

**Tech Stack:** TypeScript (ES2024, NodeNext)、Node 内置 test runner、typebox。

**Spec:** `docs/superpowers/specs/2026-08-18-ai-provider-protocol-model-design.md`

## Global Constraints

- 协议标识固定为 `"anthropic" | "openai" | "gemini"`（`ProtocolId`）。
- provider 名是任意非空字符串（trim 后非空），不限制为协议名。
- `defaultModel` 必填：`{ provider, model }`，provider 必须已配置且 model 必须在该 provider 的 `models` 列表中。
- 凭据只来自 `~/.kea/auth.json`（按 provider 名存 apiKey）；普通配置源继续拒绝 `apiKey`/`token`/`secret`/`password`。
- `ModelConfig` 形状与 Session `model_selection` 持久化格式不变。
- `baseUrl` 缺省时使用协议内建默认值（anthropic → `https://api.anthropic.com`、openai → `https://api.openai.com/v1`、gemini → SDK 默认）。
- 生产 `main.ts` 不读 `process.env`、不调用 dotenv。
- 验证命令：`npm run typecheck`、`npm test`（先 `npm run build` 再跑 `dist/tests/**/*.test.js`）、`npm run build`。

---

### Task 1: ai 接口重构 + Config provider 结构（defaultModel）+ init 模板 + main 适配

> 说明：`config.ts` 与新模板必须同一任务落地——`main.test.ts` 会用首先生成的 init 模板跑完整启动，旧模板（`defaultProvider`）在新 `config.ts` 下是未知字段，分开提交会破坏构建。

**Files:**
- Modify: `src/core/ai/factory.ts`（整文件替换）
- Modify: `src/core/ai/index.ts`（整文件替换）
- Modify: `src/application/config.ts`（整文件替换）
- Modify: `src/application/init.ts:4-23`（`USER_CONFIG_TEMPLATE`）
- Modify: `src/main.ts:71-75`（`provider.id` → `provider.name`）
- Test: `tests/ai/factory.test.ts`（整文件替换）
- Test: `tests/application/config.test.ts`（整文件替换）
- Test: `tests/application/init.test.ts:9-28`（`USER_CONFIG_TEMPLATE` 常量）
- Test: `tests/import-smoke.test.ts:48-53,93`（`ProviderId` → `ProtocolId`）

**Interfaces:**
- Consumes: 现有 `Adapter`、`ResolvedOptions`、`lazyAdapter`、`createRoutedRuntime` 内部接口不变。
- Produces:
  - `ProtocolId = "anthropic" | "openai" | "gemini"`（从 `src/core/ai/factory.ts` 与 `index.ts` 导出）。
  - `RuntimeProviderConfig = { name: string; protocol: ProtocolId; apiKey: string; baseUrl?: string }`。
  - `createModelRuntime({ providers: readonly RuntimeProviderConfig[] }): ModelRuntime`。
  - `Config.models: readonly ModelConfig[]`（扁平，按配置插入顺序）；`Config.defaultModel: ModelConfig`；`Config.runtimeProviders(): readonly RuntimeProviderConfig[]`。

- [ ] **Step 1: 先替换测试，制造编译失败（red）**

将 `tests/ai/factory.test.ts` 替换为：

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRuntime,
  createModelRuntimeFromEnvironment,
  createRoutedRuntime,
  lazyAdapter,
} from "../../src/core/ai/factory.js";
import type { AssistantMessage } from "../../src/core/ai/types.js";
import type { ProtocolId } from "../../src/core/ai/factory.js";

test("explicit provider configuration is required and unique", () => {
  assert.throws(
    () => createModelRuntime({ providers: [] }),
    /at least one provider/i,
  );
  assert.throws(
    () => createModelRuntime({
      providers: [
        { name: "openai", protocol: "openai", apiKey: "a" },
        { name: "openai", protocol: "openai", apiKey: "b" },
      ],
    }),
    /duplicate provider.*openai/i,
  );
});

test("unknown protocols are rejected", () => {
  assert.throws(
    () => createModelRuntime({
      providers: [{ name: "custom", protocol: "watson" as ProtocolId, apiKey: "a" }],
    }),
    /unknown protocol.*watson/i,
  );
});

test("explicit providers construct a runtime", () => {
  const runtime = createModelRuntime({ providers: [{ name: "openai", protocol: "openai", apiKey: "key" }] });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
});

test("two providers may share one protocol", () => {
  const runtime = createModelRuntime({
    providers: [
      { name: "deepseek", protocol: "openai", apiKey: "a" },
      { name: "ollama", protocol: "openai", apiKey: "b" },
    ],
  });
  assert.equal(typeof runtime.stream, "function");
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

test("routed runtime rejects unknown providers at stream time", async () => {
  const runtime = createRoutedRuntime(new Map());
  await assert.rejects(
    (async () => {
      for await (const event of runtime.stream(
        { provider: "nonexistent", model: "m" },
        { messages: [] },
      )) void event;
    })(),
    /Unknown provider/,
  );
});

test("environment helper does not select a model", () => {
  const runtime = createModelRuntimeFromEnvironment({ OPENAI_API_KEY: "key" });
  assert.equal(typeof runtime.stream, "function");
  assert.equal(typeof runtime.complete, "function");
});

test("environment helper requires at least one provider key", () => {
  assert.throws(
    () => createModelRuntimeFromEnvironment({}),
    /at least one provider/i,
  );
});

test("environment helper ignores DEFAULT_PROVIDER and MODEL_ID", () => {
  const runtime = createModelRuntimeFromEnvironment({
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "b",
    DEFAULT_PROVIDER: "anthropic",
    MODEL_ID: "m",
  });
  assert.equal(typeof runtime.stream, "function");
});

test("complete returns the terminal assistant message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model: "test-model",
    stopReason: "stop",
    latencyMs: 0,
  };
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "text_delta" as const, text: "done" };
        yield { type: "done" as const, message: terminal };
      },
    }],
  ]));

  assert.equal(
    await runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
    terminal,
  );
});

test("complete returns an error terminal message", async () => {
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [],
    model: "test-model",
    stopReason: "error",
    errorMessage: "provider failed",
    latencyMs: 0,
  };
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "error" as const, message: terminal };
      },
    }],
  ]));

  assert.equal(
    await runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
    terminal,
  );
});

test("complete rejects when the stream has no terminal chunk", async () => {
  const runtime = createRoutedRuntime(new Map([
    ["test", {
      async *stream() {
        yield { type: "text_delta" as const, text: "partial" };
      },
    }],
  ]));

  await assert.rejects(
    runtime.complete({ provider: "test", model: "test-model" }, { messages: [] }),
    /without a done or error terminal chunk/,
  );
});

test("lazy adapter reuses the loaded adapter across stream calls", async () => {
  let loads = 0;
  const adapter = lazyAdapter(async () => {
    loads += 1;
    return {
      async *stream(model: string) {
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
    };
  });

  for await (const event of adapter.stream(
    "one",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  )) void event;
  for await (const event of adapter.stream(
    "two",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  )) void event;

  assert.equal(loads, 1);
});

test("lazy adapter loads on iteration and forwards failures", async () => {
  const failure = new Error("load failed");
  let loads = 0;
  const adapter = lazyAdapter(async () => {
    loads += 1;
    throw failure;
  });

  const stream = adapter.stream(
    "model",
    { messages: [] },
    { timeout: 120, maxTokens: 8000 },
  );
  assert.equal(loads, 0);

  await assert.rejects(
    (async () => {
      for await (const event of stream) void event;
    })(),
    (error) => error === failure,
  );
  assert.equal(loads, 1);
});
```

将 `tests/application/config.test.ts` 替换为（新结构、defaultModel 校验、多 provider/多 model）：

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Config, ConfigurationError } from "../../src/application/config.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-config-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const fullAuth = {
  providers: {
    anthropic: { apiKey: "ak-anthropic" },
    openai: { apiKey: "ak-openai" },
    gemini: { apiKey: "ak-gemini" },
  },
};

const openaiProvider = {
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-5", "gpt-5-mini"],
};

async function configFixture(options: {
  readonly user?: Readonly<Record<string, unknown>>;
  readonly project?: Readonly<Record<string, unknown>>;
  readonly override?: Readonly<Record<string, unknown>>;
  readonly auth?: Readonly<Record<string, unknown>>;
}): Promise<{
  readonly keaHome: string;
  readonly projectDirectory: string;
  readonly overridePath: string;
}> {
  const keaHome = await tempDir();
  const projectDirectory = await tempDir();
  const overridePath = join(keaHome, "override.json");
  try {
    if (options.user !== undefined) {
      await writeJson(join(keaHome, "config.json"), options.user);
    }
    if (options.project !== undefined) {
      await mkdir(join(projectDirectory, ".kea"));
      await writeJson(join(projectDirectory, ".kea", "config.json"), options.project);
    }
    if (options.override !== undefined) {
      await writeJson(overridePath, options.override);
    }
    if (options.auth !== undefined) {
      await writeJson(join(keaHome, "auth.json"), options.auth);
    }
    return { keaHome, projectDirectory, overridePath };
  } catch (error) {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function loadWith(
  fixture: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly overridePath: string;
  },
  options?: { readonly configOverride?: string; readonly verbose?: boolean },
): Promise<Config> {
  return Config.load({
    keaHome: fixture.keaHome,
    projectDirectory: fixture.projectDirectory,
    ...(options?.configOverride === undefined
      ? {}
      : { configOverride: options.configOverride }),
    verbose: options?.verbose ?? false,
  });
}

async function cleanUp(fixture: {
  readonly keaHome: string;
  readonly projectDirectory: string;
}): Promise<void> {
  await rm(fixture.keaHome, { recursive: true, force: true });
  await rm(fixture.projectDirectory, { recursive: true, force: true });
}

test("load applies defaults, user, project, override, and CLI in order", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "user-model" },
      providers: { openai: openaiProvider },
      agent: { maxTurns: 10 },
    },
    project: {
      providers: { openai: { models: ["project-model"] } },
      tools: { timeoutSeconds: 30 },
    },
    override: {
      defaultModel: { provider: "openai", model: "override-model" },
      providers: { openai: { protocol: "openai", models: ["override-model"] } },
      ui: { thinking: "visible" },
    },
    auth: { providers: { openai: { apiKey: "secret-key" } } },
  });
  try {
    const config = await loadWith(fixture, {
      configOverride: fixture.overridePath,
      verbose: true,
    });

    assert.equal(config.maxTurns, 10);
    assert.equal(config.toolTimeoutSeconds, 30);
    assert.equal(config.thinking, "visible");
    assert.equal(config.toolDetails, "compact");
    assert.equal(config.verbose, true);
    assert.deepEqual(config.defaultModel, {
      provider: "openai",
      model: "override-model",
    });
    assert.deepEqual(config.models, [
      { provider: "openai", model: "override-model" },
    ]);
    assert.deepEqual(config.runtimeProviders(), [
      {
        name: "openai",
        protocol: "openai",
        apiKey: "secret-key",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("defaults apply when only a Provider is configured", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "gpt-test" },
      providers: { openai: { protocol: "openai", models: ["gpt-test"] } },
    },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(fixture);

    assert.equal(config.maxTurns, 20);
    assert.equal(config.toolTimeoutSeconds, 120);
    assert.equal(config.thinking, "hidden");
    assert.equal(config.toolDetails, "compact");
    assert.equal(config.verbose, false);
    assert.deepEqual(config.defaultModel, { provider: "openai", model: "gpt-test" });
  } finally {
    await cleanUp(fixture);
  }
});

test("missing user and Project config files are skipped", async () => {
  const fixture = await configFixture({
    override: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(fixture, {
      configOverride: fixture.overridePath,
    });

    assert.deepEqual(config.models, [{ provider: "openai", model: "m" }]);
    assert.deepEqual(config.defaultModel, { provider: "openai", model: "m" });
  } finally {
    await cleanUp(fixture);
  }
});

test("a missing explicit --config file fails", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: fullAuth,
  });
  try {
    const missing = join(fixture.keaHome, "missing.json");
    await assert.rejects(
      loadWith(fixture, { configOverride: missing }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.sourcePath, missing);
        assert.equal(error.fieldPath, undefined);
        assert.match(error.message, /file not found/i);
        return true;
      },
    );
  } finally {
    await cleanUp(fixture);
  }
});

test("malformed JSON reports the source path without raw content", async () => {
  const keaHome = await tempDir();
  const projectDirectory = await tempDir();
  try {
    const userPath = join(keaHome, "config.json");
    await writeFile(userPath, '{"agent": \n', "utf8");
    await assert.rejects(
      Config.load({ keaHome, projectDirectory, verbose: false }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.sourcePath, userPath);
        assert.equal(error.fieldPath, undefined);
        assert.match(error.message, /invalid JSON/i);
        assert.ok(!error.message.includes('{"agent"'));
        return true;
      },
    );
  } finally {
    await rm(keaHome, { recursive: true, force: true });
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("strict source validation reports the exact field path", async () => {
  for (const [document, field] of [
    [{ agent: { maxTurns: 0 } }, "agent.maxTurns"],
    [{ agent: { maxTurns: 1001 } }, "agent.maxTurns"],
    [{ agent: { maxTurns: 1.5 } }, "agent.maxTurns"],
    [{ tools: { timeoutSeconds: 3601 } }, "tools.timeoutSeconds"],
    [{ tools: { timeoutSeconds: 0 } }, "tools.timeoutSeconds"],
    [{ ui: { thinking: "sometimes" } }, "ui.thinking"],
    [{ ui: { toolDetails: "detailed" } }, "ui.toolDetails"],
    [{ ui: { thinking: null } }, "ui.thinking"],
    [{ agent: null }, "agent"],
    [{ defaultModel: null }, "defaultModel"],
    [{ defaultModel: { provider: "" } }, "defaultModel.provider"],
    [{ defaultModel: { provider: "openai", model: "" } }, "defaultModel.model"],
    [{ defaultModel: { provider: "openai", model: "m", extra: true } }, "defaultModel"],
    [{ defaultModel: { provider: "openai" } }, "defaultModel.model"],
    [{ providers: { openai: { protocol: "watson" } } }, "providers.openai.protocol"],
    [{ providers: { openai: { protocol: "openai", baseUrl: "relative" } } }, "providers.openai.baseUrl"],
    [{ providers: { openai: { protocol: "openai", baseUrl: "ftp://files" } } }, "providers.openai.baseUrl"],
    [{ providers: { openai: { protocol: "openai", models: [] } } }, "providers.openai.models"],
    [{ providers: { openai: { protocol: "openai", models: [""] } } }, "providers.openai.models"],
    [{ providers: { openai: { protocol: "openai", models: ["a", "a"] } } }, "providers.openai.models"],
    [{ providers: { openai: { protocol: "openai", models: null } } }, "providers.openai.models"],
    [{ providers: { openai: { protocol: "openai", extra: 1 } } }, "providers.openai"],
    [{ providers: { "": { protocol: "openai", models: ["m"] } } }, "providers."],
    [{ memory: { maxResults: 5 } }, "memory"],
    [{ verification: { enabled: true } }, "verification"],
    [{ agent: { maxToolCalls: 5 } }, "agent.maxToolCalls"],
    [{ verbose: true }, "verbose"],
  ] as const) {
    const fixture = await configFixture({
      user: { ...document },
      auth: fullAuth,
    });
    try {
      await assert.rejects(
        loadWith(fixture),
        (error: unknown) => {
          assert.ok(
            error instanceof ConfigurationError,
            `unexpected error: ${String(error)}`,
          );
          assert.equal(error.fieldPath, field);
          assert.match(error.message, new RegExp(field.replaceAll(".", "\\.")));
          assert.equal(error.sourcePath, join(fixture.keaHome, "config.json"));
          return true;
        },
      );
    } finally {
      await cleanUp(fixture);
    }
  }
});

test("credential fields are rejected in every ordinary source", async () => {
  for (const name of ["apiKey", "token", "secret", "password"] as const) {
    const fixture = await configFixture({
      user: {
        defaultModel: { provider: "openai", model: "m" },
        providers: { openai: { protocol: "openai", models: ["m"], [name]: "hunter2" } },
      },
      auth: fullAuth,
    });
    try {
      await assert.rejects(
        loadWith(fixture),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(error.fieldPath, `providers.openai.${name}`);
          assert.match(
            error.message,
            /credentials are only allowed in ~\/\.kea\/auth\.json/i,
          );
          assert.ok(!error.message.includes("hunter2"));
          return true;
        },
      );
    } finally {
      await cleanUp(fixture);
    }
  }

  for (const layer of ["project", "override"] as const) {
    const fixture = await configFixture({
      user: {
        defaultModel: { provider: "openai", model: "m" },
        providers: { openai: { protocol: "openai", models: ["m"] } },
      },
      ...(layer === "project"
        ? { project: { providers: { openai: { protocol: "openai", models: ["m"], apiKey: "hunter2" } } } }
        : {}),
      ...(layer === "override"
        ? { override: { providers: { openai: { protocol: "openai", models: ["m"], apiKey: "hunter2" } } } }
        : {}),
      auth: fullAuth,
    });
    try {
      await assert.rejects(
        loadWith(fixture, {
          ...(layer === "override" ? { configOverride: fixture.overridePath } : {}),
        }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(error.fieldPath, "providers.openai.apiKey");
          assert.match(
            error.message,
            /credentials are only allowed in ~\/\.kea\/auth\.json/i,
          );
          return true;
        },
      );
    } finally {
      await cleanUp(fixture);
    }
  }
});

test("an invalid lower-priority source fails before merging", async () => {
  const fixture = await configFixture({
    user: { agent: { maxTurns: 0 } },
    project: {
      agent: { maxTurns: 5 },
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(fixture),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "agent.maxTurns");
        assert.equal(error.sourcePath, join(fixture.keaHome, "config.json"));
        return true;
      },
    );
  } finally {
    await cleanUp(fixture);
  }
});

test("missing auth or empty keys for enabled Providers fail", async () => {
  const withoutAuth = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
  });
  try {
    await assert.rejects(
      loadWith(withoutAuth),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.sourcePath, join(withoutAuth.keaHome, "auth.json"));
        assert.match(error.message, /auth file not found/i);
        return true;
      },
    );
  } finally {
    await cleanUp(withoutAuth);
  }

  const emptyKey = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: { providers: { openai: { apiKey: "" } } },
  });
  try {
    await assert.rejects(
      loadWith(emptyKey),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.sourcePath, join(emptyKey.keaHome, "auth.json"));
        assert.equal(error.fieldPath, "providers.openai.apiKey");
        assert.match(error.message, /must be non-empty/i);
        return true;
      },
    );
  } finally {
    await cleanUp(emptyKey);
  }

  const missingEntry = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: { providers: { anthropic: { apiKey: "spare-key" } } },
  });
  try {
    await assert.rejects(
      loadWith(missingEntry),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "providers.openai.apiKey");
        assert.match(error.message, /must be non-empty/i);
        return true;
      },
    );
  } finally {
    await cleanUp(missingEntry);
  }
});

test("extra credentials for a disabled provider are ignored", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: {
      providers: {
        openai: { apiKey: "secret-key" },
        deepseek: { apiKey: "spare-key" },
      },
    },
  });
  try {
    const config = await loadWith(fixture);
    assert.deepEqual(config.runtimeProviders(), [
      { name: "openai", protocol: "openai", apiKey: "secret-key" },
    ]);
    assert.deepEqual(config.models, [{ provider: "openai", model: "m" }]);
  } finally {
    await cleanUp(fixture);
  }
});

test("unknown provider names in auth are tolerated and ignored", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: {
      providers: {
        openai: { apiKey: "secret-key" },
        watson: { apiKey: "k" },
      },
    },
  });
  try {
    const config = await loadWith(fixture);
    assert.deepEqual(config.runtimeProviders(), [
      { name: "openai", protocol: "openai", apiKey: "secret-key" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("no Provider, missing protocol, and empty models fail cross-field", async () => {
  const noProvider = await configFixture({ user: {}, auth: fullAuth });
  try {
    await assert.rejects(
      loadWith(noProvider),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "providers");
        assert.match(error.message, /at least one provider/i);
        return true;
      },
    );
  } finally {
    await cleanUp(noProvider);
  }

  const missingProtocol = await configFixture({
    user: { providers: { openai: { models: ["m"] } } },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(missingProtocol),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "providers.openai.protocol");
        assert.match(error.message, /expected "anthropic", "openai" or "gemini"/i);
        return true;
      },
    );
  } finally {
    await cleanUp(missingProtocol);
  }

  const missingModels = await configFixture({
    user: { providers: { openai: { protocol: "openai" } } },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(missingModels),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "providers.openai.models");
        assert.match(error.message, /non-empty/i);
        return true;
      },
    );
  } finally {
    await cleanUp(missingModels);
  }
});

test("defaultModel is required and must reference a configured provider model", async () => {
  const missing = await configFixture({
    user: { providers: { openai: { protocol: "openai", models: ["m"] } } },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(missing),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "defaultModel");
        assert.match(error.message, /must be specified/i);
        return true;
      },
    );
  } finally {
    await cleanUp(missing);
  }

  const dangling = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: { anthropic: { protocol: "anthropic", models: ["n"] } },
    },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(dangling),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "defaultModel");
        assert.match(error.message, /reference a configured provider/i);
        return true;
      },
    );
  } finally {
    await cleanUp(dangling);
  }

  const notListed = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "nope" },
      providers: { openai: { protocol: "openai", models: ["m"] } },
    },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(notListed),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "defaultModel.model");
        assert.match(error.message, /listed in provider "openai" models/i);
        return true;
      },
    );
  } finally {
    await cleanUp(notListed);
  }
});

test("models follow the config insertion order across providers", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "anthropic", model: "claude-x" },
      providers: {
        deepseek: { protocol: "openai", models: ["ds-chat", "ds-reason"] },
        anthropic: { protocol: "anthropic", models: ["claude-x"] },
      },
    },
    auth: {
      providers: {
        deepseek: { apiKey: "ak-ds" },
        anthropic: { apiKey: "ak-anthropic" },
      },
    },
  });
  try {
    const config = await loadWith(fixture);

    assert.deepEqual(config.models, [
      { provider: "deepseek", model: "ds-chat" },
      { provider: "deepseek", model: "ds-reason" },
      { provider: "anthropic", model: "claude-x" },
    ]);
    assert.deepEqual(config.defaultModel, {
      provider: "anthropic",
      model: "claude-x",
    });
    assert.deepEqual(config.runtimeProviders(), [
      { name: "deepseek", protocol: "openai", apiKey: "ak-ds" },
      { name: "anthropic", protocol: "anthropic", apiKey: "ak-anthropic" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("two providers may share one protocol in runtimeProviders", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "deepseek", model: "ds" },
      providers: {
        deepseek: { protocol: "openai", models: ["ds"] },
        ollama: { protocol: "openai", models: ["llama"] },
      },
    },
    auth: { providers: { deepseek: { apiKey: "a" }, ollama: { apiKey: "b" } } },
  });
  try {
    const config = await loadWith(fixture);
    assert.deepEqual(config.models, [
      { provider: "deepseek", model: "ds" },
      { provider: "ollama", model: "llama" },
    ]);
    assert.deepEqual(config.runtimeProviders(), [
      { name: "deepseek", protocol: "openai", apiKey: "a" },
      { name: "ollama", protocol: "openai", apiKey: "b" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("runtimeProviders carries base URLs and per-Provider deep merge", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "project-model" },
      providers: {
        openai: {
          protocol: "openai",
          baseUrl: "https://custom.example/v1",
          models: ["user-model", "user-model-2"],
        },
      },
    },
    project: { providers: { openai: { models: ["project-model"] } } },
    auth: { providers: { openai: { apiKey: "secret-key" } } },
  });
  try {
    const config = await loadWith(fixture);

    assert.deepEqual(config.models, [
      { provider: "openai", model: "project-model" },
    ]);
    assert.deepEqual(config.runtimeProviders(), [
      {
        name: "openai",
        protocol: "openai",
        apiKey: "secret-key",
        baseUrl: "https://custom.example/v1",
      },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("redact replaces every loaded non-empty key without lengths or prefixes", async () => {
  const fixture = await configFixture({
    user: {
      defaultModel: { provider: "openai", model: "m" },
      providers: {
        openai: { protocol: "openai", models: ["m"] },
        anthropic: { protocol: "anthropic", models: ["n"] },
      },
    },
    auth: {
      providers: {
        openai: { apiKey: "secret-key" },
        anthropic: { apiKey: "sensitive-anthropic" },
      },
    },
  });
  try {
    const config = await loadWith(fixture);

    assert.equal(
      config.redact("failed with secret-key and sensitive-anthropic"),
      "failed with [REDACTED] and [REDACTED]",
    );
    assert.equal(config.redact("secret is sensitive"), "secret is sensitive");
    assert.ok(!config.redact("use secret-key now").includes("secret-key"));
  } finally {
    await cleanUp(fixture);
  }
});
```

将 `tests/import-smoke.test.ts:48-53` 中：

```ts
import type {
  ModelRuntime,
  ProviderId,
  RuntimeProviderConfig,
  StreamChunk,
} from "../src/core/ai/index.js";
```

改为：

```ts
import type {
  ModelRuntime,
  ProtocolId,
  RuntimeProviderConfig,
  StreamChunk,
} from "../src/core/ai/index.js";
```

并将第 93 行 `type PublicAiTypes = [ModelRuntime, ProviderId, RuntimeProviderConfig, StreamChunk];` 改为 `type PublicAiTypes = [ModelRuntime, ProtocolId, RuntimeProviderConfig, StreamChunk];`。

同时把 `tests/application/init.test.ts` 中的 `USER_CONFIG_TEMPLATE` 常量（第 9-28 行）替换为：

```ts
const USER_CONFIG_TEMPLATE = `{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-5"
  },
  "providers": {
    "openai": {
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": [
        "gpt-5"
      ]
    }
  },
  "agent": {
    "maxTurns": 20
  },
  "tools": {
    "timeoutSeconds": 120
  },
  "ui": {
    "thinking": "hidden",
    "toolDetails": "compact"
  }
}
`;
```

（`AUTH_TEMPLATE` 保持不变。）

- [ ] **Step 2: 运行 typecheck 确认失败（red）**

Run: `npm run typecheck`
Expected: FAIL — `factory.ts` 无 `ProtocolId` 导出、`RuntimeProviderConfig` 无 `name`/`protocol`、`config.ts` 仍引用 `ProviderId`/`defaultProvider` 等类型错误。

- [ ] **Step 3: 替换 `src/core/ai/factory.ts`**

整文件替换为：

```ts
import type {
  Context,
  ModelConfig,
  ModelRuntime,
  StreamChunk,
  StreamOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 120;
const DEFAULT_MAX_TOKENS = 8000;

// ── Resolved options ──

export interface ResolvedOptions {
  timeout: number;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
  signal?: AbortSignal;
}

function resolveOptions(options?: Partial<StreamOptions>): ResolvedOptions {
  return { timeout: DEFAULT_TIMEOUT, maxTokens: DEFAULT_MAX_TOKENS, ...options };
}

// ── Adapter ──

export interface Adapter {
  stream(model: string, context: Context, options: ResolvedOptions): AsyncIterable<StreamChunk>;
}

// ── Lazy loading ──

export function lazyAdapter(load: () => Promise<Adapter>): Adapter {
  let loaded: Promise<Adapter> | undefined;
  const getAdapter = (): Promise<Adapter> => {
    loaded ??= load();
    return loaded;
  };

  return {
    async *stream(model, context, options) {
      const adapter = await getAdapter();
      yield* adapter.stream(model, context, options);
    },
  };
}

// ── Protocol registry ──

/** Wire-protocol identifier, independent of the configured provider name. */
export type ProtocolId = "anthropic" | "openai" | "gemini";

export interface RuntimeProviderConfig {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

const BUILTIN_PROTOCOLS: readonly {
  readonly id: ProtocolId;
  readonly envApiKey: string;
  readonly envBaseUrl?: string;
  readonly defaultBaseUrl?: string;
  readonly createAdapter: (apiKey: string, baseUrl?: string | null) => Adapter;
}[] = [
  {
    id: "anthropic",
    envApiKey: "ANTHROPIC_API_KEY",
    envBaseUrl: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { AnthropicAdapter } = await import("./adapters/anthropic.js");
        return new AnthropicAdapter(apiKey, baseUrl);
      }),
  },
  {
    id: "openai",
    envApiKey: "OPENAI_API_KEY",
    envBaseUrl: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { OpenAIAdapter } = await import("./adapters/openai.js");
        return new OpenAIAdapter(apiKey, baseUrl);
      }),
  },
  {
    id: "gemini",
    envApiKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { GeminiAdapter } = await import("./adapters/gemini.js");
        return new GeminiAdapter(apiKey, baseUrl);
      }),
  },
];

// ── Routed runtime ──

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
        if (event.type === "done" || event.type === "error") {
          return event.message;
        }
      }
      throw new Error(
        "Model stream ended without a done or error terminal chunk",
      );
    },
  };
}

// ── Model runtime factories ──

export function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime {
  if (options.providers.length === 0) {
    throw new Error("At least one provider must be configured");
  }

  const adapters = new Map<string, Adapter>();
  for (const provider of options.providers) {
    if (adapters.has(provider.name)) {
      throw new Error(`Duplicate provider: ${provider.name}`);
    }
    const builtin = BUILTIN_PROTOCOLS.find((p) => p.id === provider.protocol);
    if (builtin === undefined) {
      throw new Error(`Unknown protocol: ${provider.protocol}`);
    }
    adapters.set(
      provider.name,
      builtin.createAdapter(provider.apiKey, provider.baseUrl ?? builtin.defaultBaseUrl ?? null),
    );
  }
  return createRoutedRuntime(adapters);
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** Development/test helper: map provider keys and base URLs into explicit providers. */
export function createModelRuntimeFromEnvironment(env: Environment): ModelRuntime {
  const providers: RuntimeProviderConfig[] = [];
  for (const builtin of BUILTIN_PROTOCOLS) {
    const apiKey = env[builtin.envApiKey];
    if (apiKey === undefined || apiKey === "") continue;
    const baseUrl = builtin.envBaseUrl === undefined
      ? undefined
      : env[builtin.envBaseUrl];
    providers.push({
      name: builtin.id,
      protocol: builtin.id,
      apiKey,
      ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl }),
    });
  }
  return createModelRuntime({ providers });
}
```

- [ ] **Step 4: 替换 `src/core/ai/index.ts`**

整文件替换为：

```ts
export type {
  AssistantMessage,
  ContentBlock,
  Context,
  Message,
  ModelConfig,
  ModelRuntime,
  StopReason,
  StreamChunk,
  StreamOptions,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "./types.js";
export { createModelRuntime, createModelRuntimeFromEnvironment } from "./factory.js";
export type { ProtocolId, RuntimeProviderConfig } from "./factory.js";
```

- [ ] **Step 5: 替换 `src/application/config.ts`**

整文件替换为：

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelConfig } from "../core/ai/types.js";
import type { ProtocolId, RuntimeProviderConfig } from "../core/ai/index.js";

const PROTOCOLS: readonly ProtocolId[] = ["anthropic", "openai", "gemini"];
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "token",
  "secret",
  "password",
]);

/** An error from one named configuration source, with its field path. */
export class ConfigurationError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly fieldPath: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `${sourcePath}${fieldPath === undefined ? "" : `: ${fieldPath}`}: ${message}`,
      options,
    );
    this.name = "ConfigurationError";
  }
}

// ── Per-source parsing (validated before any merge) ──

/** One ordinary config.json source: all fields optional, already validated. */
interface ParsedOrdinary {
  defaultModel?: { readonly provider: string; readonly model: string };
  providers?: Readonly<Record<string, ProviderFields>>;
  agent?: { maxTurns?: number };
  tools?: { timeoutSeconds?: number };
  ui?: { thinking?: "hidden" | "visible"; toolDetails?: "compact" | "full" };
}

interface ProviderFields {
  readonly protocol?: ProtocolId;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
}

function parseOrdinarySource(path: string, value: unknown): ParsedOrdinary {
  assertObject(path, undefined, value);
  rejectCredentials(path, undefined, value);
  assertOnlyKeys(path, undefined, value, [
    "defaultModel",
    "providers",
    "agent",
    "tools",
    "ui",
  ]);

  const parsed: ParsedOrdinary = {};

  const defaultModel = value["defaultModel"];
  if (defaultModel !== undefined) {
    const dmPath = "defaultModel";
    assertObject(path, dmPath, defaultModel);
    rejectCredentials(path, dmPath, defaultModel);
    assertOnlyKeys(path, dmPath, defaultModel, ["provider", "model"]);
    const provider = defaultModel["provider"];
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new ConfigurationError(
        path,
        `${dmPath}.provider`,
        "must be a non-empty string",
      );
    }
    const model = defaultModel["model"];
    if (typeof model !== "string" || model.trim() === "") {
      throw new ConfigurationError(
        path,
        `${dmPath}.model`,
        "must be a non-empty string",
      );
    }
    parsed.defaultModel = { provider, model };
  }

  const providers = value["providers"];
  if (providers !== undefined) {
    assertObject(path, "providers", providers);
    rejectCredentials(path, "providers", providers);
    const fields: Record<string, ProviderFields> = {};
    for (const name of Object.keys(providers)) {
      if (name.trim() === "") {
        throw new ConfigurationError(
          path,
          `providers.${name}`,
          "provider name must be non-empty",
        );
      }
      const entry = providers[name];
      const providerPath = `providers.${name}`;
      assertObject(path, providerPath, entry);
      rejectCredentials(path, providerPath, entry);
      assertOnlyKeys(path, providerPath, entry, ["protocol", "baseUrl", "models"]);
      const protocol = entry["protocol"];
      if (protocol !== undefined) {
        if (
          typeof protocol !== "string"
          || !PROTOCOLS.includes(protocol as ProtocolId)
        ) {
          throw new ConfigurationError(
            path,
            `${providerPath}.protocol`,
            `expected "${PROTOCOLS.join('", "')}"`,
          );
        }
      }
      const baseUrl = entry["baseUrl"];
      if (baseUrl !== undefined) {
        assertAbsoluteHttpUrl(path, `${providerPath}.baseUrl`, baseUrl);
      }
      const models = entry["models"];
      if (models !== undefined) {
        assertModels(path, `${providerPath}.models`, models);
      }
      fields[name] = {
        ...(protocol === undefined ? {} : { protocol: protocol as ProtocolId }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(models === undefined ? {} : { models }),
      };
    }
    parsed.providers = fields;
  }

  const agent = value["agent"];
  if (agent !== undefined) {
    const agentPath = "agent";
    assertObject(path, agentPath, agent);
    rejectCredentials(path, agentPath, agent);
    assertOnlyKeys(path, agentPath, agent, ["maxTurns"]);
    const maxTurns = agent["maxTurns"];
    if (maxTurns !== undefined) {
      if (
        typeof maxTurns !== "number"
        || !Number.isInteger(maxTurns)
        || maxTurns < 1
        || maxTurns > 1000
      ) {
        throw new ConfigurationError(
          path,
          `${agentPath}.maxTurns`,
          "expected an integer from 1 to 1000",
        );
      }
      parsed.agent = { maxTurns };
    }
  }

  const tools = value["tools"];
  if (tools !== undefined) {
    const toolsPath = "tools";
    assertObject(path, toolsPath, tools);
    rejectCredentials(path, toolsPath, tools);
    assertOnlyKeys(path, toolsPath, tools, ["timeoutSeconds"]);
    const timeoutSeconds = tools["timeoutSeconds"];
    if (timeoutSeconds !== undefined) {
      if (
        typeof timeoutSeconds !== "number"
        || !Number.isFinite(timeoutSeconds)
        || timeoutSeconds <= 0
        || timeoutSeconds > 3600
      ) {
        throw new ConfigurationError(
          path,
          `${toolsPath}.timeoutSeconds`,
          "expected a finite number from 1 to 3600",
        );
      }
      parsed.tools = { timeoutSeconds };
    }
  }

  const ui = value["ui"];
  if (ui !== undefined) {
    const uiPath = "ui";
    assertObject(path, uiPath, ui);
    rejectCredentials(path, uiPath, ui);
    assertOnlyKeys(path, uiPath, ui, ["thinking", "toolDetails"]);
    const thinking = ui["thinking"];
    if (thinking !== undefined) {
      assertEnum(path, `${uiPath}.thinking`, thinking, ["hidden", "visible"]);
    }
    const toolDetails = ui["toolDetails"];
    if (toolDetails !== undefined) {
      assertEnum(path, `${uiPath}.toolDetails`, toolDetails, ["compact", "full"]);
    }
    parsed.ui = {
      ...(thinking === undefined ? {} : { thinking: thinking as "hidden" | "visible" }),
      ...(toolDetails === undefined ? {} : { toolDetails: toolDetails as "compact" | "full" }),
    };
  }

  return parsed;
}

/** The auth file: provider names to API keys, possibly empty until filled in. */
function parseAuth(
  path: string,
  value: unknown,
): Readonly<Record<string, string>> {
  assertObject(path, undefined, value);
  assertOnlyKeys(path, undefined, value, ["providers"]);
  const providers = value["providers"];
  if (providers === undefined) return {};
  assertObject(path, "providers", providers);
  const result: Record<string, string> = {};
  for (const name of Object.keys(providers)) {
    const entry = providers[name];
    const keyPath = `providers.${name}.apiKey`;
    assertObject(path, `providers.${name}`, entry);
    assertOnlyKeys(path, `providers.${name}`, entry, ["apiKey"]);
    const apiKey = entry["apiKey"];
    if (typeof apiKey !== "string") {
      throw new ConfigurationError(path, keyPath, "expected a string");
    }
    result[name] = apiKey;
  }
  return result;
}

function assertObject(
  path: string,
  fieldPath: string | undefined,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(path, fieldPath, "expected a JSON object");
  }
}

function rejectCredentials(
  path: string,
  fieldPath: string | undefined,
  value: Record<string, unknown>,
): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEYS.has(key)) {
      throw new ConfigurationError(
        path,
        fieldPath === undefined ? key : `${fieldPath}.${key}`,
        "credentials are only allowed in ~/.kea/auth.json",
      );
    }
  }
}

function assertOnlyKeys(
  path: string,
  fieldPath: string | undefined,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigurationError(
        path,
        fieldPath === undefined ? key : `${fieldPath}.${key}`,
        "unknown field",
      );
    }
  }
}

function assertEnum(
  path: string,
  fieldPath: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigurationError(
      path,
      fieldPath,
      `expected ${allowed.map((v) => `"${v}"`).join(" or ")}`,
    );
  }
}

function assertAbsoluteHttpUrl(
  path: string,
  fieldPath: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string") {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
}

function assertModels(
  path: string,
  fieldPath: string,
  value: unknown,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError(
      path,
      fieldPath,
      "must be a non-empty array of strings",
    );
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigurationError(
        path,
        fieldPath,
        "must be a non-empty array of strings",
      );
    }
    if (seen.has(item)) {
      throw new ConfigurationError(path, fieldPath, `duplicate model: ${item}`);
    }
    seen.add(item);
  }
}

// ── File reading ──

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigurationError(path, undefined, "cannot read file", { cause: error });
  }
  return parseJson(path, raw);
}

async function readRequiredJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(path, undefined, "file not found", { cause: error });
  }
  return parseJson(path, raw);
}

function parseJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(path, undefined, `invalid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

// ── Merging ──

/** The merged ordinary value: defaults are always present. */
interface ResolvedOrdinary {
  readonly defaultModel?: { readonly provider: string; readonly model: string };
  readonly providers: Readonly<Record<string, ProviderFields>>;
  readonly agent: { readonly maxTurns: number };
  readonly tools: { readonly timeoutSeconds: number };
  readonly ui: {
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
  };
}

function mergeOrdinary(base: ResolvedOrdinary, next: ParsedOrdinary): ResolvedOrdinary {
  const providers: Record<string, ProviderFields> = {};
  for (const name of Object.keys(base.providers)) {
    providers[name] = { ...base.providers[name], ...(next.providers?.[name] ?? {}) };
  }
  for (const name of Object.keys(next.providers ?? {})) {
    if (!(name in providers)) providers[name] = next.providers![name];
  }
  return {
    ...(next.defaultModel !== undefined
      ? { defaultModel: next.defaultModel }
      : base.defaultModel !== undefined
        ? { defaultModel: base.defaultModel }
        : {}),
    providers,
    agent: { maxTurns: next.agent?.maxTurns ?? base.agent.maxTurns },
    tools: { timeoutSeconds: next.tools?.timeoutSeconds ?? base.tools.timeoutSeconds },
    ui: {
      thinking: next.ui?.thinking ?? base.ui.thinking,
      toolDetails: next.ui?.toolDetails ?? base.ui.toolDetails,
    },
  };
}

// ── Cross-field validation and Config construction ──

interface ResolvedProvider {
  readonly protocol: ProtocolId;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly models: readonly string[];
}

function resolveProviders(
  merged: ResolvedOrdinary,
  mergedSourcePath: string,
  auth: Readonly<Record<string, string>> | undefined,
  authPath: string,
): {
  readonly defaultModel: { readonly provider: string; readonly model: string };
  readonly providers: ReadonlyMap<string, ResolvedProvider>;
} {
  const configured = Object.keys(merged.providers);
  if (configured.length === 0) {
    throw new ConfigurationError(mergedSourcePath, "providers", "at least one provider must be configured");
  }

  for (const name of configured) {
    const entry = merged.providers[name]!;
    const protocol = entry.protocol;
    if (protocol === undefined || !PROTOCOLS.includes(protocol)) {
      throw new ConfigurationError(
        mergedSourcePath,
        `providers.${name}.protocol`,
        `expected "${PROTOCOLS.join('", "')}"`,
      );
    }
    if (entry.models === undefined || entry.models.length === 0) {
      throw new ConfigurationError(
        mergedSourcePath,
        `providers.${name}.models`,
        "must be a non-empty array of strings",
      );
    }
  }

  const defaultModel = merged.defaultModel;
  if (defaultModel === undefined) {
    throw new ConfigurationError(mergedSourcePath, "defaultModel", "must be specified");
  }
  if (!Object.prototype.hasOwnProperty.call(merged.providers, defaultModel.provider)) {
    throw new ConfigurationError(
      mergedSourcePath,
      "defaultModel",
      `defaultModel must reference a configured provider: ${defaultModel.provider}`,
    );
  }
  const providerModels = merged.providers[defaultModel.provider]!.models ?? [];
  if (!providerModels.includes(defaultModel.model)) {
    throw new ConfigurationError(
      mergedSourcePath,
      "defaultModel.model",
      `model must be listed in provider "${defaultModel.provider}" models`,
    );
  }

  if (auth === undefined) {
    throw new ConfigurationError(authPath, "providers", "auth file not found");
  }

  const providers = new Map<string, ResolvedProvider>();
  for (const name of configured) {
    const apiKey = auth[name];
    if (apiKey === undefined || apiKey === "") {
      throw new ConfigurationError(authPath, `providers.${name}.apiKey`, "must be non-empty");
    }
    const entry = merged.providers[name]!;
    providers.set(name, {
      protocol: entry.protocol!,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
      apiKey,
      models: entry.models!,
    });
  }

  return { defaultModel, providers };
}

/**
 * The single application settings entity. Construction succeeds only when
 * every source is read, merged, validated, and all enabled Providers hold a
 * non-empty API Key from the auth file.
 */
export class Config {
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  readonly #providers: ReadonlyMap<string, ResolvedProvider>;
  readonly #defaultModel: { readonly provider: string; readonly model: string };

  private constructor(options: {
    readonly maxTurns: number;
    readonly toolTimeoutSeconds: number;
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
    readonly verbose: boolean;
    readonly defaultModel: { readonly provider: string; readonly model: string };
    readonly providers: ReadonlyMap<string, ResolvedProvider>;
  }) {
    this.maxTurns = options.maxTurns;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.thinking = options.thinking;
    this.toolDetails = options.toolDetails;
    this.verbose = options.verbose;
    this.#defaultModel = options.defaultModel;
    this.#providers = options.providers;
  }

  static async load(options: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly configOverride?: string;
    readonly verbose: boolean;
  }): Promise<Config> {
    const userPath = join(options.keaHome, "config.json");
    const projectPath = join(options.projectDirectory, ".kea", "config.json");
    const authPath = join(options.keaHome, "auth.json");

    const defaults: ResolvedOrdinary = {
      providers: {},
      agent: { maxTurns: 20 },
      tools: { timeoutSeconds: 120 },
      ui: { thinking: "hidden", toolDetails: "compact" },
    };

    const sources: readonly { readonly path: string; readonly required: boolean }[] = [
      { path: userPath, required: false },
      { path: projectPath, required: false },
      ...(options.configOverride === undefined
        ? []
        : [{ path: options.configOverride, required: true }]),
    ];

    let merged = defaults;
    let mergedSourcePath = userPath;
    for (const source of sources) {
      const value = source.required
        ? await readRequiredJson(source.path)
        : await readOptionalJson(source.path);
      if (value === undefined) continue;
      merged = mergeOrdinary(merged, parseOrdinarySource(source.path, value));
      mergedSourcePath = source.path;
    }

    const authValue = await readOptionalJson(authPath);
    const auth = authValue === undefined ? undefined : parseAuth(authPath, authValue);

    const resolved = resolveProviders(merged, mergedSourcePath, auth, authPath);

    return new Config({
      maxTurns: merged.agent.maxTurns,
      toolTimeoutSeconds: merged.tools.timeoutSeconds,
      thinking: merged.ui.thinking,
      toolDetails: merged.ui.toolDetails,
      verbose: options.verbose,
      defaultModel: resolved.defaultModel,
      providers: resolved.providers,
    });
  }

  /** All enabled model choices in config insertion order. */
  get models(): readonly ModelConfig[] {
    const models: ModelConfig[] = [];
    for (const [provider, entry] of this.#providers) {
      for (const model of entry.models) {
        models.push({ provider, model });
      }
    }
    return models;
  }

  get defaultModel(): ModelConfig {
    return { provider: this.#defaultModel.provider, model: this.#defaultModel.model };
  }

  /** Short-lived Provider connections for ModelRuntime construction. */
  runtimeProviders(): readonly RuntimeProviderConfig[] {
    return [...this.#providers].map(([name, entry]) => ({
      name,
      protocol: entry.protocol,
      apiKey: entry.apiKey,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
    }));
  }

  /** Replace every loaded non-empty API Key with [REDACTED]. */
  redact(message: string): string {
    let redacted = message;
    for (const entry of this.#providers.values()) {
      if (entry.apiKey !== "") {
        redacted = redacted.split(entry.apiKey).join("[REDACTED]");
      }
    }
    return redacted;
  }
}
```

- [ ] **Step 6: 修改 `src/main.ts` 的 verbose 日志**

在 `src/main.ts:71-75`，把：

```ts
    for (const provider of config.runtimeProviders()) {
      writeDiagnostic(
        `credentials: ${provider.id} ${provider.apiKey === "" ? "missing" : "configured"}`,
      );
    }
```

改为：

```ts
    for (const provider of config.runtimeProviders()) {
      writeDiagnostic(
        `credentials: ${provider.name} ${provider.apiKey === "" ? "missing" : "configured"}`,
      );
    }
```

- [ ] **Step 7: 替换 `src/application/init.ts` 的 `USER_CONFIG_TEMPLATE`**

把 `src/application/init.ts` 第 4-23 行的 `USER_CONFIG_TEMPLATE` 替换为：

```ts
const USER_CONFIG_TEMPLATE = `{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-5"
  },
  "providers": {
    "openai": {
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": [
        "gpt-5"
      ]
    }
  },
  "agent": {
    "maxTurns": 20
  },
  "tools": {
    "timeoutSeconds": 120
  },
  "ui": {
    "thinking": "hidden",
    "toolDetails": "compact"
  }
}
`;
```

- [ ] **Step 8: 运行 typecheck**

Run: `npm run typecheck`
Expected: PASS（无类型错误）。

- [ ] **Step 9: 运行测试**

Run: `npm test`
Expected: PASS。重点确认 `tests/ai/factory.test.ts`、`tests/application/config.test.ts`、`tests/application/init.test.ts`、`tests/import-smoke.test.ts` 与 `tests/main.test.ts` 全部通过（`main.test.ts` 依赖新模板能被新 config 接受）。

- [ ] **Step 10: 提交**

```bash
git add src/core/ai/factory.ts src/core/ai/index.ts src/application/config.ts src/application/init.ts src/main.ts tests/ai/factory.test.ts tests/application/config.test.ts tests/application/init.test.ts tests/import-smoke.test.ts
git commit -m "feat: separate provider protocol from provider config with multi-model support"
```

---

### Task 2: `/model` 按 provider 分组的两步选择

**Files:**
- Modify: `src/ui/cli/cli-ui.ts:163-173`（`chooseAndSwitchModel`）
- Test: `tests/ui/cli/cli-ui.test.ts`（`/model` 相关用例）

**Interfaces:**
- Consumes: `this.models: readonly ModelConfig[]`、`this.current!.model`、`this.current!.switchModel`、`this.chooseIndex`、`this.isSameModel`。
- Produces: 两步选择交互；`ensureConfiguredModel` 不变。

- [ ] **Step 1: 先改测试（red）**

在 `tests/ui/cli/cli-ui.test.ts` 中，把 test（第 240-256 行）：

```ts
test("/model selects only configured models and same model is a no-op", async () => {
  const models: readonly ModelConfig[] = [
    { provider: "openai", model: "gpt-5" },
    { provider: "anthropic", model: "claude-4" },
  ];
  const { readline, calls } = makeReadline(["/model", "1", "/model", "2", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(harness.switchModelCalls, [{ provider: "anthropic", model: "claude-4" }]);
  assert.equal(harness.model.provider, "anthropic");
});
```

替换为下面三个 test：

```ts
test("/model groups by provider and switches to the chosen model", async () => {
  const models: readonly ModelConfig[] = [
    { provider: "openai", model: "gpt-5" },
    { provider: "openai", model: "gpt-5-mini" },
    { provider: "anthropic", model: "claude-4" },
  ];
  const { readline, calls } = makeReadline(["/model", "2", "1", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(harness.switchModelCalls, [{ provider: "anthropic", model: "claude-4" }]);
  assert.equal(harness.model.provider, "anthropic");
  const text = calls.filter((call) => call.startsWith("render:")).join("");
  assert.ok(text.includes("Providers:"), text);
  assert.ok(text.includes("Models for anthropic:"), text);
});

test("/model selecting the current model is a no-op", async () => {
  const models: readonly ModelConfig[] = [
    { provider: "openai", model: "gpt-5" },
    { provider: "openai", model: "gpt-5-mini" },
  ];
  const { readline, calls } = makeReadline(["/model", "1", "1", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(harness.switchModelCalls, []);
});

test("/model cancels at either step without changing the model", async () => {
  const models: readonly ModelConfig[] = [
    { provider: "openai", model: "gpt-5" },
    { provider: "anthropic", model: "claude-4" },
  ];
  const { readline, calls } = makeReadline(["/model", "", "/model", "1", "", "/exit"]);
  const ui = makeUi({ models, readline, calls });

  const harness = makeHarness("1");
  const project = makeProject({ createHarness: async () => asHarness(harness) });

  await ui.run(project, asHarness(harness));
  ui.close();

  assert.deepEqual(harness.switchModelCalls, []);
});
```

- [ ] **Step 2: 运行测试确认失败（red）**

Run: `npm test -- --test-name-pattern "model"`
Expected: FAIL — 旧实现是单步选择，`/model` 后的两个输入与断言不匹配。

- [ ] **Step 3: 修改 `src/ui/cli/cli-ui.ts` 的 `chooseAndSwitchModel`**

把第 163-173 行：

```ts
  private async chooseAndSwitchModel(): Promise<void> {
    this.renderer.renderSelection(
      "Models:",
      this.models.map((model) => `${model.provider}/${model.model}`),
    );
    const index = await this.chooseIndex("Model number? ", this.models.length);
    if (index === undefined) return;
    const selected = this.models[index - 1]!;
    if (this.isSameModel(selected, this.current!.model)) return;
    await this.current!.switchModel(selected);
  }
```

替换为：

```ts
  private async chooseAndSwitchModel(): Promise<void> {
    const providerNames = [...new Set(this.models.map((model) => model.provider))];
    this.renderer.renderSelection("Providers:", providerNames);
    const providerIndex = await this.chooseIndex("Provider number? ", providerNames.length);
    if (providerIndex === undefined) return;
    const provider = providerNames[providerIndex - 1]!;
    const providerModels = this.models.filter((model) => model.provider === provider);
    this.renderer.renderSelection(
      `Models for ${provider}:`,
      providerModels.map((model) => model.model),
    );
    const modelIndex = await this.chooseIndex("Model number? ", providerModels.length);
    if (modelIndex === undefined) return;
    const selected = providerModels[modelIndex - 1]!;
    if (this.isSameModel(selected, this.current!.model)) return;
    await this.current!.switchModel(selected);
  }
```

- [ ] **Step 4: 运行测试确认通过（green）**

Run: `npm test -- --test-name-pattern "model"`
Expected: PASS（含 Task 1 里 `tests/ui/cli/cli-ui.test.ts` 其余用例）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/cli/cli-ui.ts tests/ui/cli/cli-ui.test.ts
git commit -m "feat: group /model selection by provider"
```

---

### Task 3: 文档对齐 + 全量回归

**Files:**
- Modify: `src/core/ai/README.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `src/core/harness/README.md`
- Modify: `src/coding-agent/README.md`

**Interfaces:**
- Consumes: Task 1 的新 `ProtocolId`/`RuntimeProviderConfig` 与 config 结构。
- Produces: 与实现一致的用户文档。

- [ ] **Step 1: 更新 `src/core/ai/README.md`**

把 `RuntimeProviderConfig` 接口示例（"Provider 与模型切换" 一节）：

```ts
interface RuntimeProviderConfig {
  readonly id: ProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}
```

改为：

```ts
type ProtocolId = "anthropic" | "openai" | "gemini";

interface RuntimeProviderConfig {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}
```

把 `ProviderId` 一节改为：

```ts
type ProviderId = "anthropic" | "openai" | "gemini";
```

改为：

```ts
type ProtocolId = "anthropic" | "openai" | "gemini";
```

把用法示例中的 `{ id: "openai", apiKey: "sk-..." }` 改为 `{ name: "openai", protocol: "openai", apiKey: "sk-..." }`，把切换示例 `{ id: "anthropic", apiKey: "sk-ant-...", baseUrl: "https://api.anthropic.com" }` 改为 `{ name: "anthropic", protocol: "anthropic", apiKey: "sk-ant-...", baseUrl: "https://api.anthropic.com" }`。在 "Provider 与模型切换" 一节补充一句：provider 名与协议分离，多个 provider 可共用同一协议。

- [ ] **Step 2: 更新 `docs/architecture.md` 的 AI 层章节**

把 §1 中的：

```ts
interface RuntimeProviderConfig {
  readonly id: ProviderId;          // "anthropic" | "openai" | "gemini"
  readonly apiKey: string;
  readonly baseUrl?: string;
}
```

改为：

```ts
type ProtocolId = "anthropic" | "openai" | "gemini";

interface RuntimeProviderConfig {
  readonly name: string;            // 配置的 provider 名，例如 "deepseek"
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}
```

并在该节补充："provider 是用户配置的连接实例（name/baseUrl/apiKey/protocol/models），协议决定 adapter；多个 provider 可共用同一协议。默认模型由 `Config.defaultModel` 显式指定。"

- [ ] **Step 3: 更新根 `README.md`**

把"配置"一节的 config.json 模板示例（第 38-52 行）改为：

```json
{
  "defaultModel": { "provider": "openai", "model": "gpt-5" },
  "providers": {
    "openai": {
      "protocol": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": ["gpt-5"]
    }
  },
  "agent": { "maxTurns": 20 },
  "tools": { "timeoutSeconds": 120 },
  "ui": { "thinking": "hidden", "toolDetails": "compact" }
}
```

更新"规则"列表：`defaultModel` 必须引用已配置 provider 且 model 在其 models 列表中；`providers` 以 provider 名为键，`protocol` 为三者之一，`models` 非空数组；内建 provider 顺序改为"配置顺序"。更新"常见问题"中关于 `defaultProvider` 的表述（改为 `defaultModel`）。在"AI 层"一节把 `createModelRuntime` 示例改为 `providers: [{ name: "openai", protocol: "openai", apiKey: "sk-..." }]`。

- [ ] **Step 4: 更新 `src/core/harness/README.md` 与 `src/coding-agent/README.md` 的示例**

把 `harness/README.md` 最小用法中的：

```ts
providers: [
  { id: "openai", apiKey: "sk-...", baseUrl: "https://api.openai.com/v1" },
],
```

改为：

```ts
providers: [
  { name: "openai", protocol: "openai", apiKey: "sk-...", baseUrl: "https://api.openai.com/v1" },
],
```

把 `coding-agent/README.md` 最小用法中的：

```ts
providers: [
  { id: "openai", model: "gpt-5", baseUrl: "https://api.openai.com/v1", apiKey: "sk-..." },
],
```

改为：

```ts
providers: [
  { name: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-..." },
],
```

- [ ] **Step 5: 全量回归**

Run: `npm run typecheck` 与 `npm test`
Expected: 全部 PASS（build、全部测试文件）。

Run: `npm run build`
Expected: 成功生成 `dist/`。

- [ ] **Step 6: 提交**

```bash
git add src/core/ai/README.md src/core/harness/README.md src/coding-agent/README.md docs/architecture.md README.md
git commit -m "docs: align docs with provider protocol separation"
```

---

## Self-Review

**Spec 覆盖：**
- §3 ai 接口（ProtocolId、RuntimeProviderConfig、工厂、env helper）→ Task 1。
- §4/§5 配置结构、解析、合并、跨字段校验（含 defaultModel 必填/引用/列 model、auth 按名）→ Task 1。
- §6 `/model` 两步选择 → Task 2。
- §7 Session 持久化不变 → 无任务（设计为不改）。
- §8 main.ts verbose → Task 1 Step 6。
- §9 模板 → Task 1 Step 1/Step 7（与 config 同任务落地，避免旧模板破坏构建）。
- §10 文档 → Task 3。
- §12 验证要求 → 各 Task 的测试步骤 + Task 3 全量回归。

**占位符扫描：** 所有步骤含实际代码与断言；无 TBD/TODO。

**类型一致性：** `ProtocolId`、`RuntimeProviderConfig { name/protocol/apiKey/baseUrl }`、`Config.defaultModel: ModelConfig`、`Config.models: readonly ModelConfig[]` 在各 Task 保持一致；`chooseAndSwitchModel` 在两个 /model 测试里使用相同的两步交互；`provider.name` 在 Task 1 Step 6 与 config `runtimeProviders()` 一致。
