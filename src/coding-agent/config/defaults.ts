import type { ProtocolId } from "../../core/ai/index.js";

/** The three wire-protocol identifiers, in built-in display order. */
export const PROTOCOLS: readonly ProtocolId[] = ["anthropic", "openai", "gemini"];

/** Field names that are credentials; rejected in ordinary config sources. */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "token",
  "secret",
  "password",
]);

/** Built-in defaults applied before any configuration source. */
export const BUILTIN_DEFAULTS = {
  maxTurns: 20,
  toolTimeoutSeconds: 120,
  thinking: "visible" as const,
  toolDetails: "compact" as const,
};
