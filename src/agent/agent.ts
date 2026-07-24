import { runAgentTurn } from "./agent-loop.js";
import type { AgentEvent } from "./types.js";
import type { LLMClient, Message } from "../llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { HookRegistry } from "./hooks/registry.js";

/**
 * Stateful wrapper around the pure agent loop. Owns the conversation history
 * and all user-prompt-level lifecycle hooks. When compaction is added it will
 * live here as a method on the same object that owns the messages.
 */
export class Agent {
  private readonly history: Message[];
  private active = false;

  constructor(
    private readonly client: LLMClient,
    private readonly registry: ToolRegistry,
    initialMessages: readonly Message[] = [],
    private systemPrompt = "",
    private readonly hooks?: HookRegistry,
  ) {
    this.history = [...initialMessages];
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  /**
   * Append one user message and run all LLM/tool round trips.
   */
  async *prompt(input: string): AsyncIterable<AgentEvent> {
    if (this.active) throw new Error("Agent is already running");
    this.active = true;
    try {
      // ① UserPromptSubmit
      if (this.hooks !== undefined) {
        const result = await this.hooks.trigger({
          type: "user_prompt_submit",
          prompt: input,
        });
        if (result?.block === true) return;
        if (result?.context !== undefined) {
          this.systemPrompt += (this.systemPrompt ? "\n" : "") + result.context;
        }
      }
      this.history.push({ role: "user", content: input });
      yield* runAgentTurn(this.history, this.systemPrompt, this.client, this.registry, this.hooks);
    } finally {
      this.active = false;
    }
  }
}
