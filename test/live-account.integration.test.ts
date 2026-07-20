import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IdDriveAuthClient } from "../src/auth-client.js";
import { CloudDriveClient } from "../src/cloud-drive-client.js";
import { ConfigStore } from "../src/config-store.js";
import { EngineRunner } from "../src/engine-runner.js";
import { defaultLocations } from "../src/locations.js";
import { ProcessRunner } from "../src/process-runner.js";

const liveEnabled = process.env.IDRIVE_LIVE_TEST === "1";
const liveMp4 = process.env.IDRIVE_LIVE_MP4;
const expectedEmail = process.env.IDRIVE_LIVE_EXPECT_EMAIL;
const suite = liveEnabled ? describe.sequential : describe.skip;
const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const remoteDirectory = `Codex-CLI-Live-Test-${timestamp}-${process.pid}`;
const nestedDirectory = `${remoteDirectory}/Nested Videos`;
const locations = defaultLocations();
const runner = new ProcessRunner();
const client = new CloudDriveClient(
  new IdDriveAuthClient(),
  new ConfigStore(locations.configFile),
  new EngineRunner(runner, locations),
  locations,
);

let localDirectory = "";
let notesFile = "";
let longFile = "";
let longName = "";
let batchDirectory = "";
let batchAlpha = "";
let batchBeta = "";
let specialDirectory = "";
let specialNames: string[] = [];
let quotaBefore = 0;
let accountVerified = false;
let remoteCreated = false;
let remoteMutationAttempted = false;

