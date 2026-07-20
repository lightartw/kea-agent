export class LLMError extends Error {
  override name = "LLMError";
}

export class LLMConfigurationError extends LLMError {
  override name = "LLMConfigurationError";
}

export class LLMTimeoutError extends LLMError {
  override name = "LLMTimeoutError";
}

export class LLMAuthenticationError extends LLMError {
  override name = "LLMAuthenticationError";
}

export class LLMProviderError extends LLMError {
  override name = "LLMProviderError";
}
