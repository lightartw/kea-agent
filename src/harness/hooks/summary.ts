import type { Hook, HookResult, StopEvent } from "../../agent/hooks/types.js";

/** Prints tool-call count at session end. Teaching-version hook. */
export class SummaryHook implements Hook<StopEvent> {
  readonly name = "summary";
  readonly eventType = "stop";

  execute(event: StopEvent): HookResult | void {
    const toolCount = event.messages.filter(
      (m) => m.role === "tool",
    ).length;
    console.log(
      `\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`,
    );
  }
}
