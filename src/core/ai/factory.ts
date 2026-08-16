import type {
  Context,
  ModelConfig,
  ModelRuntime,
  StreamChunk,
  StreamOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 120;
const DEFAULT_MAX_TOKENS = 8000;

// ── Resolved options ──

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

// ── Adapter ──

export interface Adapter {
  stream(model: string, context: Context, options: ResolvedOptions): AsyncIterable<StreamChunk>;
}

// ── Lazy loading ──

/**
 * Return an Adapter immediately (sync) whose stream() lazily loads the real
 * adapter in the background and forwards events. Matches Pi's lazyApi pattern.
 */
export function lazyAdapter(load: () => Promise<Adapter>): Adapter {
  let loaded: Promise<Adapter> | undefined;
  const getAdapter = (): Promise<Adapter> => {
    loaded ??= load();
    return loaded;
  };

  return {
    async *stream(model, context, options) {
      const adapter = await getAdapter();
      yield* adapter.stream(model, context, options);
    },
  };
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
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { AnthropicAdapter } = await import("./adapters/anthropic.js");
        return new AnthropicAdapter(apiKey, baseUrl);
      }),
  },
  {
    id: "openai",
    envApiKey: "OPENAI_API_KEY",
    envBaseUrl: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { OpenAIAdapter } = await import("./adapters/openai.js");
        return new OpenAIAdapter(apiKey, baseUrl);
      }),
  },
  {
    id: "gemini",
    envApiKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    createAdapter: (apiKey, baseUrl) =>
      lazyAdapter(async () => {
        const { GeminiAdapter } = await import("./adapters/gemini.js");
        return new GeminiAdapter(apiKey, baseUrl);
      }),
  },
];

// ── Model runtime factory ──

export type Environment = Readonly<Record<string, string | undefined>>;

export function createModelRuntime(
  options?: { providers?: ProviderConfig[]; env?: Environment },
): { runtime: ModelRuntime; modelConfig: ModelConfig } {
  const env = options?.env ?? process.env;
  const allProviders = [...BUILTIN_PROVIDERS, ...(options?.providers ?? [])];

  const configured = allProviders.filter((p) => env[p.envApiKey]);
  if (configured.length === 0)
    throw new Error("No LLM provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY");

  const requestedDefault = env["DEFAULT_PROVIDER"];
  if (requestedDefault === undefined && configured.length > 1)
    throw new Error("Multiple LLM providers configured; set DEFAULT_PROVIDER");
  const defaultProvider = requestedDefault ?? configured[0]!.id;
  if (!configured.some((provider) => provider.id === defaultProvider))
    throw new Error(`DEFAULT_PROVIDER '${defaultProvider}' is not configured`);

  const modelId = env["MODEL_ID"];
  if (!modelId) throw new Error("Missing model; set MODEL_ID");

  // Eagerly create lazy adapters (module import is deferred to first stream call)
  const adapters = new Map<string, Adapter>();
  for (const p of configured) {
    const apiKey = env[p.envApiKey]!;
    const baseUrl = env[p.envBaseUrl ?? ""] ?? p.defaultBaseUrl ?? null;
    adapters.set(p.id, p.createAdapter(apiKey, baseUrl));
  }

  function getAdapter(provider: string): Adapter {
    const adapter = adapters.get(provider);
    if (!adapter) throw new Error(`Unknown provider: ${provider}`);
    return adapter;
  }

  const stream = async function* (
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk> {
    const adapter = getAdapter(modelConfig.provider);
    yield* adapter.stream(modelConfig.model, context, resolveOptions(options));
  };

  const runtime: ModelRuntime = {
    stream,
    async complete(modelConfig, context, options) {
      for await (const event of stream(modelConfig, context, options)) {
        if (event.type === "done" || event.type === "error") {
          return event.message;
        }
      }
      throw new Error(
        "Model stream ended without a done or error terminal chunk",
      );
    },
  };

  return {
    runtime,
    modelConfig: { provider: defaultProvider, model: modelId },
  };
}
