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
  readonly timeout: number;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface LLMConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly options: LLMOptions;
}

export interface LLMClient {
  invoke(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;

  stream(
    messages: readonly Message[],
    tools?: readonly ToolSchema[],
    options?: Partial<LLMOptions>,
  ): AsyncIterable<LLMStreamEvent>;
}

export function mergeOptions(
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
  try {
    timeoutMilliseconds(merged.timeout);
  } catch (error) {
    throw new Error("timeout exceeds the Node timer range", { cause: error });
  }
  if (!Number.isInteger(merged.maxTokens) || merged.maxTokens <= 0) {
    throw new Error("maxTokens must be a positive integer");
  }

  return merged;
}
