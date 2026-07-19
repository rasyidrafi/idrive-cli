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
    return await new Promise((resolve, reject) => {
      const child = spawn(file, arguments_, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
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

      const terminate = (error: Error): void => {
        if (terminationError || settled) {
          return;
        }
        terminationError = error;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, killGraceMs);
        killTimer.unref();
      };

      const timeout = setTimeout(() => {
        terminate(new Error(`${file} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref();

      const append = (target: "stderr" | "stdout", chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminate(new Error(`${file} exceeded the output limit`));
          return;
        }
        if (target === "stdout") {
          stdout += chunk.toString("utf8");
        } else {
          stderr += chunk.toString("utf8");
        }
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
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
