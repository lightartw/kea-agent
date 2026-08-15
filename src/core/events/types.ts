export interface EmitEvent<TInput> {
  readonly type: "emit";
  readonly input: TInput;
}

export interface InterceptEvent<TInput, TResult> {
  readonly type: "intercept";
  readonly input: TInput;
  readonly result: TResult;
}

export interface EventMap {}
