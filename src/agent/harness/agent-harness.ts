import { AgentSession } from "../agent-session.js";
import type { LLMClient } from "../../llm-client/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "../agent-loop.js";
import type { Project, SessionStore } from "./types.js";

/**
 * Middle infrastructure layer. Wraps AgentSession with project context,
 * session persistence, and system prompt assembly. Tool-agnostic and UI-agnostic.
 */
export class AgentHarness {
  constructor(
    private readonly project: Project,
    private readonly sessionStore: SessionStore,
    private readonly client: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly systemPromptContent: string,
  ) {}

  /**
   * Run one user prompt through the agent loop. Rebuilds history from the
   * session store, injects the system prompt on first use, runs the loop,
   * and appends all new messages to the store.
   */
  async *prompt(userInput: string): AsyncIterable<AgentEvent> {
    // 1. Load existing history from session store.
    const history = await this.sessionStore.load();

    // 2. Prepend system prompt if this is a fresh session.
    const messages = history.length === 0
      ? [{ role: "system" as const, content: this.systemPromptContent }]
      : [...history];

    // 3. Create AgentSession with the assembled history.
    const session = new AgentSession(this.client, this.toolRegistry, messages);

    // 4. Run the agent turn — yield events for the UI.
    for await (const event of session.submit(userInput)) {
      yield event;
    }

    // 5. Persist only new messages from this completed turn.
    for (let i = history.length; i < session.messages.length; i++) {
      await this.sessionStore.append(session.messages[i]!);
    }
  }
}
