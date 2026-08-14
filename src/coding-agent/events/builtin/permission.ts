import type { Events } from "../../../events/events.js";
import { classifyBashCommand } from "../../tools/builtin/bash/bash-policy.js";
import type { CodingAgentInteractions } from "../../ui/interactions.js";

export function registerPermission(
  events: Events,
  interactions: CodingAgentInteractions,
): void {
  events.on("tools/pre-execute", async (call, proceed, signal) => {
    if (call.name !== "bash") return proceed(call);
    const command = call.arguments.command;
    if (typeof command !== "string") return proceed(call);

    const classification = classifyBashCommand(command);
    if (classification.decision === "allow") return proceed(call);
    if (classification.decision === "deny") {
      return { content: `Error: ${classification.reason}`, isError: true };
    }

    try {
      const allowed = await interactions.confirm({
        source: "permission",
        title: "Allow Bash command?",
        message: `${classification.reason}\nTool: bash(${JSON.stringify(call.arguments)})`,
      }, signal);
      return allowed
        ? proceed(call)
        : { content: "Error: permission denied by user", isError: true };
    } catch (error) {
      return {
        content: `Error: permission confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  });
}
