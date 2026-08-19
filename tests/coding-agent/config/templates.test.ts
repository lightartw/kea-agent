import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeUserConfiguration } from "../../../src/coding-agent/config/templates.js";

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

const AUTH_TEMPLATE = `{
  "providers": {
    "openai": {
      "apiKey": ""
    }
  }
}
`;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-init-"));
}

test("init creates both templates once and skips on the second run", async () => {
  const parent = await tempDir();
  const keaHome = join(parent, "nested", ".kea");
  try {
    const first = await initializeUserConfiguration(keaHome);
    assert.deepEqual(first, { config: "created", auth: "created" });

    const second = await initializeUserConfiguration(keaHome);
    assert.deepEqual(second, { config: "skipped", auth: "skipped" });

    assert.equal(
      await readFile(join(keaHome, "config.json"), "utf8"),
      USER_CONFIG_TEMPLATE,
    );
    assert.equal(
      await readFile(join(keaHome, "auth.json"), "utf8"),
      AUTH_TEMPLATE,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a modified config template is never overwritten", async () => {
  const keaHome = await tempDir();
  try {
    await initializeUserConfiguration(keaHome);
    const configPath = join(keaHome, "config.json");
    const custom = '{\n  "custom": true\n}\n';
    await writeFile(configPath, custom, "utf8");

    const result = await initializeUserConfiguration(keaHome);
    assert.deepEqual(result, { config: "skipped", auth: "skipped" });
    assert.equal(await readFile(configPath, "utf8"), custom);
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

test("init only fills missing files", async () => {
  const keaHome = await tempDir();
  try {
    await initializeUserConfiguration(keaHome);
    await rm(join(keaHome, "auth.json"));

    const result = await initializeUserConfiguration(keaHome);
    assert.deepEqual(result, { config: "skipped", auth: "created" });
  } finally {
    await rm(keaHome, { recursive: true, force: true });
  }
});

// Windows does not enforce POSIX permission bits, so the 0600 check only runs
// on platforms where chmod is meaningful.
test(
  "auth is created with owner-only permissions where supported",
  { skip: process.platform === "win32" },
  async () => {
    const keaHome = await tempDir();
    try {
      await initializeUserConfiguration(keaHome);
      const mode = (await stat(join(keaHome, "auth.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      await rm(keaHome, { recursive: true, force: true });
    }
  },
);
