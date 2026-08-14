import { randomUUID } from "node:crypto";

import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopConfig, AgentMessage } from "../agent/types.js";
import type { AgentRunIdentity } from "../agent/events.js";
import type { AgentTool } from "../agent/tools/types.js";
import type { AgentToolRegistry } from "../agent/tools/registry.js";
import type { Events } from "../events/events.js";
import type { ModelConfig, StreamFn } from "../ai/types.js";
import { Session } from "./session/session.js";
import { MAIN_LANE } from "./events.js";
import type {
  HarnessConfig,
  SessionTitleGenerator,
  SystemPromptBuilder,
} from "./types.js";

/** Tracks an in-flight prompt so abort() can cancel it. */
interface ActiveRun {
  readonly abortController: AbortController;
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
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
  private readonly buildSystemPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly events: Events;

  // Absorbed from Agent
  private _messages: AgentMessage[];
  private agentSystemPrompt = "";
  private activeRun: ActiveRun | undefined;
  private _streamFn: StreamFn;

  // Model
  private currentModel: ModelConfig;

  // State
  private running = false;
  private abortRequested = false;

  // Automatic title state
  private readonly titleGenerator: SessionTitleGenerator | undefined;
  private titleEligible = false;
  private titleRequested = false;

  constructor(config: HarnessConfig) {
    const context = config.session.buildContext();
    this.session = config.session;
    this.toolRegistry = config.toolRegistry;
    this.buildSystemPrompt = config.systemPrompt;
    this.cwd = config.cwd;
    this._streamFn = config.streamFn;
    this.currentModel = context.model ?? config.model;
    this._messages = [...context.messages];
    this.events = config.events;
    this.titleGenerator = config.titleGenerator;
    this.titleEligible = config.titleGenerator !== undefined &&
      this.session.info.title === "unknown" &&
      !context.messages.some((message) => message.role === "user");
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

  private createLoopConfig(run: AgentRunIdentity): AgentLoopConfig {
    return {
      model: this.currentModel,
      convertToLlm: (messages) => messages,
      events: this.events,
      run,
    };
  }

  /** Launch a detached title task after the first eligible user message is persisted. */
  private maybeStartTitle(): void {
    if (!this.titleEligible || this.titleRequested) return;
    if (!this._messages.some((message) => message.role === "user")) return;
    this.titleEligible = false;
    this.titleRequested = true;
    const prompt = this._messages.find((message) => message.role === "user")!.content;
    const generator = this.titleGenerator!;
    const model = this.currentModel;
    void this.runTitleTask(prompt, model, generator);
  }

  private async runTitleTask(
    prompt: string,
    model: ModelConfig,
    generator: SessionTitleGenerator,
  ): Promise<void> {
    try {
      const raw = await generator(prompt, model);
      const firstLine = raw.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
      const trimmed = firstLine.trim();
      const capped = trimmed.length <= 97 ? trimmed : `${trimmed.slice(0, 97)}...`;
      await this.session.setTitleIfUnknown(capped);
    } catch {
      // Title generation never fails or blocks the Agent Run.
    }
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
      lane: MAIN_LANE,
    };
    let started = false;
    let sawAborted = false;
    let failure: unknown;

    try {
      await this.prepareAgentForRun();
      if (this.abortRequested) return;

      started = true;
      await this.events.emit("harness/run-start", run);

      if (!this.abortRequested) {
        const config = this.createLoopConfig(run);
        await runAgentLoop(
          input,
          {
            systemPrompt: this.agentSystemPrompt,
            messages: this._messages,
            tools: this.toolRegistry,
            appendMessage: async (message) => {
              await this.session.appendMessage(message);
              this._messages.push(message);
              this.maybeStartTitle();
            },
          },
          config,
          this._streamFn,
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
      const endInput: AgentRunIdentity & (
        | { readonly reason: "completed" | "aborted" }
        | { readonly reason: "error"; readonly errorMessage: string }
      ) = failure === undefined
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

  get title(): string {
    return this.session.info.title;
  }

  setTitle(title: string): Promise<void> {
    return this.session.setTitle(title);
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
