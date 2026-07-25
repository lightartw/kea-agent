import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
} from "../src/coding-agent/index.js";

import type {
  BashOperations,
  CreateHarnessConfig,
  HarnessConfig,
  HarnessEventListener,
  HarnessProject,
  SessionContext,
  SessionErrorCode,
  SystemPromptBuilder,
  SystemPromptContext,
  TodoItem,
  Unsubscribe,
} from "../src/coding-agent/index.js";

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
