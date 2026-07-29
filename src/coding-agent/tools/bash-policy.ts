const HARD_DENY_RULES = [
  { pattern: /\bsudo\b/i, reason: "sudo is not allowed" },
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
  // Match "rm" followed by both -r and -f (in any order: -rf, -fr, -r -f, -f -r)
  // targeting "/" or "/*"
  if (!/\brm\b/.test(command)) return false;
  const tokens = command.split(/\s+/);
  const flags = tokens.filter((t) => /^-[a-zA-Z]+$/.test(t)).join("");
  const hasR = flags.includes("r");
  const hasF = flags.includes("f");
  const targetsRoot = tokens.some((t) => t === "/" || t === "/*");
  return hasR && hasF && targetsRoot;
}

/**
 * Return a human-readable reason if `command` is unconditionally denied
 * regardless of Hook configuration. This is a backstop inside BashTool itself.
 */
export function hardDeniedBashReason(command: string): string | undefined {
  if (isRecursiveForcedRootDelete(command)) {
    return "recursive forced root deletion is not allowed";
  }
  for (const rule of HARD_DENY_RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  return undefined;
}

type BashDecision =
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

/**
 * Classify a Bash command into allow / ask / deny.
 * This is the single shared policy used by both the Permission Hook and BashTool.
 */
export function classifyBashCommand(command: string): BashDecision {
  const hardDeny = hardDeniedBashReason(command);
  if (hardDeny !== undefined) return { decision: "deny", reason: hardDeny };

  for (const rule of ASK_RULES) {
    if (rule.pattern.test(command)) return { decision: "ask", reason: rule.reason };
  }

  return { decision: "allow" };
}
