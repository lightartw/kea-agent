import { Agent } from "../agent/agent.js";
import type { AgentEvent } from "../agent/types.js";
import type { AgentTool } from "../agent/tools/types.js";
import { AgentToolRegistry } from "../agent/tools/registry.js";
import type { AgentLoopConfig } from "../agent/types.js";
import { HookRegistry } from "./hooks/registry.js";
import type { Hook } from "./hooks/types.js";
import type { Message, ModelConfig, StreamFn } from "../ai/types.js";
import { Session } from "./session/session.js";
import {
  CODING_SYSTEM_PROMPT,
  defaultSystemPrompt,
  type SystemPromptBuilder,
} from "./system-prompt.js";

export interface HarnessConfig {
  readonly session: Session;
  readonly model: ModelConfig;
  readonly streamFn: StreamFn;
  readonly toolRegistry: AgentToolRegistry;
  readonly hookRegistry: HookRegistry;
  readonly systemPrompt?: SystemPromptBuilder;
  readonly cwd?: string;
}

/** Bridge HookRegistry to AgentLoopConfig for the agent loop. */
function registryToLoopConfig(registry: HookRegistry): AgentLoopConfig {
  return {
    onUserPrompt: async (prompt) => {
      const r = await registry.trigger({ type: "user_prompt_submit", prompt });
      if (r?.block) return { block: true, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
      return undefined;
    },
    onPreTurn: async () => {
      const r = await registry.trigger({ type: "pre_turn" });
      if (r?.context) return { context: r.context };
      return undefined;
    },
    onBeforeTool: async (call) => {
      const r = await registry.trigger({ type: "pre_tool_use", call });
      if (r?.block) return { block: true, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
      return undefined;
    },
    onAfterTool: async (call, result) => {
      await registry.trigger({ type: "post_tool_use", call, result });
    },
    onStop: async (messages) => {
      const r = await registry.trigger({ type: "stop", messages });
      return r as { messages?: readonly import("../ai/types.js").Message[]; forceContinue?: string } | undefined;
    },
  };
}

export class AgentHarness {
  private readonly buildPrompt: SystemPromptBuilder;
  private readonly cwd: string;
  private readonly _toolRegistry: AgentToolRegistry;
  private readonly _hookRegistry: HookRegistry;

  private agent: Agent;
  private session: Session;

  constructor(config: HarnessConfig) {
    this.cwd = config.cwd ?? process.cwd();
    this.buildPrompt = config.systemPrompt ?? (() => "");
    this._toolRegistry = config.toolRegistry;
    this._hookRegistry = config.hookRegistry;

    const { messages, model } = config.session.buildContext();
    const initialModel = model ?? config.model;
    const systemPrompt = this.buildPrompt({
      model: initialModel,
      tools: [...config.toolRegistry.all()],
      cwd: this.cwd,
      date: new Date(),
    });

    this.session = config.session;
    this.agent = new Agent(
      config.streamFn,
      initialModel,
      config.toolRegistry,
      messages,
      systemPrompt,
      registryToLoopConfig(config.hookRegistry),
    );
  }

  // ── Core ──

  async *prompt(input: string): AsyncIterable<AgentEvent> {
    const { model } = this.session.buildContext();
    if (model !== null) {
      this.agent.model = model;
      this.agent.systemPrompt = this.buildPrompt({
        model,
        tools: [...this._toolRegistry.all()],
        cwd: this.cwd,
        date: new Date(),
      });
    }

    const before = this.agent.messages.length;
    yield* this.agent.prompt(input);

    // Batch write new messages
    for (let i = before; i < this.agent.messages.length; i++) {
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
      tools: [...this._toolRegistry.all()],
      cwd: this.cwd,
      date: new Date(),
    });
  }

  // ── Tools & Hooks ──

  registerTool(tool: AgentTool): void {
    this._toolRegistry.register(tool);
  }

  registerHook(hook: Hook): void {
    this._hookRegistry.register(hook);
  }

  // ── State ──

  get isRunning(): boolean {
    return this.agent.isRunning;
  }

  get messages(): readonly Message[] {
    return this.agent.messages;
  }

  getHook<T extends Hook>(name: string): T | undefined {
    return this._hookRegistry.get<T>(name);
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

export async function createHarness(
  config: CreateHarnessConfig,
): Promise<AgentHarness> {
  const cwd = config.cwd ?? process.cwd();

  const { createHookRegistry } = await import("./hooks/factory.js");
  const { createToolRegistry } = await import("./tools/factory.js");

  const hookRegistry = createHookRegistry(cwd);
  const toolRegistry = createToolRegistry(cwd);

  const session = await Session.create(config.project.storageDir);

  const model = config.model;
  if (model === undefined) throw new Error("model is required");

  const promptBuilder: SystemPromptBuilder =
    typeof config.systemPrompt === "function"
      ? config.systemPrompt
      : config.systemPrompt !== undefined
        ? defaultSystemPrompt(config.systemPrompt)
        : defaultSystemPrompt(CODING_SYSTEM_PROMPT);

  return new AgentHarness({
    session,
    model,
    streamFn: config.streamFn,
    toolRegistry,
    hookRegistry,
    systemPrompt: promptBuilder,
    cwd,
  });
}
