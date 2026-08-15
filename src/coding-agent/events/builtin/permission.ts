import type { Events } from "../../../core/events/events.js";
import type { PreToolDecision } from "../../../core/agent/tools/events.js";
import { classifyBashCommand } from "../../tools/builtin/bash/bash-policy.js";
import type { CodingAgentInteractions } from "../../ui/interactions.js";

export function registerPermission(
  events: Events,
  interactions: CodingAgentInteractions,
): void {
  events.on("tools/pre-execute", async (
    call,
    proceed,
    signal,
  ): Promise<PreToolDecision> => {
    if (call.name !== "bash") return proceed(call);
    const command = call.arguments.command;
    if (typeof command !== "string") return proceed(call);

    const classification = classifyBashCommand(command);
    if (classification.decision === "allow") return proceed(call);
    if (classification.decision === "deny") {
      return { kind: "deny", reason: classification.reason };
    }

    try {
      const allowed = await interactions.confirm({
        source: "permission",
        title: "Allow Bash command?",
        message: `${classification.reason}\nTool: bash(${JSON.stringify(call.arguments)})`,
      }, signal);
      return allowed
        ? proceed(call)
        : { kind: "deny", reason: "permission denied by user" };
    } catch (error) {
      return {
        kind: "deny",
        reason: `permission confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
