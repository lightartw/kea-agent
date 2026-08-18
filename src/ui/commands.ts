export type UiAction =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "new-session" }
  | { readonly kind: "switch-session" }
  | { readonly kind: "switch-model" }
  | { readonly kind: "help" }
  | { readonly kind: "exit" }
  | { readonly kind: "command-error"; readonly message: string };

const COMMANDS: Readonly<Record<string, UiAction>> = {
  "/new": { kind: "new-session" },
  "/session": { kind: "switch-session" },
  "/model": { kind: "switch-model" },
  "/help": { kind: "help" },
  "/exit": { kind: "exit" },
};

/**
 * Parse one input line. Only an exact registered slash token at character
 * zero is a command; everything else is an untrimmed Prompt, and a known
 * command with trailing arguments becomes a command error.
 */
export function parseInput(input: string): UiAction {
  if (!input.startsWith("/")) return { kind: "prompt", text: input };
  const [token, ...rest] = input.split(/\s+/);
  const command = COMMANDS[token ?? ""];
  if (command === undefined) return { kind: "prompt", text: input };
  if (rest.join(" ") !== "") {
    return {
      kind: "command-error",
      message: `${token} does not accept arguments`,
    };
  }
  return command;
}
