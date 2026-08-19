import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelConfig } from "../../core/ai/types.js";
import type { ProtocolId, RuntimeProviderConfig } from "../../core/ai/index.js";
import { BUILTIN_DEFAULTS, PROTOCOLS } from "./defaults.js";
import {
  ConfigurationError,
  formatProtocols,
  parseAuth,
  parseOrdinarySource,
  type ParsedOrdinary,
  type ProviderFields,
} from "./schema.js";
import { initializeUserConfiguration } from "./templates.js";

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

  /** Pure layered load: no template creation, explicit keaHome. */
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
      agent: { maxTurns: BUILTIN_DEFAULTS.maxTurns },
      tools: { timeoutSeconds: BUILTIN_DEFAULTS.toolTimeoutSeconds },
      ui: { thinking: BUILTIN_DEFAULTS.thinking, toolDetails: BUILTIN_DEFAULTS.toolDetails },
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

/**
 * Application bootstrap: resolve keaHome (default ~/.kea), create missing user
 * templates, report created files, then load the layered Config. Returns the
 * config and the resolved keaHome for downstream composition (e.g. the Coding
 * Agent factory needs it).
 */
export async function loadConfig(options: {
  readonly projectDirectory: string;
  readonly configOverride?: string;
  readonly verbose: boolean;
  readonly keaHome?: string;
}): Promise<{ config: Config; keaHome: string }> {
  const keaHome = options.keaHome ?? resolve(homedir(), ".kea");
  const created = await initializeUserConfiguration(keaHome);
  if (created.config === "created") {
    console.log(`${join(keaHome, "config.json")}: created`);
  }
  if (created.auth === "created") {
    console.log(`${join(keaHome, "auth.json")}: created`);
  }
  const config = await Config.load({
    keaHome,
    projectDirectory: options.projectDirectory,
    ...(options.configOverride === undefined
      ? {}
      : { configOverride: options.configOverride }),
    verbose: options.verbose,
  });
  return { config, keaHome };
}
