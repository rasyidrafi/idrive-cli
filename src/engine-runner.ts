import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { selectEngineName } from "./engine-commands.js";
import type { AppLocations } from "./locations.js";
import type { CommandResult, CommandRunner } from "./process-runner.js";
import type { StoredProfile } from "./types.js";

export class EngineRunner {
  private integrityVerified = false;
  private activeEngineDirectory: string | undefined;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly locations: AppLocations,
  ) {}

  public enginePath(dedup: boolean): string {
    return path.join(
      this.activeEngineDirectory ?? this.locations.engineDirectory,
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

  public async encodeSecret(value: string): Promise<string> {
    await this.verifyIntegrity();
    const result = await this.runUtf8(this.enginePath(false), [
      `--string-encode=${safeArgument(value)}`,
    ], 30_000);
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
  ): Promise<CommandResult> {
    await this.verifyIntegrity();
    return await this.runUtf8(
      this.enginePath(profile.dedup),
      arguments_,
      timeoutMs,
    );
  }

  private async runUtf8(
    executable: string,
    arguments_: readonly string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    await mkdir(this.locations.temporaryDirectory, { mode: 0o700, recursive: true });
    const workspace = await mkdtemp(
      path.join(this.locations.temporaryDirectory, "command-"),
    );
    try {
      const commandFile = path.join(workspace, "command.txt");
      const contents = arguments_.map(safeArgument).join("\n");
      await writeFile(commandFile, `${contents}\n`, { mode: 0o600 });
      return await this.runner.run(executable, [`--utf8-cmd=${commandFile}`], {
        timeoutMs,
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }

  private async verifyIntegrity(): Promise<void> {
    if (this.integrityVerified) {
      return;
    }
    const manifest = JSON.parse(
      await readFile(this.locations.manifestFile, "utf8"),
    ) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest.sha256)) {
      throw new Error("Invalid IDrive engine manifest; run idrive-cloud setup again");
    }
    this.activeEngineDirectory = activeDirectory(manifest, this.locations);

    for (const dedup of [false, true]) {
      const engineName = selectEngineName(dedup);
      const expected = manifest.sha256[engineName];
      if (typeof expected !== "string" || expected.length !== 64) {
        throw new Error(`Missing integrity hash for ${engineName}`);
      }
      const actual = createHash("sha256")
        .update(await readFile(this.enginePath(dedup)))
        .digest("hex");
      if (actual !== expected) {
        throw new Error(`Integrity check failed for ${engineName}; run setup again`);
      }
    }
    this.integrityVerified = true;
  }
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
