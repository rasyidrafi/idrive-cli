export async function runFailFast<T>(
  values: readonly T[],
  parentSignal: AbortSignal,
  worker: (value: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  let primaryError: Error | undefined;
  const tasks = values.map(async (value) => {
    try {
      await worker(value, signal);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      primaryError ??= normalized;
      controller.abort();
      throw normalized;
    }
  });
  await Promise.allSettled(tasks);
  if (primaryError !== undefined) throw primaryError;
}

export class OperationLimiter {
  private active = 0;
  private readonly waiting: Array<{
    reject: (error: Error) => void;
    resolve: (release: () => void) => void;
    signal?: AbortSignal;
    operation: string;
  }> = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new IDriveError("usage", "maxConcurrentOperations must be an integer between 1 and 16", "create client");
    }
  }

  public async run<T>(
    operation: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(operation, signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async acquire(operation: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw cancelledOperation(operation);
    if (this.active < this.maximum) {
      this.active++;
      return this.release;
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiting)[number] = {
        reject,
        ...(signal ? { signal } : {}),
        operation,
        resolve: (queuedRelease) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(queuedRelease);
        },
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(cancelledOperation(operation));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private readonly release = (): void => {
    const next = this.waiting.shift();
    if (next) {
      next.resolve(this.release);
      return;
    }
    this.active--;
  };
}

function cancelledOperation(operation: string): IDriveError {
  return new IDriveError("cancelled", `IDrive ${operation} was cancelled`, operation);
}
import { IDriveError } from "./errors.js";
