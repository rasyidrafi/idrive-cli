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
