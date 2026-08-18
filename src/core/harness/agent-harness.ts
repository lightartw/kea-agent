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
import type { Events } from "../events/events.js";
import type { ModelConfig, ModelRuntime } from "../ai/types.js";
import { errorMessage } from "../util/index.js";
import type { HarnessEvent, HarnessRunEnd } from "./events.js";
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

export class AgentHarness {
  private readonly session: Session;
  private readonly toolRegistry: AgentToolRegistry;
  private readonly systemPrompt: string;
  private readonly events: Events;

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
    this.events = config.events;
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
      await this.events.emit("harness/run-start", run);

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
          signal: abortController.signal,
          appendMessage: async (message) => {
            await this.session.append({ type: "message", message });
            messages.push(message);
            if (message.role === "user") {
              await ensureSessionTitle({
                session: this.session,
                prompt: message.content,
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

  // ── Subscription ──

  /**
   * Observe the emit facts belonging to this Session through a typed facade.
   * The listener never sees Session identity or intercept control points;
   * listener errors are isolated by the shared Events error handler.
   * The returned unsubscribe function is idempotent.
   */
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    const belongsToSession = (sessionId: string): boolean =>
      sessionId === this.session.id;
    const off = [
      this.events.on("harness/run-start", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({ type: "run-start", runId: input.runId });
        }
      }),
      this.events.on("harness/run-end", (input) => {
        if (!belongsToSession(input.sessionId)) return;
        listener(input.reason === "error"
          ? {
              type: "run-end",
              runId: input.runId,
              reason: "error",
              errorMessage: input.errorMessage,
            }
          : { type: "run-end", runId: input.runId, reason: input.reason });
      }),
      this.events.on("agent/turn-start", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({ type: "turn-start", runId: input.runId });
        }
      }),
      this.events.on("agent/turn-end", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "turn-end",
            runId: input.runId,
            message: input.message,
            toolResults: input.toolResults,
          });
        }
      }),
      this.events.on("agent/text-delta", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({ type: "text-delta", runId: input.runId, text: input.text });
        }
      }),
      this.events.on("agent/thinking-delta", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "thinking-delta",
            runId: input.runId,
            thinking: input.thinking,
          });
        }
      }),
      this.events.on("agent/tool-call-start", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "tool-call-start",
            runId: input.runId,
            id: input.id,
            name: input.name,
          });
        }
      }),
      this.events.on("agent/tool-call-delta", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "tool-call-delta",
            runId: input.runId,
            id: input.id,
            argumentsDelta: input.argumentsDelta,
          });
        }
      }),
      this.events.on("agent/tool-call", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "tool-call",
            runId: input.runId,
            cwd: input.cwd,
            call: input.call,
          });
        }
      }),
      this.events.on("agent/tool-result", (input) => {
        if (belongsToSession(input.sessionId)) {
          listener({
            type: "tool-result",
            runId: input.runId,
            cwd: input.cwd,
            call: input.call,
            result: input.result,
          });
        }
      }),
    ];
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const unsubscribe of off) unsubscribe();
    };
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
