import { randomUUID } from "node:crypto";

import { runAgentLoop } from "./agent-loop.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentRunIdentity,
} from "./types.js";
import type { AgentTool } from "./tools/types.js";
import type { AgentToolRegistry } from "./tools/registry.js";
import { HarnessEventBus, type HarnessEvent, type HarnessEventType } from "./events.js";
import { HarnessHooks } from "./hooks.js";
import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import { errorMessage } from "../util/index.js";
import { Session } from "./session/session.js";
import { ensureSessionTitle } from "./session-title.js";
import type { HarnessConfig } from "./types.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

/** True only for genuine cancellation: the signal is aborted and the failure is its reason or an AbortError. */
function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

const EVENT_TYPES: readonly HarnessEventType[] = [
  "run-start",
  "run-end",
  "turn-start",
  "turn-end",
  "text-start",
  "text-end",
  "thinking-start",
  "thinking-end",
  "text-delta",
  "thinking-delta",
  "tool-call-start",
  "tool-call-delta",
  "tool-call",
  "tool-result",
];

export class AgentHarness {
  private readonly session: Session;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly systemPrompt: string;
  private readonly events: HarnessEventBus;
  private readonly hooksState: HarnessHooks;

  private activeRun: ActiveRun | undefined;
  private readonly runtime: ModelRuntime;
  private readonly maxTurns: number | undefined;

  // Model
  private currentModel: ModelConfig;

  // State
  private running = false;
  private abortRequested = false;

  constructor(config: HarnessConfig) {
    this.session = config.session;
    this.toolRegistry = config.toolRegistry;
    this.systemPrompt = config.systemPrompt;
    this.runtime = config.runtime;
    this.maxTurns = config.maxTurns;
    this.currentModel = config.session.modelSelection() ?? config.modelConfig;
    this.events = new HarnessEventBus(
      config.onListenerError === undefined
        ? undefined
        : (error, type, event) => config.onListenerError!(error, type, event),
    );
    this.hooksState = new HarnessHooks();
  }

  // ── Private helpers ──

  private assertIdle(): void {
    if (this.running) throw new Error("AgentHarness is busy");
  }

  private createLoopConfig(): AgentLoopConfig {
    return {
      model: this.currentModel,
      convertToLlm: (messages) => messages,
      ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
    };
  }

  // ── Core ──

  async prompt(input: string): Promise<void> {
    this.assertIdle();
    this.running = true;
    this.abortRequested = false;

    const abortController = new AbortController();
    this.activeRun = { abortController };
    const run: AgentRunIdentity = {
      sessionId: this.session.id,
      runId: randomUUID(),
    };
    let started = false;
    let sawAborted = false;
    let failure: unknown;

    try {
      started = true;
      await this.events.emit({ type: "run-start", runId: run.runId });

      if (!this.abortRequested) {
        const config = this.createLoopConfig();
        const messages = [...this.session.messages()];
        const agentContext: AgentContext = {
          sessionId: this.session.id,
          runId: run.runId,
          cwd: this.session.metadata.cwd,
          systemPrompt: this.systemPrompt,
          messages,
          tools: this.toolRegistry,
          events: this.events,
          hooks: this.hooksState,
          signal: abortController.signal,
          appendMessage: async (message) => {
            await this.session.append({ type: "message", message });
            messages.push(message);
            if (message.role === "user") {
              await ensureSessionTitle({
                session: this.session,
                runtime: this.runtime,
                model: this.currentModel,
                signal: abortController.signal,
              });
            }
          },
        };
        await runAgentLoop(
          input,
          agentContext,
          config,
          this.runtime.stream.bind(this.runtime),
        );
      }
    } catch (error) {
      if (!isAbortFailure(error, abortController.signal)) {
        failure = error;
      }
    } finally {
      sawAborted = this.abortRequested;
      this.activeRun = undefined;
      this.running = false;
      this.abortRequested = false;
    }

    if (started) {
      await this.events.emit(failure === undefined
        ? {
            type: "run-end",
            runId: run.runId,
            reason: sawAborted ? "aborted" : "completed",
          }
        : {
            type: "run-end",
            runId: run.runId,
            reason: "error",
            errorMessage: errorMessage(failure),
          });
    }

    if (failure !== undefined) throw failure;
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
    await this.session.append({ type: "model_selection", selection: model });
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

  // ── Subscription ──

  /**
   * Observe the facts of this Harness through its own event bus. Each Harness
   * is bound to one Session, so there is no session filtering or projection;
   * listener errors are isolated by the bus. The returned unsubscribe is
   * idempotent.
   */
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    const offs = EVENT_TYPES.map((type) => this.events.on(type, listener));
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const unsubscribe of offs) unsubscribe();
    };
  }

  // ── State ──

  get sessionId(): string {
    return this.session.id;
  }

  get hooks(): HarnessHooks {
    return this.hooksState;
  }

  get title(): string {
    return this.session.metadata.title;
  }

  setTitle(title: string): Promise<void> {
    return this.session.setTitle(title);
  }

  get messages(): readonly AgentMessage[] {
    return this.session.messages();
  }

  get model(): ModelConfig {
    return this.currentModel;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
