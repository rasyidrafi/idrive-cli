import { open, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensurePrivateDirectory } from "./secure-directory.js";

export interface LockOptions {
  signal?: AbortSignal;
  staleMs?: number;
  timeoutMs?: number;
}

export async function withFileLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  await ensurePrivateDirectory(path.dirname(lockFile));
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 60 * 60 * 1000;
  while (true) {
    if (options.signal?.aborted) throw new Error("Lock acquisition was aborted");
    let handle: Awaited<ReturnType<typeof open>>;
    const token = `${process.pid}:${randomUUID()}`;
    try {
      handle = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if (!isExists(error)) throw error;
      let age: number;
      try {
        age = Date.now() - (await stat(lockFile)).mtimeMs;
      } catch (statError) {
        if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") continue;
        throw statError;
      }
      const owner = await readFile(lockFile, "utf8").catch(() => "");
      if (age > staleMs && !isLiveOwner(owner)) {
        throw new Error(`Stale lock requires manual removal: ${lockFile}`, { cause: error });
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockFile}`, { cause: error });
      }
      await abortableDelay(50, options.signal);
      continue;
    }
    try {
      await handle.writeFile(`${token}\n`);
      return await operation();
    } finally {
      await handle.close();
      const owner = await readFile(lockFile, "utf8").catch(() => "");
      if (owner.trim() === token) await rm(lockFile, { force: true });
    }
  }
}

function isLiveOwner(value: string): boolean {
  const pid = Number(value.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("Lock acquisition was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
