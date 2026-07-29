import type { ToolCallEvent, ToolCallResult } from "../../agent/hooks/types.js";
import { classifyBashCommand } from "../tools/bash-policy.js";
import type { CodingHookContext, CodingHookUI } from "../types.js";
import type { CodingHookRegistry } from "./types.js";

/**
 * Register a tool_call handler that gates Bash commands through the shared
 * allow/ask/deny policy. Non-bash tools pass through unchanged.
 */
export function registerPermissionHook(
  registry: CodingHookRegistry,
): void {
  registry.register("tool_call", async (
    event: ToolCallEvent,
    context: CodingHookContext,
    signal?: AbortSignal,
  ): Promise<ToolCallResult | undefined> => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command;
    if (typeof command !== "string") return undefined;

    const decision = classifyBashCommand(command);

    if (decision.decision === "allow") return undefined;

    if (decision.decision === "deny") {
      return { block: true, reason: decision.reason };
    }

    // decision === "ask"
    const ui: CodingHookUI = context.ui;
    if (!ui.available) {
      return { block: true, reason: `${decision.reason}; no confirmation UI available` };
    }
    try {
      const allowed = await ui.confirm({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        reason: decision.reason,
      }, signal);
      return allowed
        ? undefined
        : { block: true, reason: "permission denied by user" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `permission confirmation failed: ${message}` };
    }
  });
}
