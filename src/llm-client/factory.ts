import {
  mergeOptions,
  type AdapterConfig,
  type LLMClient,
  type LLMOptions,
} from "./client.js";
import { LLMConfigurationError } from "./errors.js";
import type { ProviderName } from "./models.js";

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

function resolveConfig(
  options: CreateLLMClientOptions,
  environment: LLMEnvironment,
): { readonly provider: ProviderName; readonly config: AdapterConfig } {
  const { provider, model, apiKey, baseUrl, ...commonOptions } = options;
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

  return {
    provider: selected,
    config: {
      model: resolvedModel,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      defaultOptions: mergeOptions(commonOptions),
    },
  };
}

export async function createLLMClient(
  options: CreateLLMClientOptions = {},
  environment: LLMEnvironment = process.env,
): Promise<LLMClient> {
  const { provider, config } = resolveConfig(options, environment);
  switch (provider) {
    case "anthropic":
      return (await import("./adapters/anthropic.js")).createAnthropicAdapter(config);
    case "openai":
      return (await import("./adapters/openai.js")).createOpenAIAdapter(config);
    case "gemini":
      return (await import("./adapters/gemini.js")).createGeminiAdapter(config);
  }
}
