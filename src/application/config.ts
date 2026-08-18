import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelConfig } from "../core/ai/types.js";
import type { ProtocolId, RuntimeProviderConfig } from "../core/ai/index.js";

const PROTOCOLS: readonly ProtocolId[] = ["anthropic", "openai", "gemini"];
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "token",
  "secret",
  "password",
]);

/** "anthropic", "openai" or "gemini" — the last item is separated by "or". */
function formatProtocols(): string {
  const quoted = PROTOCOLS.map((protocol) => `"${protocol}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1] ?? ""}`;
}

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

// ── Per-source parsing (validated before any merge) ──

/** One ordinary config.json source: all fields optional, already validated. */
interface ParsedOrdinary {
  defaultModel?: { readonly provider: string; readonly model: string };
  providers?: Readonly<Record<string, ProviderFields>>;
  agent?: { maxTurns?: number };
  tools?: { timeoutSeconds?: number };
  ui?: { thinking?: "hidden" | "visible"; toolDetails?: "compact" | "full" };
}

interface ProviderFields {
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

// ── File reading ──

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigurationError(path, undefined, "cannot read file", { cause: error });
  }
  return parseJson(path, raw);
}

async function readRequiredJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(path, undefined, "file not found", { cause: error });
  }
  return parseJson(path, raw);
}

