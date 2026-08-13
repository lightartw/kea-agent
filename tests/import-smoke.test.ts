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
} from "../src/harness/index.js";

import {
  CODING_SYSTEM_PROMPT,
  createHarness,
  createToolRegistry,
} from "../src/coding-agent/index.js";

import { HookRegistry } from "../src/agent/hooks/index.js";
import {
  AgentTool,
  AgentToolRegistry,
} from "../src/agent/tools/index.js";
import {
  createCodingHookRegistry,
} from "../src/coding-agent/index.js";

import type {
  HarnessConfig,
  HarnessListener,
  HarnessProject,
  SystemPromptBuilder,
  SystemPromptContext,
  Unsubscribe,
} from "../src/harness/index.js";
import type {
  SessionContext,
  SessionErrorCode,
} from "../src/harness/index.js";

import type {
  CodingHookContext,
  CodingAgentInteractions,
  CreateHarnessConfig,
  ConfirmationRequest,
  Notification,
  TodoDetails,
  TodoItem,
} from "../src/coding-agent/index.js";

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
  ResultOf,
  TransformContextCall,
  TransformContextResult,
  Unregister,
} from "../src/agent/hooks/index.js";

import type {
  AgentToolCall,
  AgentToolResult,
} from "../src/agent/tools/index.js";
import type {
  ToolRejectedEvent,
  ToolRejectedReason,
} from "../src/agent/types.js";

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
  AgentTool,
  AgentToolRegistry,
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
  ResultOf<BeforeUserPromptCall>,
  TransformContextCall,
  TransformContextResult,
  Unregister,
];

type PublicCodingAgentTypes = [
  CodingHookContext,
  CodingAgentInteractions,
  ConfirmationRequest,
  Notification,
  TodoItem,
  TodoDetails,
  CreateHarnessConfig,
];

type PublicAgentToolTypes = [
  AgentToolCall,
  AgentToolResult,
  ToolRejectedEvent,
  ToolRejectedReason,
];

void (null as PublicAgentHookTypes | null);
void (null as PublicCodingAgentTypes | null);
void (null as PublicAgentToolTypes | null);

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
