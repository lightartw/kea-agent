export type EventMode = "emit" | "ask" | "transform";

export type EventContract<
  TMode extends EventMode,
  TInput,
  TResult = void,
> = TMode extends "transform"
  ? { readonly mode: TMode; readonly input: TInput; readonly result: TInput }
  : { readonly mode: TMode; readonly input: TInput; readonly result: TResult };

export interface EventMap {}

export interface EventDispatch {
  readonly name: keyof EventMap & string;
  readonly input: unknown;
}

export type EventListenerErrorHandler = (
  error: unknown,
  dispatch: EventDispatch,
) => void;

export type Unregister = () => void;

export type EventName = keyof EventMap & string;
export type ContractOf<TName extends EventName> = EventMap[TName];
export type EventInput<TName extends EventName> =
  ContractOf<TName> extends EventContract<EventMode, infer TInput, unknown>
    ? TInput
    : never;
export type EventResult<TName extends EventName> =
  ContractOf<TName> extends EventContract<EventMode, unknown, infer TResult>
    ? TResult
    : never;

export type NamesWithMode<TMode extends EventMode> = {
  [TName in EventName]: ContractOf<TName> extends EventContract<TMode, unknown, unknown>
    ? TName
    : never;
}[EventName];

export type EmitEventName = NamesWithMode<"emit">;
export type AskEventName = NamesWithMode<"ask">;
export type TransformEventName = NamesWithMode<"transform">;

export type EventListener<TName extends EventName> =
  ContractOf<TName> extends EventContract<"emit", infer TInput, unknown>
    ? (input: TInput) => void | Promise<void>
    : ContractOf<TName> extends EventContract<"ask", infer TInput, infer TResult>
      ? (input: TInput, signal?: AbortSignal) => TResult | undefined | Promise<TResult | undefined>
      : ContractOf<TName> extends EventContract<"transform", infer TValue, unknown>
        ? (
            value: TValue,
            next: (value: TValue) => Promise<TValue>,
            signal?: AbortSignal,
          ) => TValue | Promise<TValue>
        : never;
