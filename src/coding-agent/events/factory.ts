import { Events } from "../../core/events/events.js";
import type { Interactions } from "../interaction/interactions.js";
import { decidePermission, type PermissionRule } from "./permission/permission.js";

/**
 * Composition root: creates the Coding runtime's Events bus and registers the
 * default Permission listener on tools/pre-execute. An external assembler
 * hands the returned bus to the Project that consumes it.
 *
 * The options object receives caller-owned, Project-scoped state (approved and
 * trustedDirectories) and the Interaction port directly; no environment
 * abstraction hides them. ToolCallEvent carries the Session cwd needed by
 * Permission.
 *
 * Listener errors are surfaced through a built-in `console.error` handler so
 * a throwing UI/extension listener is never silently swallowed.
 */
export function createBuiltinEvents(options: {
  readonly interactions: Interactions;
  readonly approved: PermissionRule[];
  readonly trustedDirectories: readonly string[];
}): Events {
  const events = new Events((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });

  events.on("tools/pre-execute", async (input, proceed, signal) => {
    const decision = await decidePermission(
      input,
      {
        cwd: input.cwd,
        trustedDirectories: options.trustedDirectories,
        approved: options.approved,
        interactions: options.interactions,
      },
      signal,
    );
    return decision.kind === "allow" ? proceed(input) : decision;
  });

  return events;
}
