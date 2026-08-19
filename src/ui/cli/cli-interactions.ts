import type {
  InteractionOptions,
  UserInteraction,
} from "../../coding-agent/index.js";

export interface CliInteractionsOptions {
  readonly question: (
    prompt: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly log?: (text: string) => void;
}

/**
 * CLI adapter for the Coding Agent `UserInteraction` port. One question owns
 * the terminal until answered; Run cancellation aborts the question and
 * propagates, ordinary cancellation (EOF / blank) returns a neutral value.
 */
export class CliInteractions implements UserInteraction {
  private readonly questionFn: CliInteractionsOptions["question"];
  private readonly logFn: (text: string) => void;

  constructor(options: CliInteractionsOptions) {
    this.questionFn = options.question;
    this.logFn = options.log ?? ((text) => console.error(text));
  }

  async select(
    title: string,
    options: readonly string[],
    opts?: InteractionOptions,
  ): Promise<number | undefined> {
    try {
      const numbered = options
        .map((option, index) => `  ${index + 1}. ${option}`)
        .join("\n");
      const answer = await this.ask(`\n${title}\n${numbered}\n  Selection? `, opts);
      const trimmed = answer.trim();
      if (!/^\d+$/u.test(trimmed)) return undefined;
      const selected = Number.parseInt(trimmed, 10);
      return selected >= 1 && selected <= options.length ? selected - 1 : undefined;
    } catch (error) {
      return this.cancelOrThrow(opts, error);
    }
  }

  async confirm(
    title: string,
    message: string,
    opts?: InteractionOptions,
  ): Promise<boolean> {
    try {
      const answer = await this.ask(`\n⚠ ${message}\n  (y/N) `, opts);
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } catch (error) {
      this.cancelOrThrow(opts, error);
      return false;
    }
  }

  async input(
    title: string,
    placeholder?: string,
    opts?: InteractionOptions,
  ): Promise<string | undefined> {
    try {
      const hint = placeholder === undefined ? "" : ` (${placeholder})`;
      const answer = await this.ask(`\n${title}${hint}\n  > `, opts);
      const trimmed = answer.trim();
      return trimmed === "" ? undefined : trimmed;
    } catch (error) {
      return this.cancelOrThrow(opts, error);
    }
  }

  private ask(prompt: string, opts?: InteractionOptions): Promise<string> {
    const signal = opts?.signal;
    return signal === undefined
      ? this.questionFn(prompt)
      : this.questionFn(prompt, { signal });
  }

  /** Rethrow a genuine abort; treat an AbortError/EOF as a neutral cancel. */
  private cancelOrThrow(
    opts: InteractionOptions | undefined,
    error: unknown,
  ): undefined {
    opts?.signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") return undefined;
    throw error;
  }
}
