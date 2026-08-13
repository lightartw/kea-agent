import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AgentTool,
  AgentToolRegistry,
  runAgentLoop,
} from "../src/agent/index.js";

import { Events } from "../src/events/index.js";

import {
  AgentHarness,
  Session,
  SessionRepository,
} from "../src/harness/index.js";

import {
  CodingToolPresentationRegistry,
  createProject,
} from "../src/coding-agent/index.js";

import { CliFrontend } from "../src/ui/index.js";

import type {
  AgentRunIdentity,
  AgentToolCall,
  AgentToolResult,
  ToolCallDecision,
} from "../src/agent/index.js";

import type {
  CreateSessionInput,
  HarnessConfig,
  HarnessRunEndInput,
  SessionHeader,
  SessionInfo,
} from "../src/harness/index.js";

import type {
  CodingAgentInteractions,
  CodingToolDefinition,
  CodingToolPresentation,
  CreateProjectConfig,
  Project,
  ProjectInfo,
  ToolPresentationInput,
} from "../src/coding-agent/index.js";

import type { StreamChunk } from "../src/ai/index.js";

import type { EventContract, EventMap } from "../src/events/index.js";

void [
  Events,
  runAgentLoop,
  AgentTool,
  AgentToolRegistry,
  AgentHarness,
  Session,
  SessionRepository,
  createProject,
  CodingToolPresentationRegistry,
  CliFrontend,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentTypes = [
  AgentRunIdentity,
  ToolCallDecision,
  AgentToolCall,
  AgentToolResult,
];

type PublicHarnessTypes = [
  HarnessRunEndInput,
  HarnessConfig,
  CreateSessionInput,
  SessionHeader,
  SessionInfo,
];

type PublicCodingAgentTypes = [
  Project,
  ProjectInfo,
  CreateProjectConfig,
  CodingAgentInteractions,
  CodingToolDefinition,
  CodingToolPresentation<unknown, unknown>,
  ToolPresentationInput,
];

type PublicEventTypes = [EventContract<"emit", unknown>, EventMap];
type PublicAiTypes = [StreamChunk];

void (null as PublicAgentTypes | null);
void (null as PublicHarnessTypes | null);
void (null as PublicCodingAgentTypes | null);
void (null as PublicEventTypes | null);
void (null as PublicAiTypes | null);

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
