import type { AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

/** A Tool Call in one Run: Run identity, execution cwd, and the call itself. */
export interface ToolCallEvent {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly call: AgentToolCall;
}

/** ToolCallEvent plus the execution result. */
export interface ToolResultEvent extends ToolCallEvent {
  readonly result: AgentToolResult;
}

/** A beforeTool outcome: allow, or deny (optionally with a reason). */
export type PreToolDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason?: string };

/** Run identity + cwd handed to every control hook. */
export interface HookContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export type HookName = "beforePrompt" | "transformContext" | "beforeTool";

export type HarnessRunEnd = {
  readonly type: "run-end";
  readonly runId: string;
} & (
  | { readonly reason: "completed" | "aborted" }
  | { readonly reason: "error"; readonly errorMessage: string }
);

/**
 * The observation facts a Harness emits for one Session. Listeners never see
 * Session identity (each Harness is bound to one Session) or control points;
 * they only observe what has already happened.
 */
export type HarnessEvent =
  | { readonly type: "run-start"; readonly runId: string }
  | HarnessRunEnd
  | { readonly type: "turn-start"; readonly runId: string }
  | {
      readonly type: "turn-end";
      readonly runId: string;
      readonly message: AgentMessage;
      readonly toolResults: readonly AgentMessage[];
    }
  | { readonly type: "text-start"; readonly runId: string }
  | { readonly type: "text-end"; readonly runId: string }
  | { readonly type: "thinking-start"; readonly runId: string }
  | { readonly type: "thinking-end"; readonly runId: string }
  | { readonly type: "text-delta"; readonly runId: string; readonly text: string }
  | {
      readonly type: "thinking-delta";
      readonly runId: string;
      readonly thinking: string;
    }
  | {
      readonly type: "tool-call-start";
      readonly runId: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-call-delta";
      readonly runId: string;
      readonly id: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "tool-call";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
    }
  | {
      readonly type: "tool-result";
      readonly runId: string;
      readonly cwd: string;
      readonly call: AgentToolCall;
      readonly result: AgentToolResult;
    };

export type HarnessEventType = HarnessEvent["type"];
export type HarnessEventOfType<TType extends HarnessEventType> =
  Extract<HarnessEvent, { readonly type: TType }>;
export type HarnessEventListener<TEvent extends HarnessEvent = HarnessEvent> =
  (event: TEvent) => void | Promise<void>;

type AnyListener = (event: HarnessEvent) => void | Promise<void>;

/**
 * Observation-only event bus owned by one AgentHarness. Listeners return
 * `void`; emit isolates listener errors through the injected reporter so a
 * throwing listener never changes harness execution.
 */
export class HarnessEventBus {
  readonly #listeners = new Map<HarnessEventType, Set<AnyListener>>();
  readonly #onListenerError:
    | ((error: unknown, type: HarnessEventType, event: HarnessEvent) => void)
    | undefined;

  constructor(
    onListenerError?: (
      error: unknown,
      type: HarnessEventType,
      event: HarnessEvent,
    ) => void,
  ) {
    this.#onListenerError = onListenerError;
  }

  on<TType extends HarnessEventType>(
    type: TType,
    listener: HarnessEventListener<HarnessEventOfType<TType>>,
  ): () => void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      set.delete(wrapped);
      if (set.size === 0) this.#listeners.delete(type);
    };
  }

  async emit(event: HarnessEvent): Promise<void> {
    const snapshot = [...(this.#listeners.get(event.type) ?? [])];
    for (const listener of snapshot) {
      try {
        await listener(event);
      } catch (error) {
        this.#reportListenerError(error, event);
      }
    }
  }

  #reportListenerError(error: unknown, event: HarnessEvent): void {
    try {
      this.#onListenerError?.(error, event.type, event);
    } catch {
      // The error reporter cannot change emit delivery.
    }
  }
}

type AnyHook = (input: unknown, ctx: HookContext) => unknown | Promise<unknown>;

type HandlerOf<TName extends HookName> =
  TName extends "beforePrompt"
    ? (
        input: { readonly prompt: string },
        ctx: HookContext,
      ) => { readonly prompt: string } | undefined | Promise<{ readonly prompt: string } | undefined>
    : TName extends "transformContext"
      ? (
          input: { readonly messages: readonly AgentMessage[] },
          ctx: HookContext,
        ) => { readonly messages: readonly AgentMessage[] }
          | Promise<{ readonly messages: readonly AgentMessage[] }>
      : TName extends "beforeTool"
        ? (
            input: { readonly call: AgentToolCall },
            ctx: HookContext,
          ) => PreToolDecision | void | Promise<PreToolDecision | void>
        : never;

/**
 * Fixed control points owned by one AgentHarness. Registration happens on this
 * surface (`hooks.on(...)`); the coding-agent registers built-in hooks (e.g.
 * Permission's beforeTool) against it when it constructs each harness. A
 * future plugin loader would register against the same surface.
 */
export class HarnessHooks {
  readonly #handlers = new Map<HookName, Set<AnyHook>>();

  on<TName extends HookName>(name: TName, handler: HandlerOf<TName>): () => void {
    let set = this.#handlers.get(name);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(name, set);
    }
    const wrapped = handler as AnyHook;
    set.add(wrapped);
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      set.delete(wrapped);
      if (set.size === 0) this.#handlers.delete(name);
    };
  }

  /** Rewrite the user prompt; any handler returning undefined stops the Run. */
  async beforePrompt(prompt: string, ctx: HookContext): Promise<string | undefined> {
    let value = prompt;
    for (const handler of this.#handlers.get("beforePrompt") ?? []) {
      const result = await handler({ prompt: value }, ctx);
      if (result === undefined) return undefined;
      value = (result as { readonly prompt: string }).prompt;
    }
    return value;
  }

  /** Chain context transformers; each sees the previous result. */
  async transformContext(
    messages: readonly AgentMessage[],
    ctx: HookContext,
  ): Promise<readonly AgentMessage[]> {
    let value = messages;
    for (const handler of this.#handlers.get("transformContext") ?? []) {
      const result = await handler({ messages: value }, ctx);
      value = (result as { readonly messages: readonly AgentMessage[] }).messages;
    }
    return value;
  }

  /** Ask every beforeTool handler; the first deny short-circuits, else allow. */
  async beforeTool(call: AgentToolCall, ctx: HookContext): Promise<PreToolDecision> {
    for (const handler of this.#handlers.get("beforeTool") ?? []) {
      const result = await handler({ call }, ctx);
      if (result !== undefined && (result as PreToolDecision).kind === "deny") {
        return result as PreToolDecision;
      }
    }
    return { kind: "allow" };
  }
}
