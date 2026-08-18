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

/** Test-only fixture: writes the four file layers a Config.load may consume. */
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
      { id: "openai", apiKey: "secret-key" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("defaults apply when only a Provider is configured", async () => {
  const fixture = await configFixture({
    user: { providers: { openai: { model: "gpt-test" } } },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(fixture);

    assert.equal(config.defaultProvider, "openai");
    assert.equal(config.maxTurns, 20);
    assert.equal(config.toolTimeoutSeconds, 120);
    assert.equal(config.thinking, "hidden");
    assert.equal(config.toolDetails, "compact");
    assert.equal(config.verbose, false);
  } finally {
    await cleanUp(fixture);
  }
});

test("missing user and Project config files are skipped", async () => {
  const fixture = await configFixture({
    override: { providers: { openai: { model: "m" } } },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(fixture, {
      configOverride: fixture.overridePath,
    });

    assert.deepEqual(config.models, [{ provider: "openai", model: "m" }]);
    assert.equal(config.defaultProvider, "openai");
  } finally {
    await cleanUp(fixture);
  }
});

test("a missing explicit --config file fails", async () => {
  const fixture = await configFixture({
    user: { providers: { openai: { model: "m" } } },
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
    [
      { providers: { openai: { baseUrl: "relative" } } },
      "providers.openai.baseUrl",
    ],
    [
      { providers: { openai: { baseUrl: "ftp://files" } } },
      "providers.openai.baseUrl",
    ],
    [{ providers: { watson: { model: "m" } } }, "providers.watson"],
    [{ defaultProvider: "watson" }, "defaultProvider"],
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
      user: { providers: { openai: { model: "m", [name]: "hunter2" } } },
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
      user: { providers: { openai: { model: "m" } } },
      ...(layer === "project"
        ? { project: { providers: { openai: { model: "m", apiKey: "hunter2" } } } }
        : {}),
      ...(layer === "override"
        ? { override: { providers: { openai: { model: "m", apiKey: "hunter2" } } } }
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
      providers: { openai: { model: "m" } },
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
    user: { providers: { openai: { model: "m" } } },
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
    user: { providers: { openai: { model: "m" } } },
    auth: { providers: { openai: { apiKey: "" } } },
  });
  try {
    await assert.rejects(
      loadWith(emptyKey),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(
          error.sourcePath,
          join(emptyKey.keaHome, "auth.json"),
        );
        assert.equal(error.fieldPath, "providers.openai.apiKey");
        assert.match(error.message, /must be non-empty/i);
        return true;
      },
    );
  } finally {
    await cleanUp(emptyKey);
  }

  const missingEntry = await configFixture({
    user: { providers: { openai: { model: "m" } } },
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

test("extra credentials for a known disabled Provider are ignored", async () => {
  const fixture = await configFixture({
    user: { providers: { openai: { model: "m" } } },
    auth: {
      providers: {
        openai: { apiKey: "secret-key" },
        anthropic: { apiKey: "spare-key" },
      },
    },
  });
  try {
    const config = await loadWith(fixture);
    assert.deepEqual(config.runtimeProviders(), [
      { id: "openai", apiKey: "secret-key" },
    ]);
    assert.deepEqual(config.models, [{ provider: "openai", model: "m" }]);
  } finally {
    await cleanUp(fixture);
  }
});

test("an unknown Provider in auth fails", async () => {
  const fixture = await configFixture({
    user: { providers: { openai: { model: "m" } } },
    auth: { providers: { watson: { apiKey: "k" } } },
  });
  try {
    await assert.rejects(
      loadWith(fixture),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.sourcePath, join(fixture.keaHome, "auth.json"));
        assert.equal(error.fieldPath, "providers.watson");
        assert.match(error.message, /unknown provider/i);
        return true;
      },
    );
  } finally {
    await cleanUp(fixture);
  }
});

test("no Provider and empty model fail cross-field", async () => {
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

  for (const document of [
    { providers: { openai: {} } },
    { providers: { openai: { model: "" } } },
  ]) {
    const fixture = await configFixture({ user: document, auth: fullAuth });
    try {
      await assert.rejects(
        loadWith(fixture),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(error.fieldPath, "providers.openai.model");
          assert.match(error.message, /non-empty/i);
          return true;
        },
      );
    } finally {
      await cleanUp(fixture);
    }
  }
});

test("defaultProvider is inferred, required with several Providers, and must be configured", async () => {
  const single = await configFixture({
    user: { providers: { openai: { model: "m" } } },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(single);
    assert.equal(config.defaultProvider, "openai");
    assert.deepEqual(config.defaultModel, { provider: "openai", model: "m" });
  } finally {
    await cleanUp(single);
  }

  const several = await configFixture({
    user: {
      providers: { openai: { model: "m" }, anthropic: { model: "n" } },
    },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(several),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "defaultProvider");
        assert.match(error.message, /specified when multiple providers/i);
        return true;
      },
    );
  } finally {
    await cleanUp(several);
  }

  const dangling = await configFixture({
    user: {
      defaultProvider: "openai",
      providers: { anthropic: { model: "n" } },
    },
    auth: fullAuth,
  });
  try {
    await assert.rejects(
      loadWith(dangling),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.fieldPath, "defaultProvider");
        assert.match(error.message, /configured provider/i);
        return true;
      },
    );
  } finally {
    await cleanUp(dangling);
  }
});

test("models follow the built-in Provider order", async () => {
  const fixture = await configFixture({
    user: {
      defaultProvider: "anthropic",
      providers: {
        gemini: { model: "gemini-x" },
        openai: { model: "gpt-x" },
        anthropic: { model: "claude-x" },
      },
    },
    auth: fullAuth,
  });
  try {
    const config = await loadWith(fixture);

    assert.deepEqual(config.models, [
      { provider: "anthropic", model: "claude-x" },
      { provider: "openai", model: "gpt-x" },
      { provider: "gemini", model: "gemini-x" },
    ]);
    assert.deepEqual(config.defaultModel, {
      provider: "anthropic",
      model: "claude-x",
    });
    assert.deepEqual(config.runtimeProviders(), [
      { id: "anthropic", apiKey: "ak-anthropic" },
      { id: "openai", apiKey: "ak-openai" },
      { id: "gemini", apiKey: "ak-gemini" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("runtimeProviders carries base URLs and per-Provider deep merge", async () => {
  const fixture = await configFixture({
    user: {
      providers: {
        openai: { model: "user-model", baseUrl: "https://custom.example/v1" },
      },
    },
    project: { providers: { openai: { model: "project-model" } } },
    auth: { providers: { openai: { apiKey: "secret-key" } } },
  });
  try {
    const config = await loadWith(fixture);

    assert.deepEqual(config.models, [
      { provider: "openai", model: "project-model" },
    ]);
    assert.deepEqual(config.runtimeProviders(), [
      { id: "openai", apiKey: "secret-key", baseUrl: "https://custom.example/v1" },
    ]);
  } finally {
    await cleanUp(fixture);
  }
});

test("redact replaces every loaded non-empty key without lengths or prefixes", async () => {
  const fixture = await configFixture({
    user: {
      defaultProvider: "openai",
      providers: {
        openai: { model: "m" },
        anthropic: { model: "n" },
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
    // Key prefixes and unrelated text survive; the key itself never does.
    assert.equal(config.redact("secret is sensitive"), "secret is sensitive");
    assert.ok(!config.redact("use secret-key now").includes("secret-key"));
  } finally {
    await cleanUp(fixture);
  }
});
