import { runAgentTurn, type AgentEvent } from "./agent-turn.js";
import type { LLMClient, Message } from "./llm-client/types.js";
import type { ToolRegistry } from "./tools/registry.js";

/** Owns one conversation while presentation layers only submit input and render events. */
export class AgentSession {
  private readonly history: Message[];
  private active = false;

  constructor(
    private readonly client: LLMClient,
    private readonly registry: ToolRegistry,
    initialMessages: readonly Message[] = [],
  ) {
    this.history = [...initialMessages];
  }

  get messages(): readonly Message[] {
    return this.history;
  }

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
