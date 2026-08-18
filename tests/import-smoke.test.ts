import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

import { ReadlineUi } from "../src/ui/index.js";

import type {
  AgentRunIdentity,
  AgentToolCall,
  AgentToolResult,
} from "../src/core/agent/index.js";

import type {
  HarnessConfig,
  HarnessEvent,
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

import type {
  ModelRuntime,
  ProviderId,
  RuntimeProviderConfig,
  StreamChunk,
} from "../src/core/ai/index.js";

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
  ReadlineUi,
];

// Type-only assertions — keep imports from being tree-shaken
type PublicAgentTypes = [
  AgentRunIdentity,
  AgentToolCall,
  AgentToolResult,
];

type PublicHarnessTypes = [
  HarnessConfig,
  HarnessEvent,
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
type PublicAiTypes = [ModelRuntime, ProviderId, RuntimeProviderConfig, StreamChunk];

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

test("production main does not load dotenv or read credential environment variables", () => {
  const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("dotenv"), "main.ts must not load dotenv");
  assert.ok(!source.includes("process.env"), "main.ts must not read process.env");
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
    assert.ok(!source.includes(name), `main.ts must not read ${name}`);
  }
});
