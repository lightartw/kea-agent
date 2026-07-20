export class ToolError extends Error {
  override name = "ToolError";
}

export class ToolConfigurationError extends ToolError {
  override name = "ToolConfigurationError";
}

export class ToolExecutionError extends ToolError {
  override name = "ToolExecutionError";
}
