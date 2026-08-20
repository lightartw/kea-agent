import type { AgentMessage } from "./types.js";
import type { AgentToolCall } from "./tools/types.js";

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
