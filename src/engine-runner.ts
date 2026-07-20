import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { selectEngineName } from "./engine-commands.js";
import type { AppLocations } from "./locations.js";
import type { CommandResult, CommandRunner } from "./process-runner.js";
import type { StoredProfile } from "./types.js";
import { ensurePrivateDirectory } from "./secure-directory.js";

export class EngineRunner {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly locations: AppLocations,
  ) {}

  private enginePath(dedup: boolean, directory: string): string {
    return path.join(
      directory,
      selectEngineName(dedup),
    );
  }

  public async isInstalled(): Promise<boolean> {
    try {
      await this.verifyIntegrity();
      return true;
    } catch {
      return false;
    }
  }

  public async diagnose(): Promise<{
    architecture?: string;
    hashes?: Record<string, string>;
    installed: boolean;
    message: string;
    packageVersion?: string;
  }> {
    try {
      await this.verifyIntegrity();
      const manifest = JSON.parse(await readFile(this.locations.manifestFile, "utf8")) as unknown;
      const packageVersion = isRecord(manifest) && typeof manifest.packageVersion === "string" ? manifest.packageVersion : undefined;
      const architecture = isRecord(manifest) && typeof manifest.architecture === "string" ? manifest.architecture : undefined;
      const hashes = isRecord(manifest) && isRecord(manifest.sha256)
        ? Object.fromEntries(Object.entries(manifest.sha256).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined;
      return {
        ...(architecture ? { architecture } : {}),
        ...(hashes ? { hashes } : {}),
        installed: true,
        message: "engine manifest and hashes are valid",
        ...(packageVersion ? { packageVersion } : {}),
      };
    } catch (error) {
      return { installed: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  public async encodeSecret(value: string, signal?: AbortSignal): Promise<string> {
    const directory = await this.verifyIntegrity();
    const result = await this.runUtf8(this.enginePath(false, directory), [
      `--string-encode=${safeArgument(value)}`,
    ], 30_000, signal);
    if (result.code !== 0) {
      throw new Error(`IDrive engine could not encode a credential: ${result.stderr.trim()}`);
    }
    const encoded = result.stdout.match(/Encoded string=(.+)/)?.[1]?.trim();
    if (!encoded) {
      throw new Error("IDrive engine returned an invalid encoded credential");
    }
    return encoded;
  }

  public async execute(
    profile: StoredProfile,
    arguments_: readonly string[],
    timeoutMs = 2 * 60 * 60 * 1000,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ): Promise<CommandResult> {
    const directory = await this.verifyIntegrity();
    return await this.runUtf8(
      this.enginePath(profile.dedup, directory),
      arguments_,
      timeoutMs,
      signal,
      onProgress,
    );
  }

  private async runUtf8(
    executable: string,
    arguments_: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ): Promise<CommandResult> {
    await ensurePrivateDirectory(this.locations.temporaryDirectory);
    const workspace = await mkdtemp(
      path.join(this.locations.temporaryDirectory, "command-"),
    );
    try {
      const commandFile = path.join(workspace, "command.txt");
      await writeFile(path.join(workspace, ".owner"), `${process.pid}\n`, { mode: 0o600 });
      const contents = arguments_.map(safeArgument).join("\n");
      await writeFile(commandFile, `${contents}\n`, { mode: 0o600 });
      const parseProgress = onProgress ? createProgressParser(onProgress) : undefined;
      return await this.runner.run(executable, [`--utf8-cmd=${commandFile}`], {
        ...(parseProgress ? { onOutput: (_stream: "stderr" | "stdout", chunk: string) => parseProgress(chunk) } : {}),
        ...(signal ? { signal } : {}),
        timeoutMs,
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }

  private async verifyIntegrity(): Promise<string> {
    const manifest = JSON.parse(
      await readFile(this.locations.manifestFile, "utf8"),
    ) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest.sha256)) {
      throw new Error("Invalid IDrive engine manifest; run idrive-cli setup again");
    }
    const directory = activeDirectory(manifest, this.locations);

    for (const dedup of [false, true]) {
      const engineName = selectEngineName(dedup);
      const expected = manifest.sha256[engineName];
      if (typeof expected !== "string" || expected.length !== 64) {
        throw new Error(`Missing integrity hash for ${engineName}`);
      }
      const actual = createHash("sha256")
        .update(await readFile(this.enginePath(dedup, directory)))
        .digest("hex");
      if (actual !== expected) {
        throw new Error(`Integrity check failed for ${engineName}; run setup again`);
      }
    }
    return directory;
  }
}

export function createProgressParser(onProgress: (percent: number) => void): (chunk: string) => void {
  let lastPercent = -1;
  let tail = "";
  return (chunk: string): void => {
    const text = tail + chunk;
    tail = text.slice(-4);
    for (const match of text.matchAll(/\b(100|[1-9]?\d)%/g)) {
      const percent = Number(match[1]);
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress(percent);
      }
    }
  };
}

function activeDirectory(
  manifest: Record<string, unknown>,
  locations: AppLocations,
): string {
  if (typeof manifest.engineDirectory !== "string") {
    return locations.engineDirectory;
  }
  const dataDirectory = path.resolve(locations.dataDirectory);
  const candidate = path.resolve(dataDirectory, manifest.engineDirectory);
  if (candidate !== dataDirectory && !candidate.startsWith(`${dataDirectory}${path.sep}`)) {
    throw new Error("IDrive engine manifest points outside the data directory");
  }
  return candidate;
}

function safeArgument(value: string): string {
  if (/[\0\n\r]/.test(value)) {
    throw new Error("IDrive engine arguments cannot contain control characters");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
