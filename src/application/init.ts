import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USER_CONFIG_TEMPLATE = `{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "model": "gpt-5",
      "baseUrl": "https://api.openai.com/v1"
    }
  },
  "agent": {
    "maxTurns": 20
  },
  "tools": {
    "timeoutSeconds": 120
  },
  "ui": {
    "thinking": "hidden",
    "toolDetails": "compact"
  }
}
`;

const AUTH_TEMPLATE = `{
  "providers": {
    "openai": {
      "apiKey": ""
    }
  }
}
`;

/** Create one file exclusively; report skipped when it already exists. */
async function createExclusive(
  path: string,
  content: string,
  options?: { readonly mode?: number },
): Promise<"created" | "skipped"> {
  try {
    await writeFile(path, content, {
      flag: "wx",
      encoding: "utf8",
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
    });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
    throw error;
  }
}

/**
 * Create the missing ~/.kea templates. Each target is created exclusively;
 * existing files are never overwritten, and a failed second write does not
 * roll back the first.
 */
export async function initializeUserConfiguration(keaHome: string): Promise<{
  readonly config: "created" | "skipped";
  readonly auth: "created" | "skipped";
}> {
  await mkdir(keaHome, { recursive: true });
  const config = await createExclusive(
    join(keaHome, "config.json"),
    USER_CONFIG_TEMPLATE,
  );
  const auth = await createExclusive(join(keaHome, "auth.json"), AUTH_TEMPLATE, {
    mode: 0o600,
  });
  return { config, auth };
}
