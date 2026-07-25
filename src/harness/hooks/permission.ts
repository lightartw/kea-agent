import { blockedBashFragment } from "../tools/bash.js";
import type { HookResult, PreToolUseEvent } from "./types.js";

/**
 * Pure policy hook. Blocks hard-denied bash fragments; allows everything else.
 * Does NOT interact with the user — the CLI renders permission-denied errors
 * and the model can retry or adapt.
 */

const FORBIDDEN_BASH_FRAGMENTS = [
  "rm ",
  "> /etc/",
  "chmod 777",
  "> /dev/",
  "sudo ",
  "shutdown",
  "reboot",
  "mkfs",
  "dd ",
] as const;

function block(reason: string): HookResult {
  return { block: true, reason: `Permission denied: ${reason}` };
}

function checkBash(command: unknown): HookResult | undefined {
  if (typeof command !== "string") return block("invalid Bash command");

  const forbidden = blockedBashFragment(command);
  if (forbidden !== undefined) {
    return block(`command contains forbidden fragment '${forbidden}'`);
  }

  for (const fragment of FORBIDDEN_BASH_FRAGMENTS) {
    if (command.includes(fragment)) {
      return block(
        fragment === "rm "
          ? "file deletion is not allowed"
          : `command contains forbidden fragment '${fragment}'`,
      );
    }
  }

  return undefined;
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
