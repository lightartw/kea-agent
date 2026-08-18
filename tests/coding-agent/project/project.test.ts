import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/core/agent/tools/types.js";
import type { AssistantMessage, ModelConfig, Tool } from "../../../src/core/ai/types.js";
import { SessionRepository } from "../../../src/core/harness/session/repository.js";
import { Events } from "../../../src/core/events/events.js";
import { Project } from "../../../src/coding-agent/project/project.js";
import type { ProjectInfo } from "../../../src/coding-agent/project/project.js";
import { runtimeFromStream, type TestStream } from "../../fixtures/model-runtime.js";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";

const modelConfig: ModelConfig = { provider: "test", model: "model-a" };

const assistant: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "model-a",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "stop",
  latencyMs: 0,
};

const simpleStream: TestStream = async function* () {
  yield { type: "done", message: assistant };
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kea-project-"));
}

function validInfo(directory: string, overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: VALID_ID,
    name: "example",
    directory,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

async function makeProject(options: {
  readonly info?: ProjectInfo;
  readonly sessions?: SessionRepository;
  readonly maxTurns?: number;
  readonly toolTimeoutSeconds?: number;
  readonly stream?: TestStream;
} = {}): Promise<{
  project: Project;
  projectDir: string;
  prompts: string[];
  toolsList: Array<readonly Tool[] | undefined>;
}> {
  const projectDir = await tempDir();
  const prompts: string[] = [];
  const toolsList: Array<readonly Tool[] | undefined> = [];
  const stream: TestStream = options.stream ?? (async function* (_model, context) {
    prompts.push(context.systemPrompt ?? "");
    toolsList.push(context.tools);
    yield { type: "done", message: assistant };
  });
  const project = new Project({
    info: options.info ?? validInfo(resolve(projectDir)),
    sessions: options.sessions ?? new SessionRepository(join(projectDir, ".test-sessions")),
    runtime: runtimeFromStream(stream),
    modelConfig,
    maxTurns: options.maxTurns ?? 20,
    toolTimeoutSeconds: options.toolTimeoutSeconds ?? 120,
    events: new Events(),
  });
  return { project, projectDir, prompts, toolsList };
}

test("info returns a defensive snapshot and invalid info is rejected at construction", async () => {
  const { project, projectDir } = await makeProject();
  const invalidSessionsDir = await tempDir();
  try {
    const first = project.info;
    (first as { name: string }).name = "mutated";
    (first as { directory: string }).directory = "C:/mutated";

    const second = project.info;
    assert.equal(second.name, "example");
    assert.equal(second.directory, resolve(projectDir));
    assert.notEqual(first, second);

    assert.throws(
      () => new Project({
        info: { ...validInfo(resolve(projectDir)), id: "not-a-uuid" },
        sessions: new SessionRepository(join(invalidSessionsDir, "sessions")),
        runtime: runtimeFromStream(simpleStream),
        modelConfig,
        maxTurns: 20,
        toolTimeoutSeconds: 120,
        events: new Events(),
      }),
      /invalid/i,
    );
    assert.throws(
      () => new Project({
        info: {
          ...validInfo(resolve(projectDir)),
          id: [VALID_ID],
        } as unknown as ProjectInfo,
        sessions: new SessionRepository(join(invalidSessionsDir, "sessions")),
        runtime: runtimeFromStream(simpleStream),
        modelConfig,
        maxTurns: 20,
        toolTimeoutSeconds: 120,
        events: new Events(),
      }),
      /invalid/i,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(invalidSessionsDir, { recursive: true, force: true });
  }
});

test("listSessions delegates to the Project-owned repository", async () => {
  const { project, projectDir } = await makeProject();
  try {
    assert.deepEqual(await project.listSessions(), []);

    const harness = await project.createHarness();
    const sessions = await project.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, harness.sessionId);
    assert.equal(sessions[0]?.cwd, resolve(projectDir));
    assert.equal(sessions[0]?.title, "unknown");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("createHarness defaults cwd to the Project directory and creates a new Session every call", async () => {
  const { project, projectDir, prompts } = await makeProject();
  try {
    const first = await project.createHarness();
    const second = await project.createHarness();
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal((await project.listSessions()).length, 2);

    await first.prompt("hello");
    await second.prompt("again");
    assert.ok(prompts[0]?.includes(resolve(projectDir)));
    assert.ok(prompts[1]?.includes(resolve(projectDir)));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("relative cwd resolves from the Project directory and absolute cwd must stay inside", async () => {
  const { project, projectDir, prompts } = await makeProject();
  try {
    await mkdir(join(projectDir, "src"), { recursive: true });
    const relative = await project.createHarness({ cwd: "src" });
    const absolute = await project.createHarness({ cwd: resolve(join(projectDir, "src")) });
    assert.notEqual(relative.sessionId, absolute.sessionId);

    await relative.prompt("a");
    await absolute.prompt("b");
    assert.ok(prompts[0]?.includes(resolve(join(projectDir, "src"))));
    assert.ok(prompts[1]?.includes(resolve(join(projectDir, "src"))));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});


test("createHarnessFromSession opens exactly that Session and never creates a replacement", async () => {
  const { project, projectDir } = await makeProject();
  try {
    const first = await project.createHarness();
    await first.prompt("hello");

    const restored = await project.createHarnessFromSession(first.sessionId);
    assert.equal(restored.sessionId, first.sessionId);
    assert.equal((await project.listSessions()).length, 1);
    assert.equal(restored.messages.length, 2);
    assert.equal(restored.messages[0]?.role, "user");
    assert.equal(restored.messages[1]?.role, "assistant");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});



test("the system prompt contains the Project directory and the Session cwd", async () => {
  const { project, projectDir, prompts } = await makeProject();
  try {
    await mkdir(join(projectDir, "src"), { recursive: true });
    const harness = await project.createHarness({ cwd: "src" });
    await harness.prompt("hello");
    const prompt = prompts[0] ?? "";
    assert.ok(prompt.includes(project.info.directory));
    assert.ok(prompt.includes(resolve(join(projectDir, "src"))));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("a Harness created by Project stops at the configured turn limit", async () => {
  const tc = {
    type: "toolCall" as const,
    id: "c1",
    name: "todo_write",
    arguments: { todos: [{ content: "task", status: "pending" }] },
  };
  const toolTurn: AssistantMessage = {
    role: "assistant",
    content: [tc],
    model: "model-a",
    stopReason: "toolUse",
    latencyMs: 0,
  };
  let calls = 0;
  const { project, projectDir } = await makeProject({
    maxTurns: 1,
    stream: async function* () {
      calls += 1;
      if (calls === 1) {
        yield { type: "toolcall_start", id: "c1", name: "todo_write" };
        yield { type: "toolcall_end", toolCall: tc };
        yield { type: "done", message: toolTurn };
      } else {
        yield { type: "done", message: assistant };
      }
    },
  });
  try {
    const harness = await project.createHarness();
    await harness.prompt("run");
    assert.equal(calls, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
