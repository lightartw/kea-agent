import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PreToolDecision, ToolCallEvent } from "../../../core/harness/tools/events.js";
import type { UserInteraction } from "../../interaction/interactions.js";
import { classifyBashCommand } from "./bash-policy.js";

/**
 * One remembered authorization. `approved` is owned by the caller (Project
 * level, shared by all Sessions, in memory only); Permission appends to it on
 * `always` replies and never replaces it.
 */
export type PermissionRule =
  | { readonly kind: "command"; readonly command: string; readonly cwd: string }
  | { readonly kind: "directory"; readonly directory: string };

/** One user decision for an ask-classified operation. Internal to Permission. */
type PermissionReply =
  | { readonly kind: "once" }
  | { readonly kind: "always" }
  | { readonly kind: "deny"; readonly reason?: string };

/** Tool-operation classification is a Permission-internal detail. */
type PermissionOperation = "read" | "write" | "edit" | "glob";

const FILE_TOOL_OPERATIONS: Readonly<Record<string, PermissionOperation>> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  glob: "glob",
};

const OUTSIDE_PROJECT_REASON = "outside the project directory";

function matchesCommand(
  approved: readonly PermissionRule[],
  command: string,
  cwd: string,
): boolean {
  return approved.some((rule) =>
    rule.kind === "command" && rule.command === command && rule.cwd === cwd
  );
}

/** Platform path containment: the directory itself and all descendants. */
function contains(directory: string, targetPath: string): boolean {
  const rest = relative(resolve(directory), resolve(targetPath));
  return rest === "" ||
    (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

/** Appends a rule unless an equivalent one already exists. */
function remember(approved: PermissionRule[], rule: PermissionRule): void {
  const duplicate = rule.kind === "command"
    ? matchesCommand(approved, rule.command, rule.cwd)
    : approved.some((item) =>
        item.kind === "directory" && resolve(item.directory) === resolve(rule.directory)
      );
  if (!duplicate) approved.push(rule);
}

/** The path portion of a glob pattern before any wildcard. */
function staticGlobPrefix(pattern: string): string {
  const match = /[*?[{]/.exec(pattern);
  if (match === null) return pattern;
  const prefix = pattern.slice(0, match.index);
  return prefix === "" ? "." : prefix;
}

/** Resolves the operation's target path against the cwd; malformed args are undefined. */
function fileTarget(
  args: Record<string, unknown>,
  operation: PermissionOperation,
  cwd: string,
): string | undefined {
  if (operation === "glob") {
    const pattern = args.pattern;
    if (typeof pattern !== "string") return undefined;
    return resolve(cwd, staticGlobPrefix(pattern));
  }
  const path = args.path;
  if (typeof path !== "string") return undefined;
  return resolve(cwd, path);
}

const PERMISSION_OPTIONS = ["Allow once", "Always allow", "Deny"] as const;

/** Maps a select index to a permission reply; out-of-range/undefined deny. */
function replyFromIndex(index: number | undefined): PermissionReply {
  switch (index) {
    case 0:
      return { kind: "once" };
    case 1:
      return { kind: "always" };
    default:
      return { kind: "deny" };
  }
}

/** Delegates to the interaction, failing closed unless aborted. */
async function ask(
  interaction: UserInteraction,
  prompt: string,
  signal?: AbortSignal,
): Promise<PermissionReply> {
  try {
    const index = await interaction.select(
      prompt,
      PERMISSION_OPTIONS,
      signal === undefined ? undefined : { signal },
    );
    return replyFromIndex(index);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      kind: "deny",
      reason: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Maps a reply to a decision; `always` records the authorization first. */
function applyReply(
  reply: PermissionReply,
  record: () => void,
): PreToolDecision {
  switch (reply.kind) {
    case "always":
      record();
      return { kind: "allow" };
    case "once":
      return { kind: "allow" };
    case "deny":
      return { kind: "deny", reason: reply.reason ?? "Permission denied by user" };
    default:
      return { kind: "deny", reason: "Permission request failed: invalid reply" };
  }
}

async function authorizeDirectory(
  input: ToolCallEvent,
  targetPath: string,
  directory: string,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interaction: UserInteraction;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision> {
  const { trustedDirectories, approved, interaction } = options;
  const trusted = trustedDirectories.some((trustedDirectory) =>
    contains(trustedDirectory, targetPath)
  );
  if (trusted) return { kind: "allow" };
  const approvedDirectory = approved.some((rule) =>
    rule.kind === "directory" && contains(rule.directory, targetPath)
  );
  if (approvedDirectory) return { kind: "allow" };

  const prompt = `\n⚠ ${OUTSIDE_PROJECT_REASON}\n   ${targetPath}\n   Allow access to this directory?`;
  const reply = await ask(interaction, prompt, signal);
  return applyReply(reply, () => {
    remember(approved, { kind: "directory", directory: resolve(directory) });
  });
}

async function authorizeCommand(
  input: ToolCallEvent,
  command: string,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interaction: UserInteraction;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision> {
  const { cwd, approved, interaction } = options;
  const classification = classifyBashCommand(command);
  if (classification.decision === "deny") {
    return { kind: "deny", reason: classification.reason };
  }
  if (matchesCommand(approved, command, cwd)) return { kind: "allow" };
  if (classification.decision === "allow") return { kind: "allow" };

  const prompt = `\n⚠ ${classification.reason}\n   ${command}\n   Allow this command?`;
  const reply = await ask(interaction, prompt, signal);
  return applyReply(reply, () => {
    remember(approved, { kind: "command", command, cwd });
  });
}

/**
 * One stateless decision for a Tool Call (spec §11). Bash authorizes its
 * execution cwd first (external-directory), then applies hard deny,
 * remembered commands and the ask policy. Path tools are checked against
 * trusted and approved directories. Tools unrelated to Permission pass.
 */
export async function decidePermission(
  input: ToolCallEvent,
  options: {
    readonly cwd: string;
    readonly trustedDirectories: readonly string[];
    readonly approved: PermissionRule[];
    readonly interaction: UserInteraction;
  },
  signal?: AbortSignal,
): Promise<PreToolDecision> {
  const { call } = input;
  if (call.name === "bash") {
    const command = call.arguments.command;
    if (typeof command !== "string") {
      return {
        kind: "deny",
        reason: `Permission request failed: invalid arguments for ${call.name}`,
      };
    }
    const cwdDecision = await authorizeDirectory(
      input,
      options.cwd,
      options.cwd,
      options,
      signal,
    );
    if (cwdDecision.kind !== "allow") return cwdDecision;
    return authorizeCommand(input, command, options, signal);
  }

  const operation = FILE_TOOL_OPERATIONS[call.name];
  if (operation === undefined) return { kind: "allow" };
  const targetPath = fileTarget(call.arguments, operation, options.cwd);
  if (targetPath === undefined) {
    return {
      kind: "deny",
      reason: `Permission request failed: invalid arguments for ${call.name}`,
    };
  }
  const directory = operation === "glob" ? targetPath : dirname(targetPath);
  return authorizeDirectory(input, targetPath, directory, options, signal);
}
