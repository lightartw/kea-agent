import { blockedBashFragment } from "../../tools/builtin/bash.js";
import {
  Hook,
  type HookContext,
  type HookResult,
  type PreToolUseEvent,
} from "../types.js";

function block(reason: string): HookResult {
  return { block: true, reason: `Permission denied: ${reason}` };
}

/** Applies Kea's default approval policy immediately before tool execution. */
export class PermissionHook extends Hook<PreToolUseEvent> {
  constructor() {
    super("permission", "pre_tool_use");
  }

  async execute(
    event: PreToolUseEvent,
    context: HookContext,
  ): Promise<HookResult> {
    const { call } = event;
    if (call.name === "bash") {
      const command = call.arguments.command;
      if (typeof command !== "string") return block("invalid Bash command");

      // Hard-denied commands never reach the approval prompt. BashTool repeats
      // this check immediately before spawn as a final safety backstop.
      const forbidden = blockedBashFragment(command);
      if (forbidden !== undefined) {
        return block(`command contains forbidden fragment '${forbidden}'`);
      }
      // Bash can escape the workspace and affect the wider system, so the
      // conservative default is to ask even when no forbidden fragment exists.
      const allowed = await context.requestPermission({
        call,
        reason: "Shell commands can modify the system or access data outside the workspace.",
      });
      return allowed ? undefined : block("Bash command rejected by user");
    }

    // File tools cannot escape the workspace, but mutations still require an
    // explicit human decision. Read-only tools fall through without prompting.
    if (call.name === "write_file" || call.name === "edit_file") {
      const path = call.arguments.path;
      const allowed = await context.requestPermission({
        call,
        reason: `This tool will modify ${typeof path === "string" ? path : "a workspace file"}.`,
      });
      return allowed ? undefined : block("file change rejected by user");
    }

    return undefined;
  }
}
