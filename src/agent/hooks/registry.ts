import type {
  AgentHookEvent,
  Cleanup,
  ContextEvent,
  ContextResult,
  HookEvent,
  HookHandler,
  HookObserver,
  ResultOf,
  StopEvent,
  StopResult,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultPatch,
  Unregister,
  UserPromptEvent,
  UserPromptResult,
} from "./types.js";

const KNOWN_EVENT_TYPES = new Set<string>([
  "user_prompt",
  "context",
  "tool_call",
  "tool_result",
  "stop",
]);

export class HookRegistry<
  TEvent extends HookEvent<string, unknown>,
  TContext,
> {
  private _context: TContext;
  private readonly handlers = new Map<
    string,
    Set<HookHandler<TEvent, TContext>>
  >();
  private readonly observers = new Set<HookObserver<TEvent, TContext>>();
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

  register<TType extends TEvent["type"]>(
    type: TType,
    handler: HookHandler<Extract<TEvent, { type: TType }>, TContext>,
  ): Unregister {
    this.assertActive();
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const typedHandler = handler as HookHandler<TEvent, TContext>;
    set.add(typedHandler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set!.delete(typedHandler);
    };
  }

  registerObserver(
    observer: HookObserver<TEvent, TContext>,
  ): Unregister {
    this.assertActive();
    this.observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.observers.delete(observer);
    };
  }

  async trigger<T extends TEvent>(
    event: T,
    signal?: AbortSignal,
  ): Promise<ResultOf<T> | undefined> {
    this.assertActive();
    this.assertKnownEvent(event.type);
    const context = this._context;
    const observers = [...this.observers];
    const handlers = [...(this.handlers.get(event.type) ?? [])];

    for (const observer of observers) {
      await observer(event as unknown as TEvent, context, signal);
    }

    switch (event.type) {
      case "user_prompt":
        return this.triggerUserPrompt(
          event as unknown as UserPromptEvent,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "context":
        return this.triggerContext(
          event as unknown as ContextEvent,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "tool_call":
        return this.triggerToolCall(
          event as unknown as ToolCallEvent,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "tool_result":
        return this.triggerToolResult(
          event as unknown as ToolResultEvent,
          handlers,
          context,
          signal,
        ) as Promise<ResultOf<T> | undefined>;
      case "stop":
        return this.triggerStop(
          event as unknown as StopEvent,
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

  private assertKnownEvent(type: string): void {
    if (!KNOWN_EVENT_TYPES.has(type)) {
      throw new Error(`Unknown hook event '${type}'`);
    }
  }

  private async clearRegistrations(): Promise<void> {
    const cleanups = [...this.cleanups].reverse();
    this.handlers.clear();
    this.observers.clear();
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

  // ── Event-specific trigger implementations ──

  private async triggerUserPrompt(
    event: UserPromptEvent,
    handlers: HookHandler<TEvent, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<UserPromptResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<UserPromptEvent, TContext>)(
        event,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as UserPromptResult;
        if (r.block === true) return r;
      }
    }
    return undefined;
  }

  private async triggerContext(
    event: ContextEvent,
    handlers: HookHandler<TEvent, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<ContextResult | undefined> {
    let current = event;
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<ContextEvent, TContext>)(
        current,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as ContextResult;
        if (r.messages !== undefined) {
          current = { ...current, messages: r.messages };
        }
      }
    }
    return current.messages !== event.messages
      ? { messages: current.messages }
      : undefined;
  }

  private async triggerToolCall(
    event: ToolCallEvent,
    handlers: HookHandler<TEvent, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolCallResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<ToolCallEvent, TContext>)(
        event,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as ToolCallResult;
        if (r.block === true) return r;
      }
    }
    return undefined;
  }

  private async triggerToolResult(
    event: ToolResultEvent,
    handlers: HookHandler<TEvent, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultPatch | undefined> {
    let currentContent = event.content;
    let currentIsError = event.isError;
    let hasPatch = false;
    const accumulated: { content?: string; isError?: boolean } = {};
    for (const handler of handlers) {
      const syntheticEvent: ToolResultEvent = {
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        content: currentContent,
        isError: currentIsError,
      };
      const result = await (handler as unknown as HookHandler<ToolResultEvent, TContext>)(
        syntheticEvent,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as ToolResultPatch;
        if (r.content !== undefined) {
          accumulated.content = r.content;
          currentContent = r.content;
          hasPatch = true;
        }
        if (r.isError !== undefined) {
          accumulated.isError = r.isError;
          currentIsError = r.isError;
          hasPatch = true;
        }
      }
    }
    return hasPatch ? (accumulated as ToolResultPatch) : undefined;
  }

  private async triggerStop(
    event: StopEvent,
    handlers: HookHandler<TEvent, TContext>[],
    context: TContext,
    signal: AbortSignal | undefined,
  ): Promise<StopResult | undefined> {
    for (const handler of handlers) {
      const result = await (handler as unknown as HookHandler<StopEvent, TContext>)(
        event,
        context,
        signal,
      );
      if (result !== undefined && result !== null) {
        const r = result as StopResult;
        if (r.continueWith !== undefined) return r;
      }
    }
    return undefined;
  }
}
