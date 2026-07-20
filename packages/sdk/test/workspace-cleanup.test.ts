import { lutimes, mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cleanupStaleWorkspaces, prepareDownloadDirectory } from "../src/cloud-drive-client.js";

describe("cleanupStaleWorkspaces", () => {
  it("removes only stale owned workspace names without following symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idrive-cleanup-"));
    const outside = await mkdtemp(path.join(tmpdir(), "idrive-cleanup-outside-"));
    try {
      const locations = {
        configFile: path.join(root, "config.json"), dataDirectory: root,
        engineDirectory: path.join(root, "bin"), manifestFile: path.join(root, "engine.json"),
        temporaryDirectory: path.join(root, "tmp"),
      };
      await mkdir(path.join(locations.temporaryDirectory, "operation-old"), { recursive: true });
      await mkdir(path.join(locations.temporaryDirectory, "operation-new"));
      await mkdir(path.join(locations.temporaryDirectory, "operation-active"));
      await writeFile(path.join(locations.temporaryDirectory, "operation-active/.owner"), `${process.pid}\n`);
      await mkdir(path.join(locations.temporaryDirectory, "unrelated"));
      await symlink(outside, path.join(locations.temporaryDirectory, "command-link"));
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(path.join(locations.temporaryDirectory, "operation-old"), old, old);
      await utimes(path.join(locations.temporaryDirectory, "operation-active"), old, old);
      await lutimes(path.join(locations.temporaryDirectory, "command-link"), old, old);
      await expect(cleanupStaleWorkspaces(locations, 24 * 60 * 60 * 1000)).resolves.toBe(2);
      expect(await readdir(locations.temporaryDirectory)).toEqual(["operation-active", "operation-new", "unrelated"]);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects symlinks while creating recursive download directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idrive-download-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "idrive-download-outside-"));
    try {
      await symlink(outside, path.join(root, "Remote"));
      await expect(prepareDownloadDirectory(root, "Remote/Nested"))
        .rejects.toThrow(/unsafe/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });
});
