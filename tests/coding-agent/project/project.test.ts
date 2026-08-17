import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Type } from "typebox";

import { AgentTool, type AgentToolResult } from "../../../src/core/agent/tools/types.js";
import type { AssistantMessage, ModelConfig, Tool } from "../../../src/core/ai/types.js";
import { SessionRepository } from "../../../src/core/harness/session/repository.js";
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

class TestTool extends AgentTool {
  constructor(name: string) {
    super(name, "test tool", Type.Object({}));
  }

  async execute(): Promise<AgentToolResult> {
    return { content: "ok", isError: false };
  }
}

async function makeProject(options: {
  readonly info?: ProjectInfo;
  readonly sessions?: SessionRepository;
} = {}): Promise<{
  project: Project;
  projectDir: string;
  prompts: string[];
  toolsList: Array<readonly Tool[] | undefined>;
}> {
  const projectDir = await tempDir();
  const prompts: string[] = [];
  const toolsList: Array<readonly Tool[] | undefined> = [];
  const stream: TestStream = async function* (_model, context) {
    prompts.push(context.systemPrompt ?? "");
    toolsList.push(context.tools);
    yield { type: "done", message: assistant };
  };
  const project = new Project({
    info: options.info ?? validInfo(resolve(projectDir)),
    sessions: options.sessions ?? new SessionRepository(join(await tempDir(), "sessions")),
    runtime: runtimeFromStream(stream),
    modelConfig,
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

test("missing paths, files, and paths outside the Project directory reject", async () => {
  const { project, projectDir } = await makeProject();
  const outside = await tempDir();
  try {
    await assert.rejects(
      project.createHarness({ cwd: join(projectDir, "missing") }),
      /does not exist/i,
    );
    const file = join(projectDir, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(project.createHarness({ cwd: file }), /is not a directory/i);
    await assert.rejects(project.createHarness({ cwd: outside }), /outside/i);
    assert.equal((await project.listSessions()).length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

test("restoration rejects when the recorded cwd is missing or outside the Project directory", async () => {
  const missing = await makeProject();
  const outsideDir = await tempDir();
  const projectDir = await tempDir();
  try {
    await mkdir(join(missing.projectDir, "work"), { recursive: true });
    const harness = await missing.project.createHarness({ cwd: "work" });
    await rm(join(missing.projectDir, "work"), { recursive: true });
    await assert.rejects(
      missing.project.createHarnessFromSession(harness.sessionId),
      /does not exist/i,
    );

    const sessions = new SessionRepository(join(await tempDir(), "sessions"));
    const session = await sessions.create({ cwd: outsideDir });
    const project = new Project({
      info: validInfo(resolve(projectDir)),
      sessions,
      runtime: runtimeFromStream(simpleStream),
      modelConfig,
    });
    await assert.rejects(project.createHarnessFromSession(session.id), /outside/i);
  } finally {
    await rm(missing.projectDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("each Harness gets a distinct empty tool registry while sharing the Project Events", async () => {
  const { project, projectDir, toolsList } = await makeProject();
  try {
    const first = await project.createHarness();
    const second = await project.createHarness();

    await first.prompt("a");
    await second.prompt("b");
    assert.deepEqual(toolsList[0], []);
    assert.deepEqual(toolsList[1], []);

    const tool = new TestTool("shared-name");
    first.registerTool(tool);
    second.registerTool(tool);

    const runSessions: string[] = [];
    project.events.on("harness/run-start", (run) => {
      runSessions.push(run.sessionId);
    });
    await first.prompt("c");
    await second.prompt("d");
    assert.deepEqual(runSessions, [first.sessionId, second.sessionId]);
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
