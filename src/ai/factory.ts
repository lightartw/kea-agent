import type { AnthropicAdapter } from "./adapters/anthropic.js";
import type { GeminiAdapter } from "./adapters/gemini.js";
import type { OpenAIAdapter } from "./adapters/openai.js";
import type { AssistantMessageEvent, Context, ModelConfig, StreamFn, StreamOptions } from "./types.js";

interface Adapter {
  stream(model: string, context: Context, options?: Partial<StreamOptions>): AsyncIterable<AssistantMessageEvent>;
}

// ── Model detection ──

/** Auto-detect the default model from environment variables. */
export function detectModel(env?: Environment): ModelConfig {
  const e = env ?? process.env;
  const providers = [
    { provider: "anthropic", key: "ANTHROPIC_API_KEY" },
    { provider: "openai", key: "OPENAI_API_KEY" },
    { provider: "gemini", key: "GEMINI_API_KEY" },
  ] as const;
  const configured = providers.filter((p) => e[p.key]);
  if (configured.length === 0)
    throw new Error("No LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY");
  if (configured.length > 1)
    throw new Error(`Multiple LLM providers configured: ${configured.map((p) => p.provider).join(", ")}`);
  const model = e["MODEL_ID"];
  if (!model) throw new Error("Missing model; set MODEL_ID");
  return { provider: configured[0]!.provider, model };
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
): StreamFn {
  const env = options?.env ?? process.env;
  const allProviders = [...BUILTIN_PROVIDERS, ...(options?.providers ?? [])];

  // Resolve active providers (those with configured API keys)
  const configs = new Map<string, { createAdapter: ProviderConfig["createAdapter"]; apiKey: string; baseUrl?: string | null }>();
  for (const p of allProviders) {
    const apiKey = env[p.envApiKey];
    if (apiKey) {
      const baseUrl = env[p.envBaseUrl ?? ""] ?? p.defaultBaseUrl ?? null;
      configs.set(p.id, { createAdapter: p.createAdapter, apiKey, baseUrl });
    }
  }

  // Lazy adapter pool
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

  return async function* stream(
    model: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<AssistantMessageEvent> {
    const adapter = getAdapter(model.provider);
    yield* adapter.stream(model.model, context, options);
  };
}
