import type { Hook, UserPromptSubmitEvent } from "./types.js";

/** Logs working directory on every user prompt. Teaching-version hook. */
export class ContextInjectHook implements Hook<UserPromptSubmitEvent> {
  readonly name = "context_inject";
  readonly eventType = "user_prompt_submit";

  constructor(private readonly cwd: string) {}

  execute(_event: UserPromptSubmitEvent): void {
    console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${this.cwd}\x1b[0m`);
  }
}
