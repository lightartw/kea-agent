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
  CodingToolPresentationRegistry,
  createProject,
} from "../src/coding-agent/index.js";

import { CliFrontend } from "../src/ui/index.js";

import type {
  AgentEvent,
  AgentHookCall,
  AgentToolCall,
  AgentToolResult,
} from "../src/agent/index.js";

import type {
  HarnessConfig,
  HarnessEvent,
  HarnessToolEvent,
} from "../src/harness/index.js";

import type {
  CreateSessionInput,
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
  createProject,
  CodingToolPresentationRegistry,
  CliFrontend,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentTypes = [
  AgentEvent,
  AgentHookCall,
  AgentToolCall,
  AgentToolResult,
];

type PublicHarnessTypes = [
  HarnessEvent,
  HarnessToolEvent,
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
