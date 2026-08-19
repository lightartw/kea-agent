import type { ProtocolId } from "../../core/ai/index.js";
import { CREDENTIAL_KEYS, PROTOCOLS } from "./defaults.js";

/** An error from one named configuration source, with its field path. */
export class ConfigurationError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly fieldPath: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `${sourcePath}${fieldPath === undefined ? "" : `: ${fieldPath}`}: ${message}`,
      options,
    );
    this.name = "ConfigurationError";
  }
}

/** "anthropic", "openai" or "gemini" — the last item is separated by "or". */
export function formatProtocols(): string {
  const quoted = PROTOCOLS.map((protocol) => `"${protocol}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1] ?? ""}`;
}

/** One ordinary config.json source: all fields optional, already validated. */
export interface ParsedOrdinary {
  defaultModel?: { readonly provider: string; readonly model: string };
  providers?: Readonly<Record<string, ProviderFields>>;
  agent?: { maxTurns?: number };
  tools?: { timeoutSeconds?: number };
  ui?: { thinking?: "hidden" | "visible"; toolDetails?: "compact" | "full" };
}

export interface ProviderFields {
  readonly protocol?: ProtocolId;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
}

function parseOrdinarySource(path: string, value: unknown): ParsedOrdinary {
  assertObject(path, undefined, value);
  rejectCredentials(path, undefined, value);
  assertOnlyKeys(path, undefined, value, [
    "defaultModel",
    "providers",
    "agent",
    "tools",
    "ui",
  ]);

  const parsed: ParsedOrdinary = {};

  const defaultModel = value["defaultModel"];
  if (defaultModel !== undefined) {
    const dmPath = "defaultModel";
    assertObject(path, dmPath, defaultModel);
    rejectCredentials(path, dmPath, defaultModel);
    rejectUnknownFields(path, dmPath, defaultModel, ["provider", "model"]);
    const provider = defaultModel["provider"];
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new ConfigurationError(
        path,
        `${dmPath}.provider`,
        "must be a non-empty string",
      );
    }
    const model = defaultModel["model"];
    if (typeof model !== "string" || model.trim() === "") {
      throw new ConfigurationError(
        path,
        `${dmPath}.model`,
        "must be a non-empty string",
      );
    }
    parsed.defaultModel = { provider, model };
  }

  const providers = value["providers"];
  if (providers !== undefined) {
    assertObject(path, "providers", providers);
    rejectCredentials(path, "providers", providers);
    const fields: Record<string, ProviderFields> = {};
    for (const name of Object.keys(providers)) {
      if (name.trim() === "") {
        throw new ConfigurationError(
          path,
          `providers.${name}`,
          "provider name must be non-empty",
        );
      }
      const entry = providers[name];
      const providerPath = `providers.${name}`;
      assertObject(path, providerPath, entry);
      rejectCredentials(path, providerPath, entry);
      rejectUnknownFields(path, providerPath, entry, ["protocol", "baseUrl", "models"]);
      const protocol = entry["protocol"];
      if (protocol !== undefined) {
        if (
          typeof protocol !== "string"
          || !PROTOCOLS.includes(protocol as ProtocolId)
        ) {
          throw new ConfigurationError(
            path,
            `${providerPath}.protocol`,
            `expected ${formatProtocols()}`,
          );
        }
      }
      const baseUrl = entry["baseUrl"];
      if (baseUrl !== undefined) {
        assertAbsoluteHttpUrl(path, `${providerPath}.baseUrl`, baseUrl);
      }
      const models = entry["models"];
      if (models !== undefined) {
        assertModels(path, `${providerPath}.models`, models);
      }
      fields[name] = {
        ...(protocol === undefined ? {} : { protocol: protocol as ProtocolId }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(models === undefined ? {} : { models }),
      };
    }
    parsed.providers = fields;
  }

  const agent = value["agent"];
  if (agent !== undefined) {
    const agentPath = "agent";
    assertObject(path, agentPath, agent);
    rejectCredentials(path, agentPath, agent);
    assertOnlyKeys(path, agentPath, agent, ["maxTurns"]);
    const maxTurns = agent["maxTurns"];
    if (maxTurns !== undefined) {
      if (
        typeof maxTurns !== "number"
        || !Number.isInteger(maxTurns)
        || maxTurns < 1
        || maxTurns > 1000
      ) {
        throw new ConfigurationError(
          path,
          `${agentPath}.maxTurns`,
          "expected an integer from 1 to 1000",
        );
      }
      parsed.agent = { maxTurns };
    }
  }

  const tools = value["tools"];
  if (tools !== undefined) {
    const toolsPath = "tools";
    assertObject(path, toolsPath, tools);
    rejectCredentials(path, toolsPath, tools);
    assertOnlyKeys(path, toolsPath, tools, ["timeoutSeconds"]);
    const timeoutSeconds = tools["timeoutSeconds"];
    if (timeoutSeconds !== undefined) {
      if (
        typeof timeoutSeconds !== "number"
        || !Number.isFinite(timeoutSeconds)
        || timeoutSeconds <= 0
        || timeoutSeconds > 3600
      ) {
        throw new ConfigurationError(
          path,
          `${toolsPath}.timeoutSeconds`,
          "expected a finite number from 1 to 3600",
        );
      }
      parsed.tools = { timeoutSeconds };
    }
  }

  const ui = value["ui"];
  if (ui !== undefined) {
    const uiPath = "ui";
    assertObject(path, uiPath, ui);
    rejectCredentials(path, uiPath, ui);
    assertOnlyKeys(path, uiPath, ui, ["thinking", "toolDetails"]);
    const thinking = ui["thinking"];
    if (thinking !== undefined) {
      assertEnum(path, `${uiPath}.thinking`, thinking, ["hidden", "visible"]);
    }
    const toolDetails = ui["toolDetails"];
    if (toolDetails !== undefined) {
      assertEnum(path, `${uiPath}.toolDetails`, toolDetails, ["compact", "full"]);
    }
    parsed.ui = {
      ...(thinking === undefined ? {} : { thinking: thinking as "hidden" | "visible" }),
      ...(toolDetails === undefined ? {} : { toolDetails: toolDetails as "compact" | "full" }),
    };
  }

  return parsed;
}

/** The auth file: provider names to API keys, possibly empty until filled in. */
function parseAuth(
  path: string,
  value: unknown,
): Readonly<Record<string, string>> {
  assertObject(path, undefined, value);
  assertOnlyKeys(path, undefined, value, ["providers"]);
  const providers = value["providers"];
  if (providers === undefined) return {};
  assertObject(path, "providers", providers);
  const result: Record<string, string> = {};
  for (const name of Object.keys(providers)) {
    const entry = providers[name];
    const keyPath = `providers.${name}.apiKey`;
    assertObject(path, `providers.${name}`, entry);
    assertOnlyKeys(path, `providers.${name}`, entry, ["apiKey"]);
    const apiKey = entry["apiKey"];
    if (typeof apiKey !== "string") {
      throw new ConfigurationError(path, keyPath, "expected a string");
    }
    result[name] = apiKey;
  }
  return result;
}

function assertObject(
  path: string,
  fieldPath: string | undefined,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(path, fieldPath, "expected a JSON object");
  }
}

