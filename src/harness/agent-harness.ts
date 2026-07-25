import { Agent } from "../agent/agent.js";
import type { AgentEvent, AgentMessage } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { ModelConfig } from "../ai/types.js";
import { Session } from "./session/session.js";
import type {
  HarnessConfig,
  HarnessEventListener,
  SystemPromptBuilder,
  Unsubscribe,
} from "./types.js";

export class AgentHarness {
  private readonly session: Session;
  private readonly agent: Agent;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly listeners = new Set<HarnessEventListener>();
  private currentModel: ModelConfig;
  private persistedMessageCount: number;
  private running = false;
  private abortRequested = false;

  constructor(config: HarnessConfig) {
    const context = config.session.buildContext();
    this.session = config.session;
    this.toolRegistry = config.toolRegistry;
    this.buildSystemPrompt = config.systemPrompt;
    this.cwd = config.cwd;
    this.currentModel = context.model ?? config.model;
    this.persistedMessageCount = context.messages.length;
    this.agent = new Agent(
      config.streamFn,
      this.currentModel,
      config.toolRegistry,
      context.messages,
    );
  }

  // ── Private helpers ──

  private assertIdle(): void {
    if (this.running) throw new Error("AgentHarness is busy");
  }

  private async prepareAgentForRun(): Promise<void> {
    this.agent.model = this.currentModel;
    this.agent.systemPrompt = await this.buildSystemPrompt({
      model: this.currentModel,
      tools: this.toolRegistry.all(),
      cwd: this.cwd,
      date: new Date(),
    });
  }

  private async persistNewMessages(): Promise<void> {
    while (this.persistedMessageCount < this.agent.messages.length) {
      const message = this.agent.messages[this.persistedMessageCount]!;
      await this.session.appendMessage(message);
      this.persistedMessageCount++;
    }
  }

  private async publish(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event);
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

      for await (const event of this.agent.prompt(input)) {
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
    this.agent.abort();
  }

  // ── Model ──

  async switchModel(model: ModelConfig): Promise<void> {
    this.assertIdle();
    await this.session.appendModelChange(model);
    this.currentModel = model;
    this.agent.model = model;
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
    return this.agent.messages;
  }

  get model(): ModelConfig {
    return this.currentModel;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
