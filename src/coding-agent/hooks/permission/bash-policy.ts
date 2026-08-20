const HARD_DENY_RULES = [
  { pattern: /(?:^|[;&|]\s*)sudo(?:\s|$)/i, reason: "sudo is not allowed" },
  { pattern: /\b(?:shutdown|reboot)\b/i, reason: "system shutdown is not allowed" },
  { pattern: /\bmkfs(?:\.[\w-]+)?\b/i, reason: "filesystem formatting is not allowed" },
  { pattern: /\bdd\b[^;&|]*\bif\s*=/i, reason: "raw dd input is not allowed" },
  { pattern: /(?:^|[;&|])[^;&|]*(?:>|>>)\s*\/dev(?:\/|$)/i, reason: "device redirection is not allowed" },
] as const;

const ASK_RULES = [
  { pattern: /\brm\b/i, reason: "file deletion requires approval" },
  { pattern: /(?:>|>>)\s*\/etc\//i, reason: "system configuration write requires approval" },
  { pattern: /\bchmod\s+777\b/i, reason: "world-writable permissions require approval" },
] as const;

function isRecursiveForcedRootDelete(command: string): boolean {
  if (!/\brm\b/.test(command)) return false;
  const tokens = command.split(/\s+/);
  const shortFlags = tokens
    .filter((token) => /^-[a-zA-Z]+$/.test(token))
    .join("");
  const recursive = shortFlags.includes("r") || tokens.includes("--recursive");
  const forced = shortFlags.includes("f") || tokens.includes("--force");
  return recursive && forced &&
    tokens.some((token) => token === "/" || token === "/*");
}

export function hardDeniedBashReason(command: string): string | undefined {
  if (isRecursiveForcedRootDelete(command)) {
    return "recursive forced root deletion is not allowed";
  }
  return HARD_DENY_RULES.find((rule) => rule.pattern.test(command))?.reason;
}

export type BashDecision =
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

export function classifyBashCommand(command: string): BashDecision {
  const denied = hardDeniedBashReason(command);
  if (denied !== undefined) return { decision: "deny", reason: denied };
  const ask = ASK_RULES.find((rule) => rule.pattern.test(command));
  return ask === undefined
    ? { decision: "allow" }
    : { decision: "ask", reason: ask.reason };
}
