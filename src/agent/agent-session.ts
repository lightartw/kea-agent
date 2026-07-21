import { runAgentTurn } from "./agent-loop.js";
import type { AgentEvent } from "./types.js";
import type { LLMClient, Message } from "../llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * Owns one in-memory conversation while presentation layers only submit input
 * and render events. Persistence can later attach here without entering the UI.
 */
export class AgentSession {
  private readonly history: Message[];
  private active = false;

  constructor(
    private readonly client: LLMClient,
    private readonly registry: ToolRegistry,
    initialMessages: readonly Message[] = [],
  ) {
    // Copy the array so callers cannot replace or append session history behind
    // the session's lifecycle checks.
    this.history = [...initialMessages];
  }

  /** Exposes history for inspection without granting mutation through the type. */
  get messages(): readonly Message[] {
    return this.history;
  }

  /**
   * Append one user message and run all LLM/tool round trips needed to answer it.
   * A session accepts only one active submission, which also suits a future TUI.
   */
  async *submit(input: string): AsyncIterable<AgentEvent> {
    if (this.active) throw new Error("Agent session is already running");
    this.active = true;
    try {
      this.history.push({ role: "user", content: input });
      yield* runAgentTurn(this.history, this.client, this.registry);
    } finally {
      this.active = false;
    }
  }
}
