import { blockedBashFragment } from "../../tools/builtin/bash.js";
import type { ToolCall } from "../../tools/types.js";
import type { Hook, HookResult, PreToolUseEvent } from "../types.js";

/** Information a presentation adapter needs to ask for one approval. */
export interface PermissionRequest {
  readonly call: ToolCall;
  readonly reason: string;
}

export type PermissionRequester = (
  request: PermissionRequest,
) => Promise<boolean>;

interface PermissionRule {
  readonly tools: readonly string[];
  readonly check: (arguments_: Record<string, unknown>) => boolean;
  readonly reason: (arguments_: Record<string, unknown>) => string;
}

const RISKY_BASH_FRAGMENTS = ["rm ", "> /etc/", "chmod 777"] as const;

/**
 * Gate 2 rules decide which otherwise-allowed calls still need approval.
 * The final Bash rule deliberately asks for unknown commands as a safe default.
 */
const PERMISSION_RULES: readonly PermissionRule[] = [
  {
    tools: ["bash"],
    check: (arguments_) => {
      const command = arguments_.command;
      return typeof command === "string" &&
        RISKY_BASH_FRAGMENTS.some((fragment) => command.includes(fragment));
    },
    reason: () => "Potentially destructive shell command.",
  },
  {
    tools: ["bash"],
    check: () => true,
    reason: () =>
      "Shell commands can modify the system or access data outside the workspace.",
  },
  {
    tools: ["write_file", "edit_file"],
    check: () => true,
    reason: (arguments_) =>
      `This tool will modify ${typeof arguments_.path === "string" ? arguments_.path : "a workspace file"}.`,
  },
];

function block(reason: string): HookResult {
  return { block: true, reason: `Permission denied: ${reason}` };
}

function matchingRuleReason(call: ToolCall): string | undefined {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(call.name) && rule.check(call.arguments)) {
      return rule.reason(call.arguments);
    }
  }
  return undefined;
}

/** Applies Kea's default approval policy immediately before tool execution. */
export class PermissionHook implements Hook<PreToolUseEvent> {
  readonly name = "permission";
  readonly eventType = "pre_tool_use";

  constructor(private readonly requestPermission: PermissionRequester) {}

  async execute(event: PreToolUseEvent): Promise<HookResult> {
    const { call } = event;

    // Gate 1: hard-denied Bash fragments can never be approved interactively.
    if (call.name === "bash") {
      const command = call.arguments.command;
      if (typeof command !== "string") return block("invalid Bash command");

      // Hard-denied commands never reach the approval prompt. BashTool repeats
      // this check immediately before spawn as a final safety backstop.
      const forbidden = blockedBashFragment(command);
      if (forbidden !== undefined) {
        return block(`command contains forbidden fragment '${forbidden}'`);
      }
    }

    // Gate 2: the first matching rule determines whether and why to ask.
    const reason = matchingRuleReason(call);
    if (reason === undefined) return undefined;

    // Gate 3: presentation adapters implement the actual CLI/TUI interaction.
    const allowed = await this.requestPermission({ call, reason });
    if (allowed) return undefined;
    return block(
      call.name === "bash"
        ? "Bash command rejected by user"
        : "file change rejected by user",
    );
  }
}
