import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppLocations } from "./locations.js";
import type { CommandRunner } from "./process-runner.js";
import { runChecked } from "./process-runner.js";
import {
  embeddedPayload,
  engineArchiveForArchitecture,
} from "./setup-extractor.js";

const engineNames = ["idevsutil_sync", "idevsutil_dedup_sync"] as const;

export interface EngineManifest {
  architecture: NodeJS.Architecture;
  engineDirectory: string;
  installedAt: string;
  packageVersion?: string;
  sha256: Record<(typeof engineNames)[number], string>;
  sourceSha256: string;
  sourcePackage: string;
}

export class EngineInstaller {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly locations: AppLocations,
  ) {}

  public async installFromDeb(debPath: string): Promise<EngineManifest> {
    const sourcePackage = path.resolve(debPath);
    const packageStat = await stat(sourcePackage);
    if (!packageStat.isFile()) {
      throw new Error(`Not a file: ${sourcePackage}`);
    }
    const previousEngineDirectory = await this.currentEngineDirectory();

    const workspace = await mkdtemp(path.join(os.tmpdir(), "idrive-cli-setup-"));
    try {
      const debDirectory = path.join(workspace, "deb");
      await mkdir(debDirectory, { recursive: true });
      await runChecked(this.runner, "dpkg-deb", ["-x", sourcePackage, debDirectory]);

      const wrapperPath = path.join(
        debDirectory,
        "opt",
        "IDriveForLinux",
        "resources",
        "app.asar.unpacked",
        "IdriveForLinux",
        "idriveforlinux.bin",
      );
      const wrapper = await readFile(wrapperPath);
      const payloadArchive = path.join(workspace, "payload.tar.gz");
      await writeFile(payloadArchive, embeddedPayload(wrapper), { mode: 0o600 });

      const payloadDirectory = path.join(workspace, "payload");
      await mkdir(payloadDirectory);
      await this.extractTrustedArchive(payloadArchive, payloadDirectory);

      const archiveName = engineArchiveForArchitecture(process.arch);
      const engineArchive = path.join(
        payloadDirectory,
        "IDriveForLinux",
        "bin",
        "Idrivelib",
        "dependencies",
        "evsbin",
        archiveName,
      );
      const enginePayloadDirectory = path.join(workspace, "engine");
      await mkdir(enginePayloadDirectory);
      await this.extractTrustedArchive(engineArchive, enginePayloadDirectory);

      const extractedDirectory = path.join(
        enginePayloadDirectory,
        archiveName.replace(/\.tar\.gz$/, ""),
      );
      const packageVersion = wrapper.subarray(0, 4096).toString("utf8")
        .match(/APPVERSION="([^"]+)"/)?.[1];
      const sourceSha256 = await hashFile(sourcePackage);
      const releasesDirectory = path.join(this.locations.dataDirectory, "releases");
      const releaseName = [
        packageVersion ?? "unknown",
        sourceSha256.slice(0, 12),
        randomUUID(),
      ].join("-");
      const releaseDirectory = path.join(releasesDirectory, releaseName);
      const stageDirectory = path.join(releasesDirectory, `.stage-${randomUUID()}`);
      const temporaryManifest = path.join(
        this.locations.dataDirectory,
        `.engine-${randomUUID()}.json`,
      );
      let committed = false;

      await mkdir(releasesDirectory, { mode: 0o700, recursive: true });
      await mkdir(stageDirectory, { mode: 0o700 });
      try {
        const hashes = {} as EngineManifest["sha256"];
        for (const engineName of engineNames) {
          const source = path.join(extractedDirectory, engineName);
          const destination = path.join(stageDirectory, engineName);
          await copyFile(source, destination);
          await chmod(destination, 0o755);
          hashes[engineName] = createHash("sha256")
            .update(await readFile(destination))
            .digest("hex");
        }

        const manifest: EngineManifest = {
          architecture: process.arch,
          engineDirectory: path.relative(
            this.locations.dataDirectory,
            releaseDirectory,
          ),
          installedAt: new Date().toISOString(),
          ...(packageVersion ? { packageVersion } : {}),
          sha256: hashes,
          sourceSha256,
          sourcePackage,
        };
        await rename(stageDirectory, releaseDirectory);
        await writeFile(
          temporaryManifest,
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        );
        await rename(temporaryManifest, this.locations.manifestFile);
        committed = true;
        await this.removePreviousEngine(previousEngineDirectory, releaseDirectory);
        await this.removePreviousEngine(this.locations.engineDirectory, releaseDirectory);
        return manifest;
      } finally {
        await rm(stageDirectory, { force: true, recursive: true });
        await rm(temporaryManifest, { force: true });
        if (!committed) {
          await rm(releaseDirectory, { force: true, recursive: true });
        }
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }

  private async extractTrustedArchive(
    archive: string,
    destination: string,
  ): Promise<void> {
    const listing = await runChecked(this.runner, "tar", ["-tzf", archive]);
    for (const entry of listing.stdout.split("\n").filter(Boolean)) {
      const normalized = path.posix.normalize(entry.replace(/^\.\//, ""));
      if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
        throw new Error(`Unsafe path in IDrive archive: ${entry}`);
      }
    }
    await runChecked(this.runner, "tar", ["-xzf", archive, "-C", destination]);
  }

  private async currentEngineDirectory(): Promise<string | undefined> {
    try {
      const manifest = JSON.parse(
        await readFile(this.locations.manifestFile, "utf8"),
      ) as unknown;
      if (isRecord(manifest) && typeof manifest.engineDirectory === "string") {
        return path.resolve(this.locations.dataDirectory, manifest.engineDirectory);
      }
      return this.locations.engineDirectory;
    } catch {
      return undefined;
    }
  }

  private async removePreviousEngine(
    previous: string | undefined,
    active: string,
  ): Promise<void> {
    if (!previous || path.resolve(previous) === path.resolve(active)) {
      return;
    }
    const dataDirectory = path.resolve(this.locations.dataDirectory);
    const candidate = path.resolve(previous);
    if (!candidate.startsWith(`${dataDirectory}${path.sep}`)) {
      return;
    }
    await rm(candidate, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
