import { runAgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentState } from "./types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { HookRegistry } from "./hooks/registry.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

/**
 * Stateful wrapper around the pure agent loop. Owns the conversation history,
 * system prompt, model config, and stream function. Harness mutates model and
 * systemPrompt across turns; Agent stays the same instance for the session.
 */
export class Agent {
  private history: Message[];
  private activeRun: ActiveRun | undefined;
  private errorMessage: string | undefined;
  private _streamFn: StreamFn;
  private _model: ModelConfig;
  private _systemPrompt: string;

  constructor(
    streamFn: StreamFn,
    model: ModelConfig,
    private readonly registry: ToolRegistry,
    initialMessages: readonly Message[] = [],
    systemPrompt = "",
    private readonly hooks?: HookRegistry,
  ) {
    this.history = [...initialMessages];
    this._streamFn = streamFn;
    this._model = model;
    this._systemPrompt = systemPrompt;
  }

  // ── Public state ──

  get state(): AgentState {
    return {
      messages: this.history,
      model: this._model,
      systemPrompt: this._systemPrompt,
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

  // ── Mutable config (Harness mutates these across turns) ──

  get streamFn(): StreamFn { return this._streamFn; }
  set streamFn(f: StreamFn) { this._streamFn = f; }

  get model(): ModelConfig { return this._model; }
  set model(m: ModelConfig) { this._model = m; }

  get systemPrompt(): string { return this._systemPrompt; }
  set systemPrompt(s: string) { this._systemPrompt = s; }

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
          this._systemPrompt += (this._systemPrompt ? "\n" : "") + result.context;
        }
      }

      this.history.push({ role: "user", content: input });

      // Yield events, capturing error state from the loop
      for await (const event of runAgentLoop(
        this.history,
        this._systemPrompt,
        this._streamFn,
        this._model,
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
