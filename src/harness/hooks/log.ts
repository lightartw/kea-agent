import type { Hook, PostToolUseEvent, PreToolUseEvent } from "../../agent/hooks/types.js";

/** Logs every tool call name. Teaching-version hook. */
export class LogHook implements Hook<PreToolUseEvent> {
  readonly name = "log";
  readonly eventType = "pre_tool_use";

  execute(event: PreToolUseEvent): void {
    console.log(`[HOOK] ${event.call.name}(...)`);
  }
}

/** Warns when tool output exceeds 100 KB. Teaching-version hook. */
export class LargeOutputHook implements Hook<PostToolUseEvent> {
  readonly name = "large_output";
  readonly eventType = "post_tool_use";

  execute(event: PostToolUseEvent): void {
    if (event.result.content.length > 100_000) {
      console.log(
        `\x1b[33m[HOOK] ⚠ Large output from ${event.call.name}\x1b[0m`,
      );
    }
  }
}
