import { runAgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentState } from "./types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";

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
  private history: AgentMessage[];
  private activeRun: ActiveRun | undefined;
  private errorMessage: string | undefined;
  private _streamFn: StreamFn;
  private _model: ModelConfig;
  private _systemPrompt: string;
  private _hooks: Omit<AgentLoopConfig, "model" | "convertToLlm"> | undefined;

  constructor(
    streamFn: StreamFn,
    model: ModelConfig,
    private readonly _registry: AgentToolRegistry,
    initialMessages: readonly AgentMessage[] = [],
    systemPrompt = "",
    hooks?: Omit<AgentLoopConfig, "model" | "convertToLlm">,
  ) {
    this.history = [...initialMessages];
    this._streamFn = streamFn;
    this._model = model;
    this._systemPrompt = systemPrompt;
    this._hooks = hooks;
  }

  /** Default conversion: AgentMessage = Message, so identity is safe. */
  private static defaultConvertToLlm(messages: AgentMessage[]): Message[] {
    return messages as Message[];
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

  get messages(): readonly AgentMessage[] {
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

  /** Cancel current run and clear conversation history. */
  reset(): void {
    this.abort();
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

    // Build config per-run so model changes are reflected
    const config: AgentLoopConfig = {
      model: this._model,
      convertToLlm: Agent.defaultConvertToLlm,
      ...this._hooks,
    };

    try {
      for await (const event of runAgentLoop(
        input,
        {
          systemPrompt: this._systemPrompt,
          messages: this.history,
          tools: this._registry,
        },
        config,
        this._streamFn,
        abortController.signal,
      )) {
        if (event.type === "agent_end") {
          for (const msg of event.messages) {
            if (msg.role === "assistant" && msg.errorMessage) {
              this.errorMessage = msg.errorMessage;
            } else if (msg.role === "tool" && msg.isError) {
              this.errorMessage = msg.content;
            }
          }
        }
        yield event;
      }
    } finally {
      this.activeRun = undefined;
    }
  }
}
