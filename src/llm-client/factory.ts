import {
  mergeOptions,
  type AdapterConfig,
  type LLMCallOptions,
  type LLMClient,
  type LLMOptions,
  type ResolvedLLMOptions,
} from "./client.js";
import {
  LLMConfigurationError,
  LLMProviderError,
} from "./errors.js";
import type {
  LLMResponse,
  Message,
  ProviderName,
  ToolSchema,
} from "./models.js";

const PROVIDERS = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  gemini: { apiKey: "GEMINI_API_KEY", baseUrl: "GEMINI_BASE_URL" },
} as const;

export interface CreateLLMClientOptions extends LLMOptions {
  readonly provider?: ProviderName;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string | null;
}

export type LLMEnvironment = Readonly<Record<string, string | undefined>>;
export type AdapterLoader = (config: AdapterConfig) => Promise<LLMClient>;
export type AdapterLoaders = Readonly<Record<ProviderName, AdapterLoader>>;

const DEFAULT_LOADERS: AdapterLoaders = {
  anthropic: async (config) =>
    (await import("./adapters/anthropic.js")).createAnthropicAdapter(config),
  openai: async (config) =>
    (await import("./adapters/openai.js")).createOpenAIAdapter(config),
  gemini: async (config) =>
    (await import("./adapters/gemini.js")).createGeminiAdapter(config),
};

function detectProvider(environment: LLMEnvironment): ProviderName {
  const detected = (Object.entries(PROVIDERS) as [
    ProviderName,
    (typeof PROVIDERS)[ProviderName],
  ][])
    .filter(([, variables]) => Boolean(environment[variables.apiKey]))
    .map(([provider]) => provider);

  if (detected.length === 0) {
    const accepted = Object.values(PROVIDERS)
      .map((variables) => variables.apiKey)
      .join(", ");
    throw new LLMConfigurationError(
      `No LLM provider configured; set exactly one of: ${accepted}`,
    );
  }
  if (detected.length > 1) {
    throw new LLMConfigurationError(
      `Multiple LLM providers configured: ${detected.join(", ")}`,
    );
  }
  return detected[0]!;
}

function selectProvider(
  provider: unknown,
  environment: LLMEnvironment,
): ProviderName {
  if (provider === undefined) return detectProvider(environment);
  if (typeof provider !== "string") {
    throw new LLMConfigurationError(
      `Unsupported LLM provider: ${String(provider)}`,
    );
  }
  const selected = provider.toLowerCase();
  if (!(selected in PROVIDERS)) {
    throw new LLMConfigurationError(`Unsupported LLM provider: ${selected}`);
  }
  return selected as ProviderName;
}

class LazyLLMClient implements LLMClient {
  private clientPromise: Promise<LLMClient> | undefined;

  constructor(
    private readonly provider: ProviderName,
    private readonly config: AdapterConfig,
    private readonly loader: AdapterLoader,
  ) {}

  private getClient(): Promise<LLMClient> {
    this.clientPromise ??= this.loader(this.config).catch((error: unknown) => {
      throw new LLMProviderError(
        `Failed to load ${this.provider} adapter: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    });
    return this.clientPromise;
  }

  async invoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return (await this.getClient()).invoke(messages, options);
  }

  async invokeWithTools(
    messages: readonly Message[],
    tools: readonly ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    return (await this.getClient()).invokeWithTools(messages, tools, options);
  }

  async *streamInvoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): AsyncIterable<string> {
    const client = await this.getClient();
    yield* client.streamInvoke(messages, options);
  }
}

export function createLLMClient(
  options: CreateLLMClientOptions = {},
  environment: LLMEnvironment = process.env,
  loaders: AdapterLoaders = DEFAULT_LOADERS,
): LLMClient {
  const {
    provider,
    model,
    apiKey,
    baseUrl,
    ...commonOptions
  } = options;
  const selected = selectProvider(provider, environment);
  const variables = PROVIDERS[selected];
  const resolvedModel = model || environment.MODEL_ID;
  const resolvedApiKey = apiKey || environment[variables.apiKey];
  const resolvedBaseUrl =
    baseUrl === undefined
      ? environment[variables.baseUrl] || null
      : baseUrl || null;

  if (!resolvedModel) {
    throw new LLMConfigurationError("Missing model; pass model or set MODEL_ID");
  }
  if (!resolvedApiKey) {
    throw new LLMConfigurationError(
      `Missing API key; pass apiKey or set ${variables.apiKey}`,
    );
  }

  const defaultOptions: ResolvedLLMOptions = mergeOptions(commonOptions);
  return new LazyLLMClient(
    selected,
    {
      model: resolvedModel,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      defaultOptions,
    },
    loaders[selected],
  );
}
