import { HookRegistry } from "../../agent/hooks/registry.js";
import type {
  BeforeToolCall,
  BeforeToolCallResult,
} from "../../agent/hooks/types.js";
import { classifyBashCommand } from "../tools/builtin/bash-policy.js";
import type { CodingAgentInteractions } from "../ui/interactions.js";

interface PermissionContext {
  readonly cwd: string;
  readonly interactions: CodingAgentInteractions;
}

export function createPermissionHooks(
  context: PermissionContext,
): HookRegistry<PermissionContext> {
  const hooks = new HookRegistry(context);
  hooks.register("tool_call", async (
    call: BeforeToolCall,
    current: PermissionContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    if (call.toolName !== "bash") return undefined;
    const command = call.input.command;
    if (typeof command !== "string") return undefined;

    const decision = classifyBashCommand(command);
    if (decision.decision === "allow") return undefined;
    if (decision.decision === "deny") {
      return { block: true, reason: decision.reason };
    }

    try {
      const allowed = await current.interactions.confirm({
        source: "permission",
        title: "Allow Bash command?",
        message: `${decision.reason}\nTool: bash(${JSON.stringify(call.input)})`,
      }, signal);
      return allowed
        ? undefined
        : { block: true, reason: "permission denied by user" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `permission confirmation failed: ${message}` };
    }
  });
  return hooks;
}
