import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  lstat,
  open,
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
import { withFileLock } from "./file-lock.js";

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

  public async installFromDeb(debPath: string, signal?: AbortSignal): Promise<EngineManifest> {
    return await withFileLock(
      `${this.locations.manifestFile}.lock`,
      async () => await this.installUnlocked(debPath, signal),
      { ...(signal ? { signal } : {}), staleMs: 24 * 60 * 60 * 1000, timeoutMs: 2 * 60 * 1000 },
    );
  }

  private async installUnlocked(debPath: string, signal?: AbortSignal): Promise<EngineManifest> {
    const sourcePackage = path.resolve(debPath);
    const packageStat = await lstat(sourcePackage);
    if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
      throw new Error(`Not a file: ${sourcePackage}`);
    }
    if (packageStat.size > 2 * 1024 * 1024 * 1024) {
      throw new Error("IDrive package exceeds the 2 GiB size limit");
    }
    const workspace = await mkdtemp(path.join(os.tmpdir(), "idrive-cli-setup-"));
    try {
      const packageSnapshot = path.join(workspace, "IDriveForLinux.deb");
      await snapshotPackage(sourcePackage, packageSnapshot, packageStat, signal);
      const sourceSha256 = await hashFile(packageSnapshot, signal);
      const debDirectory = path.join(workspace, "deb");
      await mkdir(debDirectory, { recursive: true });
      const debListing = await runInstallerCommand(this.runner, "dpkg-deb", ["-c", packageSnapshot], signal);
      validateArchiveTypes(debListing.stdout);
      await runInstallerCommand(this.runner, "dpkg-deb", ["-x", packageSnapshot, debDirectory], signal);

      const wrapperPath = path.join(
        debDirectory,
        "opt",
        "IDriveForLinux",
        "resources",
        "app.asar.unpacked",
        "IdriveForLinux",
        "idriveforlinux.bin",
      );
      const wrapperStat = await lstat(wrapperPath);
      if (wrapperStat.isSymbolicLink() || !wrapperStat.isFile() || wrapperStat.size > 512 * 1024 * 1024) {
        throw new Error("IDrive package contains an invalid or oversized wrapper");
      }
      const wrapper = await readFile(wrapperPath);
      const payloadArchive = path.join(workspace, "payload.tar.gz");
      await writeFile(payloadArchive, embeddedPayload(wrapper), { mode: 0o600 });

      const payloadDirectory = path.join(workspace, "payload");
      await mkdir(payloadDirectory);
      await this.extractTrustedArchive(payloadArchive, payloadDirectory, signal);

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
      await this.extractTrustedArchive(engineArchive, enginePayloadDirectory, signal);

      const extractedDirectory = path.join(
        enginePayloadDirectory,
        archiveName.replace(/\.tar\.gz$/, ""),
      );
      const packageVersion = wrapper.subarray(0, 4096).toString("utf8")
        .match(/APPVERSION="([^"]+)"/)?.[1];
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
        signal?.throwIfAborted();
        await rename(stageDirectory, releaseDirectory);
        await writeFile(
          temporaryManifest,
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        );
        signal?.throwIfAborted();
        await rename(temporaryManifest, this.locations.manifestFile);
        committed = true;
        // Releases are immutable. Keeping the previous one avoids racing active clients.
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
    signal?: AbortSignal,
  ): Promise<void> {
    const [listing, verboseListing] = await Promise.all([
      runInstallerCommand(this.runner, "tar", ["-tzf", archive], signal),
      runInstallerCommand(this.runner, "tar", ["-tvzf", archive], signal),
    ]);
    validateArchiveTypes(verboseListing.stdout);
    for (const entry of listing.stdout.split("\n").filter(Boolean)) {
      const normalized = path.posix.normalize(entry.replace(/^\.\//, ""));
      if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
        throw new Error(`Unsafe path in IDrive archive: ${entry}`);
      }
    }
    await runInstallerCommand(this.runner, "tar", [
      "-xzf", archive,
      "--no-same-owner",
      "--no-same-permissions",
      "-C", destination,
    ], signal);
  }

}

async function runInstallerCommand(
  runner: CommandRunner,
  file: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): ReturnType<typeof runChecked> {
  return runChecked(runner, file, arguments_, signal ? { signal } : undefined);
}

export function validateArchiveTypes(listing: string): void {
  const entries = listing.split("\n").filter(Boolean);
  if (entries.length > 10_000) {
    throw new Error("IDrive archive contains too many entries");
  }
  let totalSize = 0;
  for (const entry of entries) {
    const type = entry[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Unsafe archive entry type: ${type ?? "unknown"}`);
    }
    const size = entry.match(/^\S+\s+\S+\s+(\d+)\s/)?.[1];
    if (!size) throw new Error("Unable to validate IDrive archive entry size");
    const parsedSize = Number(size);
    if (!Number.isSafeInteger(parsedSize) || parsedSize > 1024 * 1024 * 1024) {
      throw new Error("IDrive archive entry exceeds the 1 GiB size limit");
    }
    totalSize += parsedSize;
    if (totalSize > 4 * 1024 * 1024 * 1024) {
      throw new Error("IDrive archive exceeds the 4 GiB expanded size limit");
    }
  }
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function snapshotPackage(
  source: string,
  destination: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const actual = await sourceHandle.stat();
    if (!samePackageSource(actual, expected)) {
      throw new Error("IDrive package changed before it could be snapshotted");
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      signal ? { signal } : {},
    );
    const [after, destinationStat] = await Promise.all([sourceHandle.stat(), lstat(destination)]);
    if (!samePackageSource(after, expected) || destinationStat.size !== expected.size) {
      throw new Error("IDrive package changed while it was being snapshotted");
    }
    const destinationHandle = await open(destination, "r");
    try { await destinationHandle.sync(); } finally { await destinationHandle.close(); }
  } finally {
    await sourceHandle.close();
  }
}

function samePackageSource(
  actual: Awaited<ReturnType<typeof lstat>>,
  expected: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return actual.isFile()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs;
}
