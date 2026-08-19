import { resolve } from "node:path";

export type Diagnostic = { readonly type: "warning" | "error"; readonly message: string };

export interface Args {
  readonly continue: boolean;
  readonly config?: string;
  readonly verbose: boolean;
  readonly directory: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Parse production argv before any file, Project, or Runtime work. The
 * optional directory and --config value resolve against process.cwd().
 *
 * Argument errors are collected into `diagnostics` instead of throwing, so the
 * caller can decide how to report them.
 */
export function parseArgs(argv: readonly string[]): Args {
  const diagnostics: Diagnostic[] = [];
  let continueFlag = false;
  let verbose = false;
  let config: string | undefined;
  let directory: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "-c") {
      if (continueFlag) diagnostics.push({ type: "error", message: "Duplicate option: -c" });
      continueFlag = true;
      index += 1;
    } else if (token === "--verbose") {
      if (verbose) diagnostics.push({ type: "error", message: "Duplicate option: --verbose" });
      verbose = true;
      index += 1;
    } else if (token === "--config") {
      if (config !== undefined) {
        diagnostics.push({ type: "error", message: "Duplicate option: --config" });
      }
      const value = argv[index + 1];
      if (value === undefined) {
        diagnostics.push({ type: "error", message: "Missing value for --config" });
      } else {
        config = resolve(value);
        index += 1;
      }
      index += 1;
    } else if (token.startsWith("-")) {
      diagnostics.push({ type: "error", message: `Unknown option: ${token}` });
      index += 1;
    } else {
      if (directory !== undefined) {
        diagnostics.push({ type: "error", message: `Multiple directories: ${token}` });
      } else {
        directory = resolve(token);
      }
      index += 1;
    }
  }

  return {
    continue: continueFlag,
    ...(config === undefined ? {} : { config }),
    verbose,
    directory: directory ?? process.cwd(),
    diagnostics,
  };
}
