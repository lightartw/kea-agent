import { AgentToolRegistry } from "../../agent/tools/registry.js";
import { createBashToolDefinition } from "./builtin/bash/bash.js";
import {
  createEditFileToolDefinition,
  createGlobToolDefinition,
  createReadFileToolDefinition,
  createWriteFileToolDefinition,
} from "./builtin/files.js";
import { createTodoWriteToolDefinition } from "./builtin/todo.js";
import { toAgentTool } from "./definition.js";
import type {
  CodingToolContext,
  ToolDefinition,
} from "./definition.js";

export function createBuiltinToolDefinitions(): readonly ToolDefinition[] {
  return [
    createBashToolDefinition(),
    createReadFileToolDefinition(),
    createWriteFileToolDefinition(),
    createEditFileToolDefinition(),
    createGlobToolDefinition(),
    createTodoWriteToolDefinition(),
  ];
}

export function createAgentToolRegistry(
  definitions: readonly ToolDefinition[],
  context: CodingToolContext,
): AgentToolRegistry {
  const tools = new AgentToolRegistry();
  for (const definition of definitions) {
    tools.register(toAgentTool(definition, context));
  }
  return tools;
}
