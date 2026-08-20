import type { AgentToolCall } from "../../core/harness/tools/types.js";
import type { HookContext, PreToolDecision } from "../../core/harness/hooks.js";
import { HarnessHooks } from "../../core/harness/hooks.js";
import type { UserInteraction } from "../interaction/interactions.js";
import { decidePermission, type PermissionRule } from "./permission/permission.js";

/**
 * Create a `HarnessHooks` with the built-in control hooks registered.
 * Permission's `beforeTool` decision is one of them. This function is
 * stateless (all state is passed in) and is called once per Harness by the
 * Project. A future extension/plugin loader would create additional hooks or
 * register against the returned surface.
 */
export function createHooks(options: {
  readonly approved: PermissionRule[];
  readonly trustedDirectories: readonly string[];
  readonly interaction: UserInteraction;
}): HarnessHooks {
  const hooks = new HarnessHooks();
  hooks.on(
    "beforeTool",
    async (
      { call }: { readonly call: AgentToolCall },
      ctx: HookContext,
    ): Promise<PreToolDecision | void> => {
      const decision = await decidePermission(
        call,
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
  return hooks;
}
