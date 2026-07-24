import type { LLMClient, LLMConfig, LLMOptions } from "./types.js";
import { timeoutMilliseconds } from "../utils/timeout.js";

// ── Defaults ──

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TOKENS = 8_000;

export function resolveOptions(
  clientOptions: Partial<LLMOptions>,
  callOptions: Partial<LLMOptions> = {},
): LLMOptions {
  const merged = {
    timeout: DEFAULT_TIMEOUT_SECONDS,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...clientOptions,
    ...callOptions,
  };
  if (!Number.isFinite(merged.timeout) || merged.timeout <= 0) {
    throw new Error("timeout must be a positive finite number");
  }
  timeoutMilliseconds(merged.timeout);
  if (!Number.isInteger(merged.maxTokens) || merged.maxTokens <= 0) {
    throw new Error("maxTokens must be a positive integer");
  }
  return merged;
}

// ── Provider detection ──

type ProviderName = "anthropic" | "openai" | "gemini";

const PROVIDERS = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  gemini: { apiKey: "GEMINI_API_KEY", baseUrl: "GEMINI_BASE_URL" },
} as const;

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
    throw new Error(
      `No LLM provider configured; set exactly one of: ${accepted}`,
    );
  }
  if (detected.length > 1) {
    throw new Error(
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
    throw new Error(
      `Unsupported LLM provider: ${String(provider)}`,
    );
  }
  const selected = provider.toLowerCase();
  if (!(selected in PROVIDERS)) {
    throw new Error(`Unsupported LLM provider: ${selected}`);
  }
  return selected as ProviderName;
}

export async function createLLMClient(
  options: Partial<LLMOptions> & {
    readonly provider?: ProviderName;
    readonly model?: string;
    readonly apiKey?: string;
    readonly baseUrl?: string | null;
  } = {},
  environment: LLMEnvironment = process.env,
): Promise<LLMClient> {
  const { provider, model, apiKey, baseUrl, ...optionOverrides } = options;
  const selected = selectProvider(provider, environment);
  const variables = PROVIDERS[selected];
  const resolvedModel = model || environment.MODEL_ID;
  const resolvedApiKey = apiKey || environment[variables.apiKey];
  const resolvedBaseUrl =
    baseUrl === undefined
      ? environment[variables.baseUrl] || null
      : baseUrl || null;

  if (!resolvedModel) {
    throw new Error("Missing model; pass model or set MODEL_ID");
  }
  if (!resolvedApiKey) {
    throw new Error(
      `Missing API key; pass apiKey or set ${variables.apiKey}`,
    );
  }

  const config: LLMConfig = {
    model: resolvedModel,
    apiKey: resolvedApiKey,
    baseUrl: resolvedBaseUrl,
    options: resolveOptions(optionOverrides),
  };
  switch (selected) {
    case "anthropic": {
      const { AnthropicAdapter } = await import("./adapters/anthropic.js");
      return new AnthropicAdapter(config);
    }
    case "openai": {
      const { OpenAIAdapter } = await import("./adapters/openai.js");
      return new OpenAIAdapter(config);
    }
    case "gemini": {
      const { GeminiAdapter } = await import("./adapters/gemini.js");
      return new GeminiAdapter(config);
    }
  }
}
