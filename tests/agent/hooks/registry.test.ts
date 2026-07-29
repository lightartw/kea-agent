import assert from "node:assert/strict";
import test from "node:test";

import { HookRegistry } from "../../../src/agent/hooks/registry.js";
import type {
  AgentHookEvent,
  HookObserver,
  Unregister,
} from "../../../src/agent/hooks/types.js";

type TestContext = { label: string };

function registry(
  context: TestContext = { label: "initial" },
): HookRegistry<AgentHookEvent, TestContext> {
  return new HookRegistry<AgentHookEvent, TestContext>(context);
}

// ── Step 1: Typed event-combination tests ──

test("user_prompt ignores block false and exits on block true", async () => {
  const hooks = registry();
  const calls: string[] = [];
  hooks.register("user_prompt", () => {
    calls.push("first");
    return { block: false, reason: "not a block" };
  });
  hooks.register("user_prompt", () => {
    calls.push("second");
    return { block: true, reason: "denied" };
  });
  hooks.register("user_prompt", () => {
    calls.push("third");
  });

  assert.deepEqual(
    await hooks.trigger({ type: "user_prompt", prompt: "hello" }),
    { block: true, reason: "denied" },
  );
  assert.deepEqual(calls, ["first", "second"]);
});

test("context handlers see the previous messages result", async () => {
  const hooks = registry();
  hooks.register("context", ({ messages }) => ({
    messages: [...messages, { role: "user", content: "first" }],
  }));
  hooks.register("context", ({ messages }) => ({
    messages: [...messages, { role: "user", content: "second" }],
  }));

  const result = await hooks.trigger({
    type: "context",
    messages: [{ role: "user", content: "original" }],
  });
  assert.deepEqual(
    result?.messages?.map((message) =>
      message.role === "user" ? message.content : message.role
    ),
    ["original", "first", "second"],
  );
});

test("tool_call shares mutable input and exits only on block true", async () => {
  const hooks = registry();
  const input: Record<string, unknown> = { command: "pwd" };
  hooks.register("tool_call", (event) => {
    event.input.command = "echo changed";
    return { block: false };
  });
  hooks.register("tool_call", (event) => {
    assert.equal(event.input.command, "echo changed");
  });

  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input,
  }), undefined);
  assert.equal(input.command, "echo changed");
});

test("tool_result handlers see and return the accumulated patch", async () => {
  const hooks = registry();
  hooks.register("tool_result", () => ({ content: "changed" }));
  hooks.register("tool_result", (event) => {
    assert.equal(event.content, "changed");
    return { isError: true };
  });

  assert.deepEqual(await hooks.trigger({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "bash",
    input: {},
    content: "raw",
    isError: false,
  }), { content: "changed", isError: true });
});

test("stop uses the first continueWith result", async () => {
  const hooks = registry();
  hooks.register("stop", () => ({
    continueWith: { role: "user", content: "continue" },
  }));
  hooks.register("stop", () => ({
    continueWith: { role: "user", content: "ignored" },
  }));

  assert.deepEqual(
    await hooks.trigger({ type: "stop", messages: [] }),
    { continueWith: { role: "user", content: "continue" } },
  );
});

// ── Step 2: Observer, snapshot, signal, and error tests ──

test("observers run before handlers and cannot control the result", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const unsafeObserver = ((
    _event: AgentHookEvent,
    context: TestContext,
    signal?: AbortSignal,
  ) => {
    calls.push(`observer:${context.label}:${String(signal?.aborted)}`);
    return { block: true };
  }) as unknown as HookObserver<AgentHookEvent, TestContext>;
  hooks.registerObserver(unsafeObserver);
  hooks.register("tool_call", () => {
    calls.push("handler");
  });
  const controller = new AbortController();

  assert.equal(await hooks.trigger({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "bash",
    input: {},
  }, controller.signal), undefined);
  assert.deepEqual(calls, ["observer:initial:false", "handler"]);
});

test("trigger snapshots observers handlers and context", async () => {
  const hooks = registry();
  const calls: string[] = [];
  let removeSecond: Unregister = () => undefined;
  hooks.registerObserver((_event, context) => {
    calls.push(`observer:${context.label}`);
    hooks.setContext({ label: "next" });
    removeSecond();
    hooks.register("user_prompt", () => {
      calls.push("late");
    });
  });
  hooks.register("user_prompt", (_event, context) => {
    calls.push(`first:${context.label}`);
  });
  removeSecond = hooks.register("user_prompt", (_event, context) => {
    calls.push(`second:${context.label}`);
  });

  await hooks.trigger({ type: "user_prompt", prompt: "one" });
  await hooks.trigger({ type: "user_prompt", prompt: "two" });
  assert.deepEqual(calls, [
    "observer:initial", "first:initial", "second:initial",
    "observer:next", "first:next", "late",
  ]);
});

