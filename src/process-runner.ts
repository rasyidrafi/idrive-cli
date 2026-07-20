import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  maxOutputBytes?: number;
  onOutput?: (stream: "stderr" | "stdout", chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CommandRunner {
  run(file: string, arguments_: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

export class CommandFailure extends Error {
  public constructor(
    public readonly file: string,
    public readonly result: CommandResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(
      `${file} exited with code ${result.code}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "CommandFailure";
  }
}

export class ProcessRunner implements CommandRunner {
  public async run(
    file: string,
    arguments_: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    if (options.signal?.aborted) {
      throw new Error(`${file} was aborted`);
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(file, arguments_, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
      const timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
      const killGraceMs = options.killGraceMs ?? 5_000;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let terminationError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const kill = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back when the process group has already disappeared.
          }
        }
        child.kill(signal);
      };

      const terminate = (error: Error): void => {
        if (terminationError || settled) {
          return;
        }
        terminationError = error;
        kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) {
            kill("SIGKILL");
          }
        }, killGraceMs);
        killTimer.unref();
      };

      const timeout = setTimeout(() => {
        terminate(new Error(`${file} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref();
      const onAbort = (): void => terminate(new Error(`${file} was aborted`));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };

      const append = (target: "stderr" | "stdout", chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminate(new Error(`${file} exceeded the output limit`));
          return;
        }
        const text = chunk.toString("utf8");
        options.onOutput?.(target, text);
        if (target === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          cleanup();
          if (terminationError) {
            reject(terminationError);
          } else {
            resolve({ code: code ?? -1, stderr, stdout });
          }
        }
      });
    });
  }
}

export async function runChecked(
  runner: CommandRunner,
  file: string,
  arguments_: readonly string[],
  options?: RunOptions,
): Promise<CommandResult> {
  const result = await runner.run(file, arguments_, options);
  if (result.code !== 0) {
    throw new CommandFailure(file, result);
  }
  return result;
}
