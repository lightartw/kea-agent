import type { AnthropicAdapter } from "./adapters/anthropic.js";
import type { GeminiAdapter } from "./adapters/gemini.js";
import type { OpenAIAdapter } from "./adapters/openai.js";
import type { AssistantMessageEvent, Context, ModelConfig, StreamFn, StreamOptions } from "./types.js";

const DEFAULT_TIMEOUT = 120;
const DEFAULT_MAX_TOKENS = 8000;

export interface ResolvedOptions {
  timeout: number;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
  signal?: AbortSignal;
}

function resolveOptions(options?: Partial<StreamOptions>): ResolvedOptions {
  return { timeout: DEFAULT_TIMEOUT, maxTokens: DEFAULT_MAX_TOKENS, ...options };
}

export interface Adapter {
  stream(model: string, context: Context, options: ResolvedOptions): AsyncIterable<AssistantMessageEvent>;
}

// ── Provider registry ──

export interface ProviderConfig {
  readonly id: string;
  readonly envApiKey: string;
  readonly envBaseUrl?: string;
  readonly defaultBaseUrl?: string;
  readonly createAdapter: (apiKey: string, baseUrl?: string | null) => Adapter;
}

const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: "anthropic",
    envApiKey: "ANTHROPIC_API_KEY",
    envBaseUrl: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    createAdapter: (apiKey, baseUrl) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AnthropicAdapter: A } = require("./adapters/anthropic.js") as { AnthropicAdapter: typeof AnthropicAdapter };
      return new A(apiKey, baseUrl);
    },
  },
  {
    id: "openai",
    envApiKey: "OPENAI_API_KEY",
    envBaseUrl: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    createAdapter: (apiKey, baseUrl) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAIAdapter: A } = require("./adapters/openai.js") as { OpenAIAdapter: typeof OpenAIAdapter };
      return new A(apiKey, baseUrl);
    },
  },
  {
    id: "gemini",
    envApiKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    createAdapter: (apiKey, baseUrl) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GeminiAdapter: A } = require("./adapters/gemini.js") as { GeminiAdapter: typeof GeminiAdapter };
      return new A(apiKey, baseUrl);
    },
  },
];

// ── StreamFn factory ──

export type Environment = Readonly<Record<string, string | undefined>>;

export function createStreamFn(
  options?: { providers?: ProviderConfig[]; env?: Environment },
): { stream: StreamFn; defaultModel: ModelConfig } {
  const env = options?.env ?? process.env;
  const allProviders = [...BUILTIN_PROVIDERS, ...(options?.providers ?? [])];

  const configured = allProviders.filter((p) => env[p.envApiKey]);
  if (configured.length === 0)
    throw new Error("No LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY");
  if (configured.length > 1)
    throw new Error(`Multiple LLM providers configured: ${configured.map((p) => p.id).join(", ")}`);
  const modelId = env["MODEL_ID"];
  if (!modelId) throw new Error("Missing model; set MODEL_ID");

  const configs = new Map<string, { createAdapter: ProviderConfig["createAdapter"]; apiKey: string; baseUrl?: string | null }>();
  for (const p of configured) {
    const baseUrl = env[p.envBaseUrl ?? ""] ?? p.defaultBaseUrl ?? null;
    configs.set(p.id, { createAdapter: p.createAdapter, apiKey: env[p.envApiKey]!, baseUrl });
  }

  const adapters = new Map<string, Adapter>();

  function getAdapter(provider: string): Adapter {
    let adapter = adapters.get(provider);
    if (!adapter) {
      const config = configs.get(provider);
      if (!config) throw new Error(`Unknown provider: ${provider}`);
      adapter = config.createAdapter(config.apiKey, config.baseUrl);
      adapters.set(provider, adapter);
    }
    return adapter;
  }

  const stream: StreamFn = async function* (
    model: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<AssistantMessageEvent> {
    const adapter = getAdapter(model.provider);
    yield* adapter.stream(model.model, context, resolveOptions(options));
  };

  return { stream, defaultModel: { provider: configured[0]!.id, model: modelId } };
}
