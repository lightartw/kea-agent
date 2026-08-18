import type {
  Interactions,
  PermissionReply,
  PermissionRequest,
} from "../../coding-agent/index.js";

export interface CliInteractionsOptions {
  readonly question: (
    prompt: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly log?: (text: string) => void;
}

/**
 * CLI adapter for the Coding Agent Permission port. One question owns
 * the terminal until answered; Run cancellation aborts the question and
 * propagates, ordinary cancellation returns deny.
 */
export class CliInteractions implements Interactions {
  private readonly questionFn: CliInteractionsOptions["question"];
  private readonly logFn: (text: string) => void;

  constructor(options: CliInteractionsOptions) {
    this.questionFn = options.question;
    this.logFn = options.log ?? ((text) => console.error(text));
  }

  async permission(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionReply> {
    try {
      const answer = signal === undefined
        ? await this.questionFn(this.promptText(request))
        : await this.questionFn(this.promptText(request), { signal });
      const normalized = answer.trim().toLowerCase();
      if (normalized === "o" || normalized === "once") return { kind: "once" };
      if (normalized === "a" || normalized === "always") return { kind: "always" };
      return { kind: "deny" };
    } catch (error) {
      // A cancelled Run must not turn into a user deny.
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        return { kind: "deny" };
      }
      throw error;
    }
  }

  private promptText(request: PermissionRequest): string {
    const target = request.kind === "dangerous-command"
      ? request.command
      : request.targetPath;
    return `\n⚠ ${request.reason}\n   ${target}\n   Allow once [o/N] (a = always)? `;
  }
}
