import { runAgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentState } from "./types.js";
import type { LLMClient, Message } from "../llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { HookRegistry } from "./hooks/registry.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

/**
 * Stateful wrapper around the pure agent loop. Owns the conversation history,
 * system prompt, and all user-prompt-level lifecycle hooks. When compaction
 * is added it will live here as a method on the same object that owns the
 * messages.
 */
export class Agent {
  private history: Message[];
  private activeRun: ActiveRun | undefined;
  private errorMessage: string | undefined;

  constructor(
    private readonly client: LLMClient,
    private readonly registry: ToolRegistry,
    initialMessages: readonly Message[] = [],
    private systemPrompt = "",
    private readonly hooks?: HookRegistry,
  ) {
    this.history = [...initialMessages];
  }

  // ── Public state ──

  get state(): AgentState {
    return {
      messages: this.history,
      systemPrompt: this.systemPrompt,
      isRunning: this.activeRun !== undefined,
      ...(this.errorMessage === undefined ? {} : { errorMessage: this.errorMessage }),
    };
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  get isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  // ── Control ──

  /** Cancel the current prompt (if any). The stream stops at the next yield. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /** Clear conversation history and error state. */
  reset(): void {
    this.history = [];
    this.errorMessage = undefined;
  }

  // ── Prompt ──

  /**
   * Append one user message and run the agent loop until no more tool calls
   * are requested or a hook forces a stop.
   */
  async *prompt(input: string): AsyncIterable<AgentEvent> {
    if (this.activeRun) throw new Error("Agent is already running");

    const abortController = new AbortController();
    this.activeRun = { abortController };
    this.errorMessage = undefined;

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

      // Yield events, capturing error state from the loop
      for await (const event of runAgentLoop(
        this.history,
        this.systemPrompt,
        this.client,
        this.registry,
        this.hooks,
        abortController.signal,
      )) {
        // Track error state from the final message
        if (event.type === "agent_end") {
          const lastMsg = event.messages[event.messages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.errorMessage) {
            this.errorMessage = lastMsg.errorMessage;
          }
        }
        yield event;
      }
    } finally {
      this.activeRun = undefined;
    }
  }
}
