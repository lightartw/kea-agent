/** Options carried by one interaction request. */
export interface InteractionOptions {
  readonly signal?: AbortSignal;
}

/**
 * Port from Coding Agent to an external human (terminal, UI, or test).
 * The returned Promise ties one request to one reply; adapters needing a
 * request ID generate it in their own transport layer. Assemblers must
 * provide an adapter explicitly; there is no built-in default. This port is
 * UI-independent: the Coding Agent neither imports nor depends on any terminal.
 */
export interface UserInteraction {
  /** Present numbered options and return the chosen index (0-based), or undefined on cancel/EOF. */
  select(
    title: string,
    options: readonly string[],
    opts?: InteractionOptions,
  ): Promise<number | undefined>;
  /** Ask a yes/no question and return the boolean decision. */
  confirm(
    title: string,
    message: string,
    opts?: InteractionOptions,
  ): Promise<boolean>;
  /** Ask for free-form text and return it, or undefined on cancel/EOF. */
  input(
    title: string,
    placeholder?: string,
    opts?: InteractionOptions,
  ): Promise<string | undefined>;
}
