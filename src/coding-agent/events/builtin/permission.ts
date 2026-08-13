import type { Events } from "../../../events/events.js";
import type { ToolCallDecision } from "../../../agent/events.js";
import { classifyBashCommand } from "../../tools/builtin/bash/bash-policy.js";
import type { CodingAgentInteractions } from "../../ui/interactions.js";

export function registerPermission(
  events: Events,
  interactions: CodingAgentInteractions,
): void {
  events.on("agent/tool-call", async (
    decision: ToolCallDecision,
    next,
    signal?: AbortSignal,
  ): Promise<ToolCallDecision> => {
    if (decision.kind !== "execute") return next(decision);
    if (decision.call.name !== "bash") return next(decision);
    const command = decision.call.arguments.command;
    if (typeof command !== "string") return next(decision);

    const classification = classifyBashCommand(command);
    if (classification.decision === "allow") return next(decision);
    if (classification.decision === "deny") {
      return {
        ...decision,
        kind: "reject",
        call: decision.call,
        reason: classification.reason,
      };
    }

    try {
      const allowed = await interactions.confirm({
        source: "permission",
        title: "Allow Bash command?",
        message: `${classification.reason}\nTool: bash(${JSON.stringify(decision.call.arguments)})`,
      }, signal);
      if (!allowed) {
        return {
          ...decision,
          kind: "reject",
          call: decision.call,
          reason: "permission denied by user",
        };
      }
      return next(decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...decision,
        kind: "reject",
        call: decision.call,
        reason: `permission confirmation failed: ${message}`,
      };
    }
  });
}
