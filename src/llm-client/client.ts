import { LLMConfigurationError } from "./errors.js";
import type {
  LLMResponse,
  LLMStreamEvent,
  Message,
  ToolSchema,
} from "./models.js";
import { timeoutMilliseconds } from "../utils/timeout.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TOKENS = 8_000;

export interface LLMOptions {
  readonly timeout?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface ResolvedLLMOptions extends LLMOptions {
  readonly timeout: number;
  readonly maxTokens: number;
}

export interface AdapterConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly defaultOptions: ResolvedLLMOptions;
}

export interface LLMClient {
  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): Promise<LLMResponse>;

  stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamEvent>;
}

export function mergeOptions(
  clientOptions: LLMOptions,
  callOptions: LLMOptions = {},
): ResolvedLLMOptions {
  const merged = {
    timeout: DEFAULT_TIMEOUT_SECONDS,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...clientOptions,
    ...callOptions,
  };

  if (!Number.isFinite(merged.timeout) || merged.timeout <= 0) {
    throw new LLMConfigurationError("timeout must be a positive finite number");
  }
  try {
    timeoutMilliseconds(merged.timeout);
  } catch (error) {
    throw new LLMConfigurationError("timeout exceeds the Node timer range", {
      cause: error,
    });
  }
  if (!Number.isInteger(merged.maxTokens) || merged.maxTokens <= 0) {
    throw new LLMConfigurationError("maxTokens must be a positive integer");
  }

  return merged;
}
