import type { AgentEvent } from "../../agent/types.js";

export const MAIN_LANE = "main";

export interface HarnessEventContext {
  readonly lane: string;
  readonly runId: string;
}

export type LiftAgentEvent<E extends AgentEvent = AgentEvent> =
  E extends AgentEvent ? E & HarnessEventContext : never;

export type HarnessRunEndEvent =
  | (HarnessEventContext & { readonly type: "run_end"; readonly reason: "completed" | "aborted" })
  | (HarnessEventContext & { readonly type: "run_end"; readonly reason: "error"; readonly errorMessage: string });

export type HarnessOwnedEvent =
  | (HarnessEventContext & { readonly type: "run_start" })
  | HarnessRunEndEvent;

export type HarnessEvent = LiftAgentEvent | HarnessOwnedEvent;

export type HarnessToolEvent = Extract<
  HarnessEvent,
  { readonly type: "tool_start" | "tool_end" | "tool_rejected" }
>;

export type HarnessListener = (
  event: HarnessEvent,
) => void | Promise<void>;

export type HarnessListenerErrorHandler = (
  error: unknown,
  event: HarnessEvent,
) => void;

export type Unsubscribe = () => void;

export function liftAgentEvent<E extends AgentEvent>(
  event: E,
  context: HarnessEventContext,
): LiftAgentEvent<E> {
  return { ...event, ...context } as LiftAgentEvent<E>;
}
