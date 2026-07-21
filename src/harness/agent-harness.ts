import { Agent } from "../agent/agent.js";
import type { AgentEvent } from "../agent/types.js";
import type { SessionStore } from "./types.js";

/**
 * Application layer. Wraps Agent with session persistence. Like Pi's
 * AgentSession, it holds a single Agent instance across turns.
 */
export class AgentHarness {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly agent: Agent,
  ) {}

  /**
   * Run one user prompt through the agent and persist new messages.
   */
  async *prompt(userInput: string): AsyncIterable<AgentEvent> {
    const historyLength = this.agent.messages.length;
    yield* this.agent.prompt(userInput);
    for (let i = historyLength; i < this.agent.messages.length; i++) {
      await this.sessionStore.append(this.agent.messages[i]!);
    }
  }
}
