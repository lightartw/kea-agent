import type {
  AfterToolCall,
  AfterToolCallResult,
  AgentHookCall,
  BeforeStopCall,
  BeforeStopResult,
  BeforeToolCall,
  BeforeToolCallResult,
  BeforeUserPromptCall,
  BeforeUserPromptResult,
  Cleanup,
  HookHandler,
  ResultOf,
  TransformContextCall,
  TransformContextResult,
  Unregister,
} from "./types.js";

function assertAfterToolCallResult(value: unknown): asserts value is AfterToolCallResult {
  if (typeof value !== "object" || value === null) return;
  if (!Object.hasOwn(value, "details")) return;
  if (!Object.hasOwn(value, "content") ||
    typeof (value as { content?: unknown }).content !== "string") {
    throw new TypeError("AfterToolCallResult details requires string content");
  }
}

export class HookRegistry<TContext> {
  private _context: TContext;
  private readonly handlers = new Map<
    string,
    Set<HookHandler<AgentHookCall, TContext>>
  >();
  private readonly cleanups: Cleanup[] = [];
  private disposed = false;

  constructor(context: TContext) {
    this._context = context;
  }

  get context(): TContext {
    return this._context;
  }

  setContext(context: TContext): void {
    this.assertActive();
    this._context = context;
  }

  register<TType extends AgentHookCall["type"]>(
    type: TType,
    handler: HookHandler<Extract<AgentHookCall, { type: TType }>, TContext>,
  ): Unregister {
    this.assertActive();
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const typedHandler = handler as HookHandler<AgentHookCall, TContext>;
    set.add(typedHandler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set!.delete(typedHandler);
    };
  }

  async trigger<T extends AgentHookCall>(
    call: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined> {
    this.assertActive();
    const context = this._context;
    const handlers = [...(this.handlers.get(call.type) ?? [])];

    switch (call.type) {
      case "user_prompt":
        return this.triggerBeforeUserPrompt(
          call as unknown as BeforeUserPromptCall,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "context":
        return this.triggerTransformContext(
          call as unknown as TransformContextCall,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "tool_call":
        return this.triggerBeforeToolCall(
          call as unknown as BeforeToolCall,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "tool_result":
        return this.triggerAfterToolCall(
          call as unknown as AfterToolCall,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "stop":
        return this.triggerBeforeStop(
          call as unknown as BeforeStopCall,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      default:
        return undefined;
    }
  }

  addCleanup(cleanup: Cleanup): Unregister {
    this.assertActive();
    this.cleanups.push(cleanup);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.cleanups.indexOf(cleanup);
      if (index !== -1) this.cleanups.splice(index, 1);
    };
  }

  async clear(): Promise<void> {
    this.assertActive();
    await this.clearRegistrations();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.clearRegistrations();
  }

  // ── Private helpers ──

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("HookRegistry is disposed");
    }
  }

  private async clearRegistrations(): Promise<void> {
    const cleanups = [...this.cleanups].reverse();
    this.handlers.clear();
    this.cleanups.length = 0;
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Hook cleanup failed");
  }

  // ── Call-specific trigger implementations ──

  private async triggerBeforeUserPrompt(
    call: BeforeUserPromptCall,
    handlers: HookHandler<AgentHookCall, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<BeforeUserPromptResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<BeforeUserPromptCall, TContext>)(
        call,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as BeforeUserPromptResult;
        if (r.block === true) return r;
      }
    }
    return undefined;
  }

  private async triggerTransformContext(
    call: TransformContextCall,
    handlers: HookHandler<AgentHookCall, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<TransformContextResult | undefined> {
    let current = call;
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<TransformContextCall, TContext>)(
        current,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as TransformContextResult;
        if (r.messages !== undefined) {
          current = { ...current, messages: r.messages };
        }
      }
    }
    return current.messages !== call.messages
      ? { messages: [...current.messages] }
      : undefined;
  }

  private async triggerBeforeToolCall(
    call: BeforeToolCall,
    handlers: HookHandler<AgentHookCall, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolCallResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<BeforeToolCall, TContext>)(
        call,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as BeforeToolCallResult;
        if (r.block === true) return r;
      }
    }
    return undefined;
  }

  private async triggerAfterToolCall(
    call: AfterToolCall,
    handlers: HookHandler<AgentHookCall, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<AfterToolCallResult | undefined> {
    let currentContent = call.content;
    let currentIsError = call.isError;
    let currentDetails = call.details;
    let hasResult = false;
    const accumulated: { content?: string; details?: unknown; isError?: boolean } = {};
    for (const handler of handlers) {
      const syntheticCall: AfterToolCall = {
        type: "tool_result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        content: currentContent,
        ...(currentDetails === undefined ? {} : { details: currentDetails }),
        isError: currentIsError,
      };
      const result = await (handler as unknown as HookHandler<AfterToolCall, TContext>)(
        syntheticCall,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        assertAfterToolCallResult(result);
        const r = result as AfterToolCallResult;
        if (r.content !== undefined) {
          accumulated.content = r.content;
          currentContent = r.content;
          hasResult = true;
        }
        if (Object.hasOwn(r, "details")) {
          accumulated.details = r.details;
          currentDetails = r.details;
          hasResult = true;
        }
        if (r.isError !== undefined) {
          accumulated.isError = r.isError;
          currentIsError = r.isError;
          hasResult = true;
        }
      }
    }
    return hasResult ? (accumulated as AfterToolCallResult) : undefined;
  }

  private async triggerBeforeStop(
    call: BeforeStopCall,
    handlers: HookHandler<AgentHookCall, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<BeforeStopResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<BeforeStopCall, TContext>)(
        call,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as BeforeStopResult;
        if (r.continueWith !== undefined) return r;
      }
    }
    return undefined;
  }
}
