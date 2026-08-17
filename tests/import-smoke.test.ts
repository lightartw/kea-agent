import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AgentTool,
  AgentToolRegistry,
  runAgentLoop,
} from "../src/core/agent/index.js";

import { Events } from "../src/core/events/index.js";

import {
  AgentHarness,
  Session,
  SessionRepository,
} from "../src/core/harness/index.js";

import {
  openOrCreateProject,
  ProjectError,
} from "../src/coding-agent/index.js";

import { CliFrontend } from "../src/ui/index.js";

import type {
  AgentRunIdentity,
  AgentToolCall,
  AgentToolResult,
} from "../src/core/agent/index.js";

import type {
  HarnessConfig,
  SessionMetadata,
  SessionNode,
} from "../src/core/harness/index.js";

import type {
  Interactions,
  PermissionReply,
  PermissionRequest,
  Project,
  ProjectInfo,
} from "../src/coding-agent/index.js";

import type { ModelRuntime, StreamChunk } from "../src/core/ai/index.js";

import type { EventMap } from "../src/core/events/index.js";

void [
  Events,
  runAgentLoop,
  AgentTool,
  AgentToolRegistry,
  AgentHarness,
  Session,
  SessionRepository,
  openOrCreateProject,
  ProjectError,
  CliFrontend,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentTypes = [
  AgentRunIdentity,
  AgentToolCall,
  AgentToolResult,
];

type PublicHarnessTypes = [
  HarnessConfig,
  SessionMetadata,
  SessionNode,
];

type PublicCodingAgentTypes = [
  Project,
  ProjectInfo,
  Interactions,
  PermissionRequest,
  PermissionReply,
];

type PublicEventTypes = [EventMap];
type PublicAiTypes = [ModelRuntime, StreamChunk];

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
