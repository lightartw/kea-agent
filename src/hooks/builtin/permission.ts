import { blockedBashFragment } from "../../tools/builtin/bash.js";
import type { ToolCall } from "../../tools/types.js";
import type { HookResult, PreToolUseHook } from "../types.js";

/** Information a presentation adapter needs to ask for one approval. */
export interface PermissionRequest {
  readonly call: ToolCall;
  readonly reason: string;
}

export type PermissionRequester = (
  request: PermissionRequest,
) => Promise<boolean>;

function block(reason: string): HookResult {
  return { block: true, reason: `Permission denied: ${reason}` };
}

/** Applies Kea's default approval policy immediately before tool execution. */
export class PermissionHook implements PreToolUseHook {
  readonly name = "permission";

  constructor(private readonly requestPermission: PermissionRequester) {}

  async execute(call: ToolCall): Promise<HookResult> {
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
      const allowed = await this.requestPermission({
        call,
        reason: "Shell commands can modify the system or access data outside the workspace.",
      });
      return allowed ? undefined : block("Bash command rejected by user");
    }

    // File tools cannot escape the workspace, but mutations still require an
    // explicit human decision. Read-only tools fall through without prompting.
    if (call.name === "write_file" || call.name === "edit_file") {
      const path = call.arguments.path;
      const allowed = await this.requestPermission({
        call,
        reason: `This tool will modify ${typeof path === "string" ? path : "a workspace file"}.`,
      });
      return allowed ? undefined : block("file change rejected by user");
    }

    return undefined;
  }
}
