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
  HarnessListener,
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

import { HookRegistry } from "../src/agent/hooks/index.js";
import type {
  AfterToolCall,
  AfterToolCallPatch,
  AgentHookCall,
  AgentHookTrigger,
  BeforeStopCall,
  BeforeStopResult,
  BeforeToolCall,
  BeforeToolCallResult,
  BeforeUserPromptCall,
  BeforeUserPromptResult,
  Cleanup,
  HookHandler,
  HookListener,
  ResultOf,
  TransformContextCall,
  TransformContextResult,
  Unregister,
} from "../src/agent/hooks/index.js";

import {
  createCodingHookRegistry,
} from "../src/coding-agent/index.js";
import type {
  CodingHookContext,
  CodingHookUI,
  HookConfirmation,
  HookNotification,
} from "../src/coding-agent/index.js";

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
  HookRegistry,
  createCodingHookRegistry,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentHookTypes = [
  AgentHookCall,
  AgentHookTrigger,
  AfterToolCall,
  AfterToolCallPatch,
  BeforeStopCall,
  BeforeStopResult,
  BeforeToolCall,
  BeforeToolCallResult,
  BeforeUserPromptCall,
  BeforeUserPromptResult,
  Cleanup,
  HookHandler<BeforeUserPromptCall, Record<string, never>>,
  HookListener<AgentHookCall, Record<string, never>>,
  ResultOf<BeforeUserPromptCall>,
  TransformContextCall,
  TransformContextResult,
  Unregister,
];

type PublicCodingHookTypes = [
  CodingHookContext,
  CodingHookUI,
  CreateHarnessConfig,
  HookConfirmation,
  HookNotification,
];
void (null as PublicAgentHookTypes | null);
void (null as PublicCodingHookTypes | null);

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
