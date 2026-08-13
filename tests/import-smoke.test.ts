import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AgentTool,
  AgentToolRegistry,
  HookRegistry,
  runAgentLoop,
} from "../src/agent/index.js";

import {
  AgentHarness,
  MAIN_LANE,
  Session,
  SessionRepository,
} from "../src/harness/index.js";

import {
  CODING_SYSTEM_PROMPT,
  NO_INTERACTIONS,
  createCodingAgent,
} from "../src/coding-agent/index.js";

import { CliFrontend } from "../src/ui/index.js";

import type {
  AgentEvent,
  AgentHookCall,
  AfterToolCallResult,
  AgentToolCall,
  AgentToolResult,
} from "../src/agent/index.js";

import type {
  HarnessConfig,
  HarnessEvent,
  HarnessToolEvent,
} from "../src/harness/index.js";

import type {
  CodingAgent,
  CodingAgentInteractions,
  CodingProject,
  CodingToolContext,
  CodingToolDefinition,
  CodingToolPresentation,
  ConfirmationRequest,
  CreateCodingAgentConfig,
  Notification,
  TodoDetails,
  TodoItem,
  ToolPresentationCall,
  ToolPresentationRejected,
} from "../src/coding-agent/index.js";

void [
  runAgentLoop,
  AgentTool,
  AgentToolRegistry,
  HookRegistry,
  AgentHarness,
  Session,
  SessionRepository,
  MAIN_LANE,
  createCodingAgent,
  CODING_SYSTEM_PROMPT,
  NO_INTERACTIONS,
  CliFrontend,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentTypes = [
  AgentEvent,
  AgentHookCall,
  AfterToolCallResult,
  AgentToolCall,
  AgentToolResult,
];

type PublicHarnessTypes = [
  HarnessEvent,
  HarnessToolEvent,
  HarnessConfig,
];

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

void (null as PublicAgentTypes | null);
void (null as PublicHarnessTypes | null);
void (null as PublicCodingAgentTypes | null);

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
