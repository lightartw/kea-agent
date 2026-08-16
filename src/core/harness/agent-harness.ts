import { randomUUID } from "node:crypto";

import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopConfig, AgentMessage, AgentRunIdentity } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { Events } from "../events/events.js";
import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import { errorMessage } from "../util/index.js";
import type { HarnessRunEnd } from "./events.js";
import { Session } from "./session/session.js";
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

export class AgentHarness {
  private readonly session: Session;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly systemPrompt: string;
  private readonly events: Events;

  private activeRun: ActiveRun | undefined;
  private readonly runtime: ModelRuntime;

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
    this.currentModel = config.session.modelSelection() ?? config.modelConfig;
    this.events = config.events;
  }

  // ── Private helpers ──

  private assertIdle(): void {
    if (this.running) throw new Error("AgentHarness is busy");
  }

  private createLoopConfig(run: AgentRunIdentity): AgentLoopConfig {
    return {
      model: this.currentModel,
      convertToLlm: (messages) => messages,
      events: this.events,
      run,
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
      await this.events.emit("harness/run-start", run);

      if (!this.abortRequested) {
        const config = this.createLoopConfig(run);
        const messages = [...this.session.messages()];
        await runAgentLoop(
          input,
          {
            systemPrompt: this.systemPrompt,
            messages,
            tools: this.toolRegistry,
            appendMessage: async (message) => {
              await this.session.append({ type: "message", message });
              messages.push(message);
            },
          },
          config,
          this.runtime,
          abortController.signal,
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
      const endInput: HarnessRunEnd = failure === undefined
        ? { ...run, reason: sawAborted ? "aborted" : "completed" }
        : { ...run, reason: "error", errorMessage: errorMessage(failure) };
      await this.events.emit("harness/run-end", endInput);
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

  // ── State ──

  get sessionId(): string {
    return this.session.id;
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
