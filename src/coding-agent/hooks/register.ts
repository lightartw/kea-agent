import type { AgentHarness } from "../../core/harness/agent-harness.js";
import type { AgentToolCall } from "../../core/harness/tools/types.js";
import type {
  HookContext,
  PreToolDecision,
  ToolCallEvent,
} from "../../core/harness/events.js";
import type { UserInteraction } from "../interaction/interactions.js";
import { decidePermission, type PermissionRule } from "./permission/permission.js";

/**
 * Register the built-in control hooks on a freshly created Harness.
 * Permission's `beforeTool` decision is one of them. This function is
 * stateless: all state is passed in, and the Project calls it once per
 * Harness. A future extension/plugin loader would register additional hooks
 * through the same `harness.hooks.on(...)` surface.
 */
export function registerBuiltinHooks(
  harness: AgentHarness,
  options: {
    readonly approved: PermissionRule[];
    readonly trustedDirectories: readonly string[];
    readonly interaction: UserInteraction;
  },
): void {
  harness.hooks.on(
    "beforeTool",
    async (
      { call }: { readonly call: AgentToolCall },
      ctx: HookContext,
    ): Promise<PreToolDecision | void> => {
      const event: ToolCallEvent = {
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        cwd: ctx.cwd,
        call,
      };
      const decision = await decidePermission(
        event,
        {
          cwd: ctx.cwd,
          trustedDirectories: options.trustedDirectories,
          approved: options.approved,
          interaction: options.interaction,
        },
        ctx.signal,
      );
      return decision.kind === "deny"
        ? decision.reason === undefined
          ? { kind: "deny" }
          : { kind: "deny", reason: decision.reason }
        : undefined;
    },
  );
}
