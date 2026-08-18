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

// ── Protocol registry ──

/** Wire-protocol identifier, independent of the configured provider name. */
export type ProtocolId = "anthropic" | "openai" | "gemini";

export interface RuntimeProviderConfig {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

const BUILTIN_PROTOCOLS: readonly {
  readonly id: ProtocolId;
  readonly envApiKey: string;
  readonly envBaseUrl?: string;
  readonly defaultBaseUrl?: string;
  readonly createAdapter: (apiKey: string, baseUrl?: string | null) => Adapter;
}[] = [
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

// ── Routed runtime ──

export function createRoutedRuntime(
  adapters: ReadonlyMap<string, Adapter>,
): ModelRuntime {
  const stream = async function* (
    modelConfig: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<StreamChunk> {
    const adapter = adapters.get(modelConfig.provider);
    if (adapter === undefined) {
      throw new Error(`Unknown provider: ${modelConfig.provider}`);
    }
    yield* adapter.stream(modelConfig.model, context, resolveOptions(options));
  };

  return {
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
}

// ── Model runtime factories ──

export function createModelRuntime(options: {
  readonly providers: readonly RuntimeProviderConfig[];
}): ModelRuntime {
  if (options.providers.length === 0) {
    throw new Error("At least one provider must be configured");
  }

  const adapters = new Map<string, Adapter>();
  for (const provider of options.providers) {
    if (adapters.has(provider.name)) {
      throw new Error(`Duplicate provider: ${provider.name}`);
    }
    const builtin = BUILTIN_PROTOCOLS.find((p) => p.id === provider.protocol);
    if (builtin === undefined) {
      throw new Error(`Unknown protocol: ${provider.protocol}`);
    }
    adapters.set(
      provider.name,
      builtin.createAdapter(provider.apiKey, provider.baseUrl ?? builtin.defaultBaseUrl ?? null),
    );
  }
  return createRoutedRuntime(adapters);
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** Development/test helper: map provider keys and base URLs into explicit providers. */
export function createModelRuntimeFromEnvironment(env: Environment): ModelRuntime {
  const providers: RuntimeProviderConfig[] = [];
  for (const builtin of BUILTIN_PROTOCOLS) {
    const apiKey = env[builtin.envApiKey];
    if (apiKey === undefined || apiKey === "") continue;
    const baseUrl = builtin.envBaseUrl === undefined
      ? undefined
      : env[builtin.envBaseUrl];
    providers.push({
      name: builtin.id,
      protocol: builtin.id,
      apiKey,
      ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl }),
    });
  }
  return createModelRuntime({ providers });
}