suite("authenticated IDrive Cloud Drive transport", () => {
  beforeAll(async () => {
    if (!liveMp4) {
      throw new Error("IDRIVE_LIVE_MP4 must point to a local MP4 fixture");
    }
    if (!expectedEmail) {
      throw new Error("IDRIVE_LIVE_EXPECT_EMAIL is required");
    }
    const status = await client.status();
    if (!status.loggedIn || status.email !== expectedEmail) {
      throw new Error(
        `Refusing live mutations: expected ${expectedEmail}, found ${status.email ?? "no login"}`,
      );
    }
    accountVerified = true;
    const mp4Stat = await stat(liveMp4);
    if (!mp4Stat.isFile()) {
      throw new Error(`MP4 fixture is not a file: ${liveMp4}`);
    }
    localDirectory = await mkdtemp(path.join(tmpdir(), "idrive-live-suite-"));
    notesFile = path.join(localDirectory, "notes with spaces.txt");
    longName = `${"l".repeat(220)}.txt`;
    longFile = path.join(localDirectory, longName);
    batchDirectory = path.join(localDirectory, "batch-source");
    batchAlpha = path.join(batchDirectory, "alpha.txt");
    batchBeta = path.join(batchDirectory, "nested", "beta.txt");
    specialDirectory = path.join(localDirectory, "special-source");
    specialNames = [
      "zero-byte.bin",
      "café-文件.txt",
      'quote "and"\ttab.txt',
      " leading-space.txt",
      "unsupported-trailing-space.txt ",
    ];
    await mkdir(path.dirname(batchBeta), { recursive: true });
    await mkdir(specialDirectory);
    await writeFile(notesFile, "IDrive live test version one\n", { mode: 0o600 });
    await writeFile(longFile, "long filename fixture\n", { mode: 0o600 });
    await writeFile(batchAlpha, "batch alpha\n", { mode: 0o600 });
    await writeFile(batchBeta, "batch beta\n", { mode: 0o600 });
    for (const [index, name] of specialNames.entries()) {
      await writeFile(path.join(specialDirectory, name), index === 0 ? "" : `special ${index}\n`, { mode: 0o600 });
    }
    process.stdout.write(`\nLive remote directory: /${remoteDirectory}\n`);
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (accountVerified && remoteMutationAttempted) {
        if (!remoteCreated) {
          for (let attempt = 0; attempt < 10; attempt++) {
            const rootEntries = await client.list("/");
            remoteCreated = rootEntries.some(
              (entry) => entry.name === remoteDirectory,
            );
            if (remoteCreated) break;
            await delay(500);
          }
        }
      }
      if (accountVerified && remoteCreated) {
        let removeError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client.remove(remoteDirectory);
            removeError = undefined;
            break;
          } catch (error) {
            removeError = error;
            const rootEntries = await client.list("/");
            if (!rootEntries.some((entry) => entry.name === remoteDirectory)) {
              removeError = undefined;
              break;
            }
            await delay(500 * (attempt + 1));
          }
        }
        if (removeError) {
          throw removeError instanceof Error ? removeError : new Error("Live removal failed with a non-Error value");
        }
        let purgeError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client.purgeTrash(remoteDirectory);
            purgeError = undefined;
            break;
          } catch (error) {
            purgeError = error;
            await delay(500 * (attempt + 1));
          }
        }
        if (purgeError) {
          throw purgeError instanceof Error
            ? purgeError
            : new Error("Live trash purge failed with a non-Error value");
        }
        for (let attempt = 0; attempt < 10; attempt++) {
          const rootEntries = await client.list("/");
          if (!rootEntries.some((entry) => entry.name === remoteDirectory)) {
            remoteCreated = false;
            break;
          }
          await delay(500);
        }
        if (remoteCreated) {
          throw new Error(`Live cleanup did not remove /${remoteDirectory}`);
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    if (localDirectory) {
      await rm(localDirectory, { force: true, recursive: true });
    }
    if (cleanupError) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Live cleanup failed with a non-Error value");
    }
  });

  it("starts with an installed engine and authenticated profile", async () => {
    const status = await client.status();
    expect(status.engineInstalled).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.email).toBe(expectedEmail);
    const quota = await quotaEventually();
    expect(quota.total).toBeGreaterThan(0);
    quotaBefore = quota.used;
  });

  it("creates top-level and nested directories", async () => {
    remoteMutationAttempted = true;
    await client.createDirectory(remoteDirectory);
    remoteCreated = true;
    await client.createDirectory(nestedDirectory);
  });

  it("uploads files with spaces, a long basename, and MP4 content", async () => {
    await client.upload(notesFile, remoteDirectory);
    await client.upload(longFile, remoteDirectory);
    await client.upload(liveMp4 ?? "", nestedDirectory);
  }, 3 * 60_000);

  it("lists uploaded files at both directory levels", async () => {
    const topLevel = await client.list(remoteDirectory);
    expect(topLevel).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: path.basename(notesFile), type: "file" }),
      expect.objectContaining({ name: longName, type: "file" }),
      expect.objectContaining({ name: "Nested Videos", type: "directory" }),
    ]));

    const nested = await client.list(nestedDirectory);
    expect(nested).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: path.basename(liveMp4 ?? ""),
        size: (await stat(liveMp4 ?? "")).size,
        type: "file",
      }),
    ]));
  });

  it("supports stat, recursive listings, and empty directories", async () => {
    const emptyDirectory = `${remoteDirectory}/Empty Folder`;
    await client.createDirectory(emptyDirectory);
    await expect(client.stat(`${remoteDirectory}/${path.basename(notesFile)}`))
      .resolves.toMatchObject({ name: path.basename(notesFile), type: "file" });
    await expect(client.stat(`${remoteDirectory}/missing-stat.txt`)).resolves.toBeNull();
    const recursive = await client.listRecursive(remoteDirectory);
    expect(recursive).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: emptyDirectory, type: "directory" }),
      expect.objectContaining({ path: nestedDirectory, type: "directory" }),
    ]));
    await expect(client.list(emptyDirectory)).resolves.toEqual([]);
  });

  it("round-trips batch uploads and downloads", async () => {
    await client.uploadBatch(batchDirectory, ["alpha.txt", "nested/beta.txt"], remoteDirectory);
    const nestedBatch = await client.list(`${remoteDirectory}/nested`);
    expect(nestedBatch).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "beta.txt", type: "file" }),
    ]));
    const destination = path.join(localDirectory, "batch-download");
    const downloaded = await client.downloadBatch([
      `${remoteDirectory}/alpha.txt`,
      `${remoteDirectory}/nested/beta.txt`,
    ], destination);
    expect(downloaded).toHaveLength(2);
    expect(await sha256(downloaded[0] ?? "")).toBe(await sha256(batchAlpha));
    expect(await sha256(downloaded[1] ?? "")).toBe(await sha256(batchBeta));
  }, 3 * 60_000);

  it("supports concurrent download batches and dry-run without mutation", async () => {
    const destination = path.join(localDirectory, "concurrent-download");
    const [alpha, beta] = await Promise.all([
      client.downloadBatch([`${remoteDirectory}/alpha.txt`], destination),
      client.downloadBatch([`${remoteDirectory}/nested/beta.txt`], destination),
    ]);
    expect(await sha256(alpha[0] ?? "")).toBe(await sha256(batchAlpha));
    expect(await sha256(beta[0] ?? "")).toBe(await sha256(batchBeta));

    const dryDirectory = `${remoteDirectory}/Dry Run Must Not Exist`;
    await client.createDirectory(dryDirectory, { dryRun: true });
    await client.uploadBatch(batchDirectory, ["alpha.txt"], dryDirectory, { dryRun: true });
    expect(await client.stat(dryDirectory)).toBeNull();
  }, 3 * 60_000);

  it("preserves zero-byte, Unicode, quotes, tabs, and edge spaces", async () => {
    const supportedNames = specialNames.filter((name) => !/\s$/.test(name));
    await expect(client.uploadBatch(
      specialDirectory,
      ["unsupported-trailing-space.txt "],
      remoteDirectory,
    )).rejects.toThrow(/ending in whitespace/i);
    await client.uploadBatch(specialDirectory, supportedNames, remoteDirectory);
    const listed = await client.list(remoteDirectory);
    for (const name of supportedNames) {
      expect(listed.some((entry) => entry.name === name)).toBe(true);
    }
    const destination = path.join(localDirectory, "special-download");
    const downloaded = await client.downloadBatch(
      supportedNames.map((name) => `${remoteDirectory}/${name}`),
      destination,
    );
    for (const [index, file] of downloaded.entries()) {
      expect(await sha256(file)).toBe(await sha256(path.join(specialDirectory, supportedNames[index] ?? "")));
    }
  }, 3 * 60_000);

  it("downloads files with matching checksums and private modes", async () => {
    const downloadRoot = path.join(localDirectory, "downloads");
    const downloadedNotes = await client.download(
      `/${remoteDirectory}/${path.basename(notesFile)}`,
      downloadRoot,
    );
    const downloadedMp4 = await client.download(
      `/${nestedDirectory}/${path.basename(liveMp4 ?? "")}`,
      downloadRoot,
    );

    expect(await sha256(downloadedNotes)).toBe(await sha256(notesFile));
    expect(await sha256(downloadedMp4)).toBe(await sha256(liveMp4 ?? ""));
    expect((await stat(downloadedNotes)).mode & 0o777).toBe(0o600);
    expect((await stat(downloadedMp4)).mode & 0o777).toBe(0o600);
  }, 3 * 60_000);

  it("overwrites an existing remote file with the latest content", async () => {
    await writeFile(
      notesFile,
      "IDrive live test version two with replacement content\n",
      { mode: 0o600 },
    );
    await client.upload(notesFile, remoteDirectory);
    const downloaded = await client.download(
      `/${remoteDirectory}/${path.basename(notesFile)}`,
      path.join(localDirectory, "overwrite-download"),
    );
    expect(await sha256(downloaded)).toBe(await sha256(notesFile));
  }, 3 * 60_000);

  it("round-trips a long valid basename", async () => {
    const downloaded = await client.download(
      `/${remoteDirectory}/${longName}`,
      path.join(localDirectory, "long-download"),
    );
    expect(path.basename(downloaded)).toBe(longName);
    expect(await sha256(downloaded)).toBe(await sha256(longFile));
  });

  it("rejects a missing remote file without publishing output", async () => {
    const missingRoot = path.join(localDirectory, "missing-download");
    await expect(client.download(
      `/${remoteDirectory}/missing-${Date.now()}.bin`,
      missingRoot,
    )).rejects.toThrow();
    expect(await readdir(missingRoot, { recursive: true })).toEqual([]);
  });

  it("reports quota or IDrive's explicit post-upload temporary error", async () => {
    try {
      const quota = await client.quota();
      expect(quota.used).toBeGreaterThanOrEqual(quotaBefore);
      expect(quota.used).toBeLessThanOrEqual(quota.total);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /Unable to retrieve the quota\. Try again\./i,
      );
    }
  });
});

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function quotaEventually(): Promise<{ total: number; used: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.quota();
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/Unable to retrieve the quota\. Try again\./i.test(error.message)) {
        throw error;
      }
      await delay(2_000 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("IDrive quota remained unavailable");
}
