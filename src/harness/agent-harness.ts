import { randomUUID } from "node:crypto";

import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopConfig, AgentEvent, AgentMessage } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import { HookRegistry } from "../agent/hooks/registry.js";
import type { AgentHookTrigger } from "../agent/hooks/types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import { Session } from "./session/session.js";
import { HarnessEventBus } from "./events/event-bus.js";
import {
  liftAgentEvent,
  MAIN_LANE,
  type HarnessEventContext,
  type HarnessListener,
  type HarnessListenerErrorHandler,
  type HarnessRunEndEvent,
  type Unsubscribe,
} from "./events/types.js";
import type {
  HarnessConfig,
  SystemPromptBuilder,
} from "./types.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

export class AgentHarness {
  private readonly session: Session;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly events: HarnessEventBus;

  // Absorbed from Agent
  private _messages: AgentMessage[];
  private agentSystemPrompt = "";
  private activeRun: ActiveRun | undefined;
  private _streamFn: StreamFn;

  // Hook registry
  private hooks: AgentHookTrigger;

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
    this.hooks = config.hooks ??
      new HookRegistry<Record<string, never>>({});
    this.events = new HarnessEventBus(config.onEventListenerError);
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

    const eventContext: HarnessEventContext = { lane: MAIN_LANE, runId: randomUUID() };
    let started = false;
    let sawAborted = false;
    let failure: unknown;

    try {
      await this.prepareAgentForRun();
      if (this.abortRequested) return;

      started = true;
      await this.events.publish({ type: "run_start", ...eventContext });

      if (!this.abortRequested) {
        for await (const event of this.runPrompt(input)) {
          await this.persistNewMessages();
          await this.events.publish(liftAgentEvent(event, eventContext));
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await this.persistNewMessages();
      } catch (error) {
        failure ??= error;
      } finally {
        sawAborted = this.abortRequested;
        this.running = false;
        this.abortRequested = false;
      }
    }

    if (started) {
      const endEvent: HarnessRunEndEvent = failure === undefined
        ? { type: "run_end", ...eventContext, reason: sawAborted ? "aborted" : "completed" }
        : { type: "run_end", ...eventContext, reason: "error", errorMessage: errorMessage(failure) };
      await this.events.publish(endEvent);
    }

    if (failure !== undefined) throw failure;
  }

  subscribe(listener: HarnessListener): Unsubscribe {
    return this.events.subscribe(listener);
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

  get sessionId(): string {
    return this.session.id;
  }

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
