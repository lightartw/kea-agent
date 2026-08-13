import type { CodingToolDefinition } from "../definition.js";
import { createBashToolDefinition } from "./bash/definition.js";
import {
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
  createEditFileToolDefinition,
} from "./files.js";
import { createGlobToolDefinition } from "./glob.js";
import { createTodoWriteToolDefinition } from "./todo/definition.js";

/** Build the default Coding Tool definitions. */
export function createDefaultToolDefinitions(): readonly CodingToolDefinition[] {
  return [
    createBashToolDefinition(),
    createReadFileToolDefinition(),
    createWriteFileToolDefinition(),
    createEditFileToolDefinition(),
    createGlobToolDefinition(),
    createTodoWriteToolDefinition(),
  ];
}