function parseJson(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(path, undefined, `invalid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

// ── Merging ──

/** The merged ordinary value: defaults are always present. */
interface ResolvedOrdinary {
  readonly defaultModel?: { readonly provider: string; readonly model: string };
  readonly providers: Readonly<Record<string, ProviderFields>>;
  readonly agent: { readonly maxTurns: number };
  readonly tools: { readonly timeoutSeconds: number };
  readonly ui: {
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
  };
}

function mergeOrdinary(base: ResolvedOrdinary, next: ParsedOrdinary): ResolvedOrdinary {
  const providers: Record<string, ProviderFields> = {};
  for (const name of Object.keys(base.providers)) {
    providers[name] = { ...base.providers[name], ...(next.providers?.[name] ?? {}) };
  }
  for (const name of Object.keys(next.providers ?? {})) {
    if (!(name in providers)) providers[name] = next.providers![name]!;
  }
  return {
    ...(next.defaultModel !== undefined
      ? { defaultModel: next.defaultModel }
      : base.defaultModel !== undefined
        ? { defaultModel: base.defaultModel }
        : {}),
    providers,
    agent: { maxTurns: next.agent?.maxTurns ?? base.agent.maxTurns },
    tools: { timeoutSeconds: next.tools?.timeoutSeconds ?? base.tools.timeoutSeconds },
    ui: {
      thinking: next.ui?.thinking ?? base.ui.thinking,
      toolDetails: next.ui?.toolDetails ?? base.ui.toolDetails,
    },
  };
}

// ── Cross-field validation and Config construction ──

interface ResolvedProvider {
  readonly protocol: ProtocolId;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly models: readonly string[];
}

function resolveProviders(
  merged: ResolvedOrdinary,
  mergedSourcePath: string,
  auth: Readonly<Record<string, string>> | undefined,
  authPath: string,
): {
  readonly defaultModel: { readonly provider: string; readonly model: string };
  readonly providers: ReadonlyMap<string, ResolvedProvider>;
} {
  const configured = Object.keys(merged.providers);
  if (configured.length === 0) {
    throw new ConfigurationError(mergedSourcePath, "providers", "at least one provider must be configured");
  }

  for (const name of configured) {
    const entry = merged.providers[name]!;
    const protocol = entry.protocol;
    if (protocol === undefined || !PROTOCOLS.includes(protocol)) {
      throw new ConfigurationError(
        mergedSourcePath,
        `providers.${name}.protocol`,
        `expected ${formatProtocols()}`,
      );
    }
    if (entry.models === undefined || entry.models.length === 0) {
      throw new ConfigurationError(
        mergedSourcePath,
        `providers.${name}.models`,
        "must be a non-empty array of strings",
      );
    }
  }

  const defaultModel = merged.defaultModel;
  if (defaultModel === undefined) {
    throw new ConfigurationError(mergedSourcePath, "defaultModel", "must be specified");
  }
  if (!Object.prototype.hasOwnProperty.call(merged.providers, defaultModel.provider)) {
    throw new ConfigurationError(
      mergedSourcePath,
      "defaultModel",
      `defaultModel must reference a configured provider: ${defaultModel.provider}`,
    );
  }
  const providerModels = merged.providers[defaultModel.provider]!.models ?? [];
  if (!providerModels.includes(defaultModel.model)) {
    throw new ConfigurationError(
      mergedSourcePath,
      "defaultModel.model",
      `model must be listed in provider "${defaultModel.provider}" models`,
    );
  }

  if (auth === undefined) {
    throw new ConfigurationError(authPath, "providers", "auth file not found");
  }

  const providers = new Map<string, ResolvedProvider>();
  for (const name of configured) {
    const apiKey = auth[name];
    if (apiKey === undefined || apiKey === "") {
      throw new ConfigurationError(authPath, `providers.${name}.apiKey`, "must be non-empty");
    }
    const entry = merged.providers[name]!;
    providers.set(name, {
      protocol: entry.protocol!,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
      apiKey,
      models: entry.models!,
    });
  }

  return { defaultModel, providers };
}

/**
 * The single application settings entity. Construction succeeds only when
 * every source is read, merged, validated, and all enabled Providers hold a
 * non-empty API Key from the auth file.
 */
export class Config {
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  readonly #providers: ReadonlyMap<string, ResolvedProvider>;
  readonly #defaultModel: { readonly provider: string; readonly model: string };

  private constructor(options: {
    readonly maxTurns: number;
    readonly toolTimeoutSeconds: number;
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
    readonly verbose: boolean;
    readonly defaultModel: { readonly provider: string; readonly model: string };
    readonly providers: ReadonlyMap<string, ResolvedProvider>;
  }) {
    this.maxTurns = options.maxTurns;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.thinking = options.thinking;
    this.toolDetails = options.toolDetails;
    this.verbose = options.verbose;
    this.#defaultModel = options.defaultModel;
    this.#providers = options.providers;
  }

  static async load(options: {
    readonly keaHome: string;
    readonly projectDirectory: string;
    readonly configOverride?: string;
    readonly verbose: boolean;
  }): Promise<Config> {
    const userPath = join(options.keaHome, "config.json");
    const projectPath = join(options.projectDirectory, ".kea", "config.json");
    const authPath = join(options.keaHome, "auth.json");

    const defaults: ResolvedOrdinary = {
      providers: {},
      agent: { maxTurns: 20 },
      tools: { timeoutSeconds: 120 },
      ui: { thinking: "hidden", toolDetails: "compact" },
    };

    const sources: readonly { readonly path: string; readonly required: boolean }[] = [
      { path: userPath, required: false },
      { path: projectPath, required: false },
      ...(options.configOverride === undefined
        ? []
        : [{ path: options.configOverride, required: true }]),
    ];

    let merged = defaults;
    let mergedSourcePath = userPath;
    for (const source of sources) {
      const value = source.required
        ? await readRequiredJson(source.path)
        : await readOptionalJson(source.path);
      if (value === undefined) continue;
      merged = mergeOrdinary(merged, parseOrdinarySource(source.path, value));
      mergedSourcePath = source.path;
    }

    const authValue = await readOptionalJson(authPath);
    const auth = authValue === undefined ? undefined : parseAuth(authPath, authValue);

    const resolved = resolveProviders(merged, mergedSourcePath, auth, authPath);

    return new Config({
      maxTurns: merged.agent.maxTurns,
      toolTimeoutSeconds: merged.tools.timeoutSeconds,
      thinking: merged.ui.thinking,
      toolDetails: merged.ui.toolDetails,
      verbose: options.verbose,
      defaultModel: resolved.defaultModel,
      providers: resolved.providers,
    });
  }

  /** All enabled model choices in config insertion order. */
  get models(): readonly ModelConfig[] {
    const models: ModelConfig[] = [];
    for (const [provider, entry] of this.#providers) {
      for (const model of entry.models) {
        models.push({ provider, model });
      }
    }
    return models;
  }

  get defaultModel(): ModelConfig {
    return { provider: this.#defaultModel.provider, model: this.#defaultModel.model };
  }

  /** Short-lived Provider connections for ModelRuntime construction. */
  runtimeProviders(): readonly RuntimeProviderConfig[] {
    return [...this.#providers].map(([name, entry]) => ({
      name,
      protocol: entry.protocol,
      apiKey: entry.apiKey,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
    }));
  }

  /** Replace every loaded non-empty API Key with [REDACTED]. */
  redact(message: string): string {
    let redacted = message;
    for (const entry of this.#providers.values()) {
      if (entry.apiKey !== "") {
        redacted = redacted.split(entry.apiKey).join("[REDACTED]");
      }
    }
    return redacted;
  }
}