function rejectCredentials(
  path: string,
  fieldPath: string | undefined,
  value: Record<string, unknown>,
): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEYS.has(key)) {
      throw new ConfigurationError(
        path,
        fieldPath === undefined ? key : `${fieldPath}.${key}`,
        "credentials are only allowed in ~/.kea/auth.json",
      );
    }
  }
}

function assertOnlyKeys(
  path: string,
  fieldPath: string | undefined,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigurationError(
        path,
        fieldPath === undefined ? key : `${fieldPath}.${key}`,
        "unknown field",
      );
    }
  }
}

/** Like assertOnlyKeys but reports the container path, not the offending key. */
function rejectUnknownFields(
  path: string,
  fieldPath: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigurationError(path, fieldPath, `unknown field: ${key}`);
    }
  }
}

function assertEnum(
  path: string,
  fieldPath: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigurationError(
      path,
      fieldPath,
      `expected ${allowed.map((v) => `"${v}"`).join(" or ")}`,
    );
  }
}

function assertAbsoluteHttpUrl(
  path: string,
  fieldPath: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string") {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(path, fieldPath, "expected an absolute http(s) URL");
  }
}

function assertModels(
  path: string,
  fieldPath: string,
  value: unknown,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError(
      path,
      fieldPath,
      "must be a non-empty array of strings",
    );
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigurationError(
        path,
        fieldPath,
        "must be a non-empty array of strings",
      );
    }
    if (seen.has(item)) {
      throw new ConfigurationError(path, fieldPath, `duplicate model: ${item}`);
    }
    seen.add(item);
  }
}

export {
  parseOrdinarySource,
  parseAuth,
};