test("handler and observer errors propagate by identity", async () => {
  const handlerFailure = new Error("handler failed");
  const handlerHooks = registry();
  handlerHooks.register("stop", () => { throw handlerFailure; });
  await assert.rejects(
    handlerHooks.trigger({ type: "stop", messages: [] }),
    (error) => error === handlerFailure,
  );

  const observerFailure = new Error("observer failed");
  const observerHooks = registry();
  observerHooks.registerObserver(() => { throw observerFailure; });
  await assert.rejects(
    observerHooks.trigger({ type: "stop", messages: [] }),
    (error) => error === observerFailure,
  );
});

test("handler and observer receive the exact AbortSignal object", async () => {
  const hooks = registry();
  const controller = new AbortController();
  const handlerSignal: AbortSignal[] = [];
  const observerSignal: AbortSignal[] = [];

  hooks.registerObserver((_event, _context, signal) => {
    observerSignal.push(signal!);
  });
  hooks.register("user_prompt", (_event, _context, signal) => {
    handlerSignal.push(signal!);
  });

  await hooks.trigger(
    { type: "user_prompt", prompt: "test" },
    controller.signal,
  );
  assert.equal(handlerSignal[0], controller.signal);
  assert.equal(observerSignal[0], controller.signal);
});

// ── Step 3: Unregister, cleanup, clear, and dispose tests ──

test("clear removes registrations, runs every cleanup in reverse, and is reusable", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const unregister = hooks.register("user_prompt", () => {
    calls.push("handler");
  });
  unregister();
  unregister();
  hooks.addCleanup(() => { calls.push("cleanup-1"); });
  hooks.addCleanup(async () => { calls.push("cleanup-2"); });

  await hooks.clear();
  await hooks.trigger({ type: "user_prompt", prompt: "ignored" });
  assert.deepEqual(calls, ["cleanup-2", "cleanup-1"]);

  hooks.register("user_prompt", () => { calls.push("reused"); });
  await hooks.trigger({ type: "user_prompt", prompt: "again" });
  assert.deepEqual(calls, ["cleanup-2", "cleanup-1", "reused"]);
});

test("handler observer and cleanup unregister functions are idempotent", async () => {
  const hooks = registry();
  const calls: string[] = [];
  const removeHandler = hooks.register("user_prompt", () => {
    calls.push("handler");
  });
  const removeObserver = hooks.registerObserver(() => {
    calls.push("observer");
  });
  const removeCleanup = hooks.addCleanup(() => {
    calls.push("cleanup");
  });

  removeHandler();
  removeHandler();
  removeObserver();
  removeObserver();
  removeCleanup();
  removeCleanup();
  await hooks.trigger({ type: "user_prompt", prompt: "ignored" });
  await hooks.clear();
  assert.deepEqual(calls, []);
});

test("clear runs all failing cleanups and aggregates multiple failures", async () => {
  const hooks = registry();
  const first = new Error("first");
  const second = new Error("second");
  const calls: string[] = [];
  hooks.addCleanup(() => { calls.push("first"); throw first; });
  hooks.addCleanup(() => { calls.push("second"); throw second; });

  await assert.rejects(
    hooks.clear(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === second &&
      error.errors[1] === first,
  );
  assert.deepEqual(calls, ["second", "first"]);
});

test("dispose is idempotent and permanently rejects operations", async () => {
  const hooks = registry();
  await hooks.dispose();
  await hooks.dispose();

  assert.throws(() => hooks.register("stop", () => undefined), /disposed/);
  assert.throws(() => hooks.registerObserver(() => undefined), /disposed/);
  assert.throws(() => hooks.addCleanup(() => undefined), /disposed/);
  assert.throws(() => hooks.setContext({ label: "next" }), /disposed/);
  await assert.rejects(
    hooks.trigger({ type: "stop", messages: [] }),
    /disposed/,
  );
});

test("clear rethrows one cleanup error by identity", async () => {
  const hooks = registry();
  const failure = new Error("cleanup failed");
  hooks.addCleanup(() => { throw failure; });
  await assert.rejects(hooks.clear(), (error) => error === failure);
});

test("runtime rejects event types outside AgentHookEvent", async () => {
  const hooks = registry();
  await assert.rejects(
    hooks.trigger(
      { type: "custom" } as unknown as AgentHookEvent,
    ),
    /Unknown hook event 'custom'/,
  );
});
