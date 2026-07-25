import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AgentHarness,
  Session,
  SessionError,
  SessionManager,
  defaultSystemPrompt,
  formatSystemPrompt,
} from "../src/agent/harness/index.js";

import {
  CODING_SYSTEM_PROMPT,
  createHarness,
  createToolRegistry,
} from "../src/coding-agent/index.js";

import type {
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "../src/agent/harness/index.js";
import type {
  SessionContext,
  SessionErrorCode,
} from "../src/agent/harness/index.js";

import type { CreateHarnessConfig } from "../src/coding-agent/index.js";

void [
  AgentHarness,
  Session,
  SessionError,
  SessionManager,
  defaultSystemPrompt,
  formatSystemPrompt,
  CODING_SYSTEM_PROMPT,
  createHarness,
  createToolRegistry,
];

test("public core imports without credentials or side effects", () => {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.OPENAI_API_KEY;
  delete environment.GEMINI_API_KEY;

  const child = spawnSync(
    process.execPath,
    ["-e", "import('./dist/src/index.js')"],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

test("CLI module import does not start the prompt", () => {
  const child = spawnSync(
    process.execPath,
    ["-e", "import('./dist/src/main.js')"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
