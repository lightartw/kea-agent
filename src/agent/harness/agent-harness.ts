import { runAgentLoop } from "../agent-loop.js";
import type { AgentLoopConfig, AgentEvent, AgentMessage } from "../types.js";
import type { AgentTool } from "../tools/types.js";
import type { AgentToolRegistry } from "../tools/registry.js";
import { HookRegistry } from "../hooks/registry.js";
import type { Message, ModelConfig, StreamFn } from "../../ai/types.js";
import { Session } from "./session/session.js";
import type {
  HarnessConfig,
  HarnessEventListener,
  SystemPromptBuilder,
  Unsubscribe,
} from "./types.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

export class AgentHarness {
  private readonly session: Session;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly listeners = new Set<HarnessEventListener>();

  // Absorbed from Agent
  private _messages: AgentMessage[];
  private agentSystemPrompt = "";
  private activeRun: ActiveRun | undefined;
  private _streamFn: StreamFn;

  // Hook registry
  private hooks: HookRegistry;

  // Model
  private currentModel: ModelConfig;
  private persistedMessageCount: number;

  // State
  private running = false;
  private abortRequested = false;

  constructor(config: HarnessConfig) {
    const context = config.session.buildContext();
    this.session = config.session;
    this.toolRegistry = config.toolRegistry;
    this.buildSystemPrompt = config.systemPrompt;
    this.cwd = config.cwd;
    this._streamFn = config.streamFn;
    this.currentModel = context.model ?? config.model;
    this._messages = [...context.messages];
    this.persistedMessageCount = context.messages.length;
    this.hooks = config.hooks ?? new HookRegistry();
  }

  // ── Private helpers ──

  private assertIdle(): void {
    if (this.running) throw new Error("AgentHarness is busy");
  }

  private async prepareAgentForRun(): Promise<void> {
    this.agentSystemPrompt = await this.buildSystemPrompt({
      model: this.currentModel,
      tools: this.toolRegistry.all(),
      cwd: this.cwd,
      date: new Date(),
    });
  }

  private async persistNewMessages(): Promise<void> {
    while (this.persistedMessageCount < this.messages.length) {
      const message = this.messages[this.persistedMessageCount]!;
      await this.session.appendMessage(message);
      this.persistedMessageCount++;
    }
  }

  private async publish(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event);
    }
  }

  private createLoopConfig(): AgentLoopConfig {
    return {
      model: this.currentModel,
      convertToLlm: (msgs) => msgs as Message[],
      hooks: this.hooks,
    };
  }

  // ── Internal: run the agent loop (absorbed from Agent) ──

  private async *runPrompt(input: string): AsyncIterable<AgentEvent> {
    const abortController = new AbortController();
    this.activeRun = { abortController };

    const config = this.createLoopConfig();

    try {
      for await (const event of runAgentLoop(
        input,
        {
          systemPrompt: this.agentSystemPrompt,
          messages: this._messages,
          tools: this.toolRegistry,
        },
        config,
        this._streamFn,
        abortController.signal,
      )) {
        yield event;
      }
    } finally {
      this.activeRun = undefined;
    }
  }

  // ── Core ──

  async prompt(input: string): Promise<void> {
    this.assertIdle();
    this.running = true;
    this.abortRequested = false;

    try {
      await this.prepareAgentForRun();
      if (this.abortRequested) return;

      for await (const event of this.runPrompt(input)) {
        await this.persistNewMessages();
        await this.publish(event);
      }
    } finally {
      try {
        await this.persistNewMessages();
      } finally {
        this.running = false;
        this.abortRequested = false;
      }
    }
  }

  subscribe(listener: HarnessEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Control ──

  abort(): void {
    if (!this.running) return;
    this.abortRequested = true;
    this.activeRun?.abortController.abort();
  }

  // ── Model ──

  async switchModel(model: ModelConfig): Promise<void> {
    this.assertIdle();
    await this.session.appendModelChange(model);
    this.currentModel = model;
  }

  // ── Tools ──

  registerTool(tool: AgentTool): void {
    this.assertIdle();
    this.toolRegistry.register(tool);
  }

  unregisterTool(name: string): void {
    this.assertIdle();
    this.toolRegistry.unregister(name);
  }

  // ── State ──

  get messages(): readonly AgentMessage[] {
    return this._messages;
  }

  get model(): ModelConfig {
    return this.currentModel;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
