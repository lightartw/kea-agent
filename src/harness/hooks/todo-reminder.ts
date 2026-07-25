import type {
  Hook,
  PostToolUseEvent,
  PreTurnEvent,
  UserPromptSubmitEvent,
} from "./types.js";

const THRESHOLD = 3;

/** Shared mutable state — one counter per session, closed over by the 3 hooks below. */
let roundsSinceTodo = 0;

function reset(): void {
  roundsSinceTodo = 0;
}

function markCalled(): void {
  roundsSinceTodo = 0;
}

function tickAndCheck(): string | undefined {
  roundsSinceTodo++;
  if (roundsSinceTodo >= THRESHOLD) {
    roundsSinceTodo = 0;
    return "<reminder>Update your todos.</reminder>";
  }
  return undefined;
}

/**
 * Hook 1/3 — resets the counter when a new user prompt arrives.
 */
export class TodoResetHook implements Hook<UserPromptSubmitEvent> {
  readonly name = "todo_reset";
  readonly eventType = "user_prompt_submit" as const;

  execute(): void {
    reset();
  }
}

/**
 * Hook 2/3 — resets the counter when todo_write is called.
 * Subscribes to post_tool_use so agent-loop has zero knowledge of todo_write.
 */
export class TodoCalledHook implements Hook<PostToolUseEvent> {
  readonly name = "todo_called";
  readonly eventType = "post_tool_use" as const;

  execute(event: PostToolUseEvent): void {
    if (event.call.name === "todo_write") {
      markCalled();
    }
  }
}

/**
 * Hook 3/3 — fires before each LLM call. Increments the counter and
 * injects a reminder after THRESHOLD consecutive rounds without todo_write.
 */
export class TodoRemindHook implements Hook<PreTurnEvent> {
  readonly name = "todo_remind";
  readonly eventType = "pre_turn" as const;

  execute(_event: PreTurnEvent) {
    const reminder = tickAndCheck();
    if (reminder !== undefined) {
      return { context: reminder };
    }
    return undefined;
  }
}
