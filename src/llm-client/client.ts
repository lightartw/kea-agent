import { LLMConfigurationError } from "./errors.js";
import type { LLMResponse, Message, ToolSchema } from "./models.js";
import { timeoutMilliseconds } from "../utils/abort-signals.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TOKENS = 8_000;
const OPTION_NAMES = [
  "timeout",
  "maxTokens",
  "temperature",
  "topP",
  "stop",
] as const;
const CALL_OPTION_NAMES = [...OPTION_NAMES, "signal"] as const;

export interface LLMOptions {
  readonly timeout?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
}

export interface LLMCallOptions extends LLMOptions {
  readonly signal?: AbortSignal;
}

export interface ResolvedLLMOptions extends LLMOptions {
  readonly timeout: number;
  readonly maxTokens: number;
}

export interface ResolvedLLMCallOptions extends ResolvedLLMOptions {
  readonly signal?: AbortSignal;
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
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  invokeWithTools(
    messages: readonly Message[],
    tools: readonly ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  streamInvoke(
    messages: readonly Message[],
    options?: LLMCallOptions,
  ): AsyncIterable<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  options: object,
  allowedNames: readonly string[],
): void {
  const allowed = new Set(allowedNames);
  const unknown = Object.keys(options).filter((name) => !allowed.has(name)).sort();
  if (unknown[0] !== undefined) {
    throw new LLMConfigurationError(`Unknown LLM option: ${unknown[0]}`);
  }
}

export function mergeOptions(
  clientOptions: LLMOptions,
  callOptions: LLMCallOptions = {},
): ResolvedLLMCallOptions {
  rejectUnknownKeys(clientOptions, OPTION_NAMES);
  rejectUnknownKeys(callOptions, CALL_OPTION_NAMES);

  const merged = {
    timeout: DEFAULT_TIMEOUT_SECONDS,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...clientOptions,
    ...callOptions,
  };

  if (
    typeof merged.timeout !== "number" ||
    !Number.isFinite(merged.timeout) ||
    merged.timeout <= 0
  ) {
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

  for (const name of ["temperature", "topP"] as const) {
    const value = merged[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new LLMConfigurationError(`${name} must be a finite number`);
    }
  }

  if (
    merged.stop !== undefined &&
    (!Array.isArray(merged.stop) ||
      !merged.stop.every((item: unknown) => typeof item === "string"))
  ) {
    throw new LLMConfigurationError("stop must be an array of strings");
  }

  const resolved: {
    timeout: number;
    maxTokens: number;
    temperature?: number;
    topP?: number;
    stop?: readonly string[];
    signal?: AbortSignal;
  } = {
    timeout: merged.timeout,
    maxTokens: merged.maxTokens,
  };
  if (merged.temperature !== undefined) resolved.temperature = merged.temperature;
  if (merged.topP !== undefined) resolved.topP = merged.topP;
  if (merged.stop !== undefined) resolved.stop = merged.stop;
  if (merged.signal !== undefined) resolved.signal = merged.signal;
  return resolved;
}

export function validateMessages(messages: readonly Message[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LLMConfigurationError("messages must be a non-empty array");
  }

  for (const [index, rawMessage] of messages.entries()) {
    if (!isRecord(rawMessage)) {
      throw new LLMConfigurationError(`messages[${index}] must be an object`);
    }

    const role = rawMessage.role;
    if (!new Set(["system", "user", "assistant", "tool"]).has(String(role))) {
      throw new LLMConfigurationError(`Unsupported message role: ${String(role)}`);
    }

    if (role === "assistant" && "toolCalls" in rawMessage) {
      const calls = rawMessage.toolCalls;
      if (!Array.isArray(calls)) {
        throw new LLMConfigurationError("assistant toolCalls must be an array");
      }
      for (const call of calls) {
        if (
          !isRecord(call) ||
          !("id" in call) ||
          !("name" in call) ||
          !("arguments" in call)
        ) {
          throw new LLMConfigurationError("Invalid assistant tool call");
        }
        if (!isRecord(call.arguments)) {
          throw new LLMConfigurationError("Tool call arguments must be an object");
        }
      }
    } else if (role === "tool") {
      if (
        !("toolCallId" in rawMessage) ||
        !("name" in rawMessage) ||
        !("content" in rawMessage)
      ) {
        throw new LLMConfigurationError("Invalid tool result message");
      }
    } else if (typeof rawMessage.content !== "string") {
      throw new LLMConfigurationError(`${role} message content must be a string`);
    }
  }
}

export function validateTools(tools: readonly ToolSchema[]): void {
  if (!Array.isArray(tools)) {
    throw new LLMConfigurationError("tools must be an array");
  }

  for (const [index, rawTool] of tools.entries()) {
    if (!isRecord(rawTool) || rawTool.type !== "function") {
      throw new LLMConfigurationError(`tools[${index}].type must be function`);
    }
    const fn = rawTool.function;
    if (!isRecord(fn) || typeof fn.name !== "string") {
      throw new LLMConfigurationError(`tools[${index}].function.name is required`);
    }
    const parameters = fn.parameters;
    if (!isRecord(parameters) || parameters.type !== "object") {
      throw new LLMConfigurationError("parameters.type must be object");
    }
  }
}
