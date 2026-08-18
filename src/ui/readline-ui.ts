import { createInterface, type Interface } from "node:readline/promises";

import type { ModelConfig } from "../core/ai/index.js";
import type { AgentHarness } from "../core/harness/index.js";
import type { Project } from "../coding-agent/index.js";
import { parseInput } from "./commands.js";
import { ReadlineInteractions } from "./interactions.js";
import { Renderer } from "./renderer.js";

export interface ReadlineUiOptions {
  readonly models: readonly ModelConfig[];
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly reportError: (error: unknown) => void;
  readonly readline?: Interface;
  readonly input?: NodeJS.ReadStream;
  readonly write?: (text: string) => void;
  readonly log?: (text: string) => void;
}

const PROMPT = "kea> ";

/**
 * Linear terminal application: one prompt, one Run at a time, no concurrent
 * reads of the readline. Owns exactly one ReadlineInteractions (the question
 * function is shared with the loop) and one Renderer; errors in caught
 * actions are reported through the injected callback so the caller can
 * redact before terminal output.
 */
export class ReadlineUi {
  readonly interactions: ReadlineInteractions;

  private readonly models: readonly ModelConfig[];
  private readonly readline: Interface;
  private readonly renderer: Renderer;
  private readonly reportErrorFn: (error: unknown) => void;
  private project: Project | undefined;
  private current: AgentHarness | undefined;
  private unsubscribe: () => void = () => {};
  private closed = false;
  private readonly onSigint = (): void => {
    if (this.current !== undefined && this.current.isRunning) {
      this.current.abort();
    }
  };

  constructor(options: ReadlineUiOptions) {
    this.models = options.models;
    this.readline = options.readline ?? createInterface({
      input: options.input ?? process.stdin,
      output: process.stdout,
    });
    this.renderer = new Renderer({
      thinking: options.thinking,
      toolDetails: options.toolDetails,
      write: options.write ?? ((text: string) => process.stdout.write(text)),
      log: options.log ?? ((text: string) => console.log(text)),
    });
    this.reportErrorFn = options.reportError;
    this.interactions = new ReadlineInteractions({
      question: (prompt, questionOptions) =>
        questionOptions === undefined
          ? this.readline.question(prompt)
          : this.readline.question(prompt, questionOptions),
      log: options.log ?? ((text: string) => console.log(text)),
    });
  }

  /** Install SIGINT handling and drive one Session at a time until exit/EOF. */
  async run(project: Project, initialHarness: AgentHarness): Promise<void> {
    this.project = project;
    process.on("SIGINT", this.onSigint);
    try {
      if (!await this.activate(initialHarness)) return;
      while (true) {
        const input = await this.readPrompt();
        if (input === undefined) return;
        const action = parseInput(input);
        switch (action.kind) {
          case "prompt":
            this.renderer.renderUser(action.text);
            try {
              await this.current!.prompt(action.text);
            } catch (error) {
              this.reportErrorFn(error);
            }
            break;
          case "new-session":
            try {
              await this.activate(await this.project.createHarness());
            } catch (error) {
              this.reportErrorFn(error);
            }
            break;
          case "switch-session":
            try {
              await this.chooseAndActivateSession();
            } catch (error) {
              this.reportErrorFn(error);
            }
            break;
          case "switch-model":
            try {
              await this.chooseAndSwitchModel();
            } catch (error) {
              this.reportErrorFn(error);
            }
            break;
          case "help":
            this.renderer.renderHelp();
            break;
          case "exit":
            return;
          case "command-error":
            this.renderer.renderError(action.message);
            break;
        }
      }
    } finally {
      // SIGINT stays installed until close() so Permission-time aborts work.
    }
  }

  /**
   * Atomically switch the active Harness: repair the model first, then swap
   * subscription, state, and rendering. Returns false without touching old
   * state when the model selection is cancelled or fails.
   */
  private async activate(candidate: AgentHarness): Promise<boolean> {
    if (!await this.ensureConfiguredModel(candidate)) return false;
    this.unsubscribe();
    this.current = candidate;
    this.renderer.renderSession(candidate);
    this.unsubscribe = candidate.subscribe((event) => this.renderer.handle(event));
    return true;
  }

  /** Idempotent: remove SIGINT handling, unsubscribe, and close readline once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("SIGINT", this.onSigint);
    this.unsubscribe();
    this.readline.close();
  }

  private async chooseAndActivateSession(): Promise<void> {
    const sessions = await this.project!.listSessions();
    if (sessions.length === 0) {
      this.renderer.renderError("no sessions yet");
      return;
    }
    this.renderer.renderSelection(
      "Sessions (newest first):",
      sessions.map((metadata) => `${metadata.title} — ${metadata.updatedAt}`),
    );
    const index = await this.chooseIndex("Session number? ", sessions.length);
    if (index === undefined) return;
    const candidate = await this.project!.createHarnessFromSession(sessions[index - 1]!.id);
    await this.activate(candidate);
  }

  private async chooseAndSwitchModel(): Promise<void> {
    this.renderer.renderSelection(
      "Models:",
      this.models.map((model) => `${model.provider}/${model.model}`),
    );
    const index = await this.chooseIndex("Model number? ", this.models.length);
    if (index === undefined) return;
    const selected = this.models[index - 1]!;
    if (this.isSameModel(selected, this.current!.model)) return;
    await this.current!.switchModel(selected);
  }

  private async ensureConfiguredModel(candidate: AgentHarness): Promise<boolean> {
    if (this.models.some((model) => this.isSameModel(model, candidate.model))) {
      return true;
    }
    this.renderer.renderError(
      `model ${candidate.model.provider}/${candidate.model.model} is not configured`,
    );
    this.renderer.renderSelection(
      "Choose a configured model:",
      this.models.map((model) => `${model.provider}/${model.model}`),
    );
    const index = await this.chooseIndex("Model number? ", this.models.length);
    if (index === undefined) return false;
    const selected = this.models[index - 1]!;
    try {
      await candidate.switchModel(selected);
      return true;
    } catch (error) {
      this.reportErrorFn(error);
      return false;
    }
  }

  /** EOF rejects with AbortError; treat it as exit rather than an error. */
  private async readPrompt(prompt = PROMPT): Promise<string | undefined> {
    try {
      return await this.readline.question(prompt);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return undefined;
      throw error;
    }
  }

  /** One-based numbered selection; blank input and EOF cancel. */
  private async chooseIndex(prompt: string, count: number): Promise<number | undefined> {
    const answer = await this.readPrompt(prompt);
    if (answer === undefined) return undefined;
    const trimmed = answer.trim();
    if (!/^\d+$/u.test(trimmed)) return undefined;
    const index = Number.parseInt(trimmed, 10);
    return index >= 1 && index <= count ? index : undefined;
  }

  private isSameModel(a: ModelConfig, b: ModelConfig): boolean {
    return a.provider === b.provider && a.model === b.model;
  }
}
