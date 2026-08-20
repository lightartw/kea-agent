import type { AgentMessage } from "./types.js";
import type { AgentToolCall, AgentToolResult } from "./tools/types.js";

/** A Tool Call in one Run: Run identity, execution cwd, and the call itself. */
export interface ToolCallEvent {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly call: AgentToolCall;
}

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
