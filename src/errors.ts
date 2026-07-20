export type IdriveErrorCode = "auth" | "cancelled" | "config" | "engine" | "local-io" | "not-found" | "transient" | "usage";

export class IdriveError extends Error {
  public constructor(
    public readonly code: IdriveErrorCode,
    message: string,
    public readonly operation?: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IdriveError";
  }
}

export function exitCode(error: unknown): number {
  if (!(error instanceof IdriveError)) return 6;
  return { usage: 2, auth: 3, config: 3, "not-found": 4, transient: 5, engine: 6, "local-io": 6, cancelled: 130 }[error.code];
}
