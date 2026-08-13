export interface ConfirmationRequest {
  readonly source: string;
  readonly title: string;
  readonly message: string;
}

export interface Notification {
  readonly source: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface CodingAgentInteractions {
  readonly available: boolean;
  confirm(request: ConfirmationRequest, signal?: AbortSignal): Promise<boolean>;
  notify(notification: Notification): void | Promise<void>;
}
