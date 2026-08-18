import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelConfig } from "../core/ai/types.js";
import type { ProviderId, RuntimeProviderConfig } from "../core/ai/index.js";

const BUILTIN_ORDER: readonly ProviderId[] = ["anthropic", "openai", "gemini"];
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(BUILTIN_ORDER);
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "token",
  "secret",
  "password",
]);

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
  defaultProvider?: ProviderId;
  providers?: Readonly<Partial<Record<ProviderId, ProviderFields>>>;
  agent?: { maxTurns?: number };
  tools?: { timeoutSeconds?: number };
  ui?: { thinking?: "hidden" | "visible"; toolDetails?: "compact" | "full" };
}

interface ProviderFields {
  readonly model?: string;
  readonly baseUrl?: string;
}

function parseOrdinarySource(path: string, value: unknown): ParsedOrdinary {
  assertObject(path, undefined, value);
  rejectCredentials(path, undefined, value);
  assertOnlyKeys(path, undefined, value, [
    "defaultProvider",
    "providers",
    "agent",
    "tools",
    "ui",
  ]);

  const parsed: ParsedOrdinary = {};

  const defaultProvider = value["defaultProvider"];
  if (defaultProvider !== undefined) {
    if (typeof defaultProvider !== "string" || !KNOWN_PROVIDERS.has(defaultProvider)) {
      throw new ConfigurationError(
        path,
        "defaultProvider",
        `unknown provider: ${String(defaultProvider)}`,
      );
    }
    parsed.defaultProvider = defaultProvider as ProviderId;
  }

  const providers = value["providers"];
  if (providers !== undefined) {
    assertObject(path, "providers", providers);
    rejectCredentials(path, "providers", providers);
    for (const key of Object.keys(providers)) {
      if (!KNOWN_PROVIDERS.has(key)) {
        throw new ConfigurationError(path, `providers.${key}`, `unknown provider: ${key}`);
      }
    }
    const fields: Partial<Record<ProviderId, ProviderFields>> = {};
    for (const id of BUILTIN_ORDER) {
      const entry = providers[id];
      if (entry === undefined) continue;
      const providerPath = `providers.${id}`;
      assertObject(path, providerPath, entry);
      rejectCredentials(path, providerPath, entry);
      assertOnlyKeys(path, providerPath, entry, ["model", "baseUrl"]);
      const model = entry["model"];
      if (model !== undefined && typeof model !== "string") {
        throw new ConfigurationError(path, `${providerPath}.model`, "model must be a string");
      }
      const baseUrl = entry["baseUrl"];
      if (baseUrl !== undefined) {
        assertAbsoluteHttpUrl(path, `${providerPath}.baseUrl`, baseUrl);
      }
      fields[id] = {
        ...(model === undefined ? {} : { model }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
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

/** The auth file: only provider API Keys, possibly empty until filled in. */
function parseAuth(
  path: string,
  value: unknown,
): Readonly<Partial<Record<ProviderId, string>>> {
  assertObject(path, undefined, value);
  assertOnlyKeys(path, undefined, value, ["providers"]);
  const providers = value["providers"];
  if (providers === undefined) return {};
  assertObject(path, "providers", providers);
  for (const key of Object.keys(providers)) {
    if (!KNOWN_PROVIDERS.has(key)) {
      throw new ConfigurationError(path, `providers.${key}`, `unknown provider: ${key}`);
    }
  }
  const result: Partial<Record<ProviderId, string>> = {};
  for (const id of BUILTIN_ORDER) {
    const entry = providers[id];
    if (entry === undefined) continue;
    const keyPath = `providers.${id}.apiKey`;
    assertObject(path, `providers.${id}`, entry);
    assertOnlyKeys(path, `providers.${id}`, entry, ["apiKey"]);
    const apiKey = entry["apiKey"];
    if (typeof apiKey !== "string") {
      throw new ConfigurationError(path, keyPath, "expected a string");
    }
    result[id] = apiKey;
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
  readonly defaultProvider?: ProviderId;
  readonly providers: Readonly<Partial<Record<ProviderId, ProviderFields>>>;
  readonly agent: { readonly maxTurns: number };
  readonly tools: { readonly timeoutSeconds: number };
  readonly ui: {
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
  };
}

function mergeOrdinary(base: ResolvedOrdinary, next: ParsedOrdinary): ResolvedOrdinary {
  const providers: Partial<Record<ProviderId, ProviderFields>> = {};
  for (const id of BUILTIN_ORDER) {
    const baseEntry = base.providers[id];
    const nextEntry = next.providers?.[id];
    if (baseEntry === undefined && nextEntry === undefined) continue;
    providers[id] = { ...(baseEntry ?? {}), ...(nextEntry ?? {}) };
  }
  return {
    ...(next.defaultProvider !== undefined
      ? { defaultProvider: next.defaultProvider }
      : base.defaultProvider !== undefined
        ? { defaultProvider: base.defaultProvider }
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
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
}

function resolveProviders(
  merged: ResolvedOrdinary,
  mergedSourcePath: string,
  auth: Readonly<Partial<Record<ProviderId, string>>> | undefined,
  authPath: string,
): { readonly defaultProvider: ProviderId; readonly providers: ReadonlyMap<ProviderId, ResolvedProvider> } {
  const configured = BUILTIN_ORDER.filter((id) => merged.providers[id] !== undefined);
  if (configured.length === 0) {
    throw new ConfigurationError(mergedSourcePath, "providers", "at least one provider must be configured");
  }

  for (const id of configured) {
    const model = merged.providers[id]?.model;
    if (model === undefined || model === "") {
      throw new ConfigurationError(
        mergedSourcePath,
        `providers.${id}.model`,
        "model must be a non-empty string",
      );
    }
  }

  let defaultProvider: ProviderId;
  if (merged.defaultProvider !== undefined) {
    if (!configured.includes(merged.defaultProvider)) {
      throw new ConfigurationError(
        mergedSourcePath,
        "defaultProvider",
        "defaultProvider must reference a configured provider",
      );
    }
    defaultProvider = merged.defaultProvider;
  } else if (configured.length === 1) {
    defaultProvider = configured[0]!;
  } else {
    throw new ConfigurationError(
      mergedSourcePath,
      "defaultProvider",
      "defaultProvider must be specified when multiple providers are configured",
    );
  }

  if (auth === undefined) {
    throw new ConfigurationError(authPath, "providers", "auth file not found");
  }

  const providers = new Map<ProviderId, ResolvedProvider>();
  for (const id of configured) {
    const apiKey = auth[id];
    if (apiKey === undefined || apiKey === "") {
      throw new ConfigurationError(authPath, `providers.${id}.apiKey`, "must be non-empty");
    }
    const fields = merged.providers[id]!;
    providers.set(id, {
      model: fields.model!,
      ...(fields.baseUrl === undefined ? {} : { baseUrl: fields.baseUrl }),
      apiKey,
    });
  }

  return { defaultProvider, providers };
}

/**
 * The single application settings entity. Construction succeeds only when
 * every source is read, merged, validated, and all enabled Providers hold a
 * non-empty API Key from the auth file.
 */
export class Config {
  readonly defaultProvider: ProviderId;
  readonly maxTurns: number;
  readonly toolTimeoutSeconds: number;
  readonly thinking: "hidden" | "visible";
  readonly toolDetails: "compact" | "full";
  readonly verbose: boolean;

  readonly #providers: ReadonlyMap<ProviderId, ResolvedProvider>;

  private constructor(options: {
    readonly defaultProvider: ProviderId;
    readonly maxTurns: number;
    readonly toolTimeoutSeconds: number;
    readonly thinking: "hidden" | "visible";
    readonly toolDetails: "compact" | "full";
    readonly verbose: boolean;
    readonly providers: ReadonlyMap<ProviderId, ResolvedProvider>;
  }) {
    this.defaultProvider = options.defaultProvider;
    this.maxTurns = options.maxTurns;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.thinking = options.thinking;
    this.toolDetails = options.toolDetails;
    this.verbose = options.verbose;
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
      defaultProvider: resolved.defaultProvider,
      maxTurns: merged.agent.maxTurns,
      toolTimeoutSeconds: merged.tools.timeoutSeconds,
      thinking: merged.ui.thinking,
      toolDetails: merged.ui.toolDetails,
      verbose: options.verbose,
      providers: resolved.providers,
    });
  }

  /** All enabled model choices in built-in Provider registration order. */
  get models(): readonly ModelConfig[] {
    return [...this.#providers].map(([provider, entry]) => ({
      provider,
      model: entry.model,
    }));
  }

  get defaultModel(): ModelConfig {
    const entry = this.#providers.get(this.defaultProvider);
    if (entry === undefined) {
      throw new Error(`Default provider is not configured: ${this.defaultProvider}`);
    }
    return { provider: this.defaultProvider, model: entry.model };
  }

  /** Short-lived Provider connections for ModelRuntime construction. */
  runtimeProviders(): readonly RuntimeProviderConfig[] {
    return [...this.#providers].map(([id, entry]) => ({
      id,
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
