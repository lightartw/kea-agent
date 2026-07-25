import type { AssistantMessageEvent, Context, ModelConfig, StreamFn, StreamOptions } from "./types.js";
import { EventStream } from "./utils/event-stream.js";

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
  stream(model: string, context: Context, options: ResolvedOptions): AsyncIterable<AssistantMessageEvent>;
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
    stream(model, context, options) {
      const stream = new EventStream<AssistantMessageEvent>();
      getAdapter()
        .then(async (real) => {
          try {
            for await (const event of real.stream(model, context, resolveOptions(options))) {
              stream.push(event);
            }
          } catch (err) {
            stream.error(err);
            return;
          }
          stream.end();
        })
        .catch((err) => stream.error(err));
      return stream;
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

  const stream: StreamFn = async function* (
    model: ModelConfig,
    context: Context,
    options?: Partial<StreamOptions>,
  ): AsyncIterable<AssistantMessageEvent> {
    const adapter = getAdapter(model.provider);
    yield* adapter.stream(model.model, context, resolveOptions(options));
  };

  return { stream, defaultModel: { provider: defaultProvider, model: modelId } };
}
