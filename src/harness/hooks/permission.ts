import { blockedBashReason } from "../tools/bash.js";
import type { HookResult, PreToolUseEvent } from "./types.js";

/**
 * Pure policy hook. Blocks hard-denied bash fragments; allows everything else.
 * Does NOT interact with the user — the CLI renders permission-denied errors
 * and the model can retry or adapt.
 */

function block(reason: string): HookResult {
  return { block: true, reason: `Permission denied: ${reason}` };
}

function checkBash(command: unknown): HookResult | undefined {
  if (typeof command !== "string") return block("invalid Bash command");
  const reason = blockedBashReason(command);
  return reason === undefined ? undefined : block(reason);
}

/** Applies Kea's default approval policy immediately before tool execution. */
export class PermissionHook {
  readonly name = "permission";
  readonly eventType = "pre_tool_use" as const;

  execute(event: PreToolUseEvent): HookResult | undefined {
    const { call } = event;

    if (call.name === "bash") {
      return checkBash(call.arguments.command);
    }

    // write_file / edit_file / glob / read_file / todo_write — allowed
    return undefined;
  }
}
