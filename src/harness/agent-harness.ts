import { Agent } from "../agent/agent.js";
import type { AgentEvent } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { HookRegistry } from "../agent/hooks/registry.js";
import type { Hook } from "../agent/hooks/types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import { detectModel } from "../ai/factory.js";
import type { Session } from "./session/session.js";
import {
  CODING_SYSTEM_PROMPT,
  defaultSystemPrompt,
  type SystemPromptBuilder,
} from "./system-prompt.js";

export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly tools?: readonly AgentTool[];
  readonly hooks?: readonly Hook[];
  readonly systemPrompt?: SystemPromptBuilder;
  readonly cwd?: string;
}

/**
 * Application layer. Orchestrates Agent, Session, tools, hooks, and model
 * switching. A single instance spans the entire session lifetime.
 */
export class AgentHarness {
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRegistry: HookRegistry;
  private readonly buildPrompt: SystemPromptBuilder;
  private readonly cwd: string;

  private agent: Agent;
  private session: Session;

  constructor(config: HarnessConfig) {
    this.cwd = config.cwd ?? process.cwd();
    this.buildPrompt = config.systemPrompt ?? (() => "");

    // Tools
    this.toolRegistry = new ToolRegistry();
    for (const tool of config.tools ?? []) this.toolRegistry.register(tool);

    // Hooks
    this.hookRegistry = new HookRegistry();
    for (const hook of config.hooks ?? []) this.hookRegistry.register(hook);

    // Session — build initial context
    const { messages, model } = config.session.buildContext();
    const initialModel = model ?? config.model;
    const systemPrompt = this.buildPrompt({
      model: initialModel,
      tools: config.tools ?? [],
      cwd: this.cwd,
      date: new Date(),
    });

    this.session = config.session;
    this.agent = new Agent(
      config.streamFn,
      initialModel,
      this.toolRegistry,
      messages,
      systemPrompt,
      this.hookRegistry,
    );
  }

  // ── Core ──

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    // Sync model from session (may have been switched since last prompt)
    const { model } = this.session.buildContext();
    if (model !== null) {
      this.agent.model = model;
      this.agent.systemPrompt = this.buildPrompt({
        model,
        tools: [...this.toolRegistry.schemas()] as AgentTool[],
        cwd: this.cwd,
        date: new Date(),
      });
    }

    const historyLength = this.agent.messages.length;
    yield* this.agent.prompt(input);

    // Persist new messages
    for (let i = historyLength; i < this.agent.messages.length; i++) {
      await this.session.appendMessage(this.agent.messages[i]!);
    }
  }

  // ── Control ──

  abort(): void {
    this.agent.abort();
  }

  // ── Model ──

  get model(): ModelConfig {
    return this.agent.model;
  }

  async switchModel(config: ModelConfig): Promise<void> {
    this.session.appendModelChange(config.provider, config.model);
    this.agent.model = config;
    this.agent.systemPrompt = this.buildPrompt({
      model: config,
      tools: [...this.toolRegistry.schemas()] as AgentTool[],
      cwd: this.cwd,
      date: new Date(),
    });
  }

  // ── Tools & Hooks ──

  registerTool(tool: AgentTool): void {
    this.toolRegistry.register(tool);
  }

  registerHook(hook: Hook): void {
    this.hookRegistry.register(hook);
  }

  // ── State ──

  get isRunning(): boolean {
    return this.agent.isRunning;
  }

  get messages(): readonly Message[] {
    return this.agent.messages;
  }

  /** Look up a registered hook by name (e.g. to set requestPermission callback). */
  getHook<T extends Hook>(name: string): T | undefined {
    return this.hookRegistry.get<T>(name);
  }
}

// ── Factory ──

export interface CreateHarnessConfig {
  readonly project: { readonly workDir: string; readonly storageDir: string };
  readonly streamFn: StreamFn;
  readonly model?: ModelConfig;
  readonly systemPrompt?: string | SystemPromptBuilder;
  readonly cwd?: string;
}

/** Assemble a harness with built-in hooks, tools, and defaults. */
export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  const cwd = config.cwd ?? process.cwd();

  const { createHookRegistry } = await import("./hooks/factory.js");
  const { createToolRegistry } = await import("./tools/factory.js");

  const hookRegistry = createHookRegistry(cwd);
  const toolRegistry = createToolRegistry(cwd, hookRegistry);

  const { createSessionStore } = await import("./session/session-repo.js");
  const store = await createSessionStore(config.project.storageDir);

  const model = config.model ?? detectModel();

  const promptBuilder: SystemPromptBuilder =
    typeof config.systemPrompt === "function"
      ? config.systemPrompt
      : config.systemPrompt !== undefined
        ? defaultSystemPrompt(config.systemPrompt)
        : defaultSystemPrompt(CODING_SYSTEM_PROMPT);

  return new AgentHarness({
    session: store.session,
    model,
    streamFn: config.streamFn,
    tools: toolRegistry.all(),
    hooks: [...hookRegistry.values()],
    systemPrompt: promptBuilder,
    cwd,
  });
}
