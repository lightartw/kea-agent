/** Handler registered for a hook event type. */
export type HookHandler = (event: unknown) => Promise<unknown>;

/** Strategy that controls how multiple handler results are reduced. */
export type ReduceStrategy = "earlyExit" | "transform" | "patch" | "observe";
