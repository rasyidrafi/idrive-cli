import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config-store.js";
import type { StoredProfile } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { force: true, recursive: true }),
      );
    }),
  );
});

describe("ConfigStore", () => {
  it("stores only transfer credentials in a mode-0600 file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-cli-config-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "config.json");
    const store = new ConfigStore(file);
    const profile: StoredProfile = {
      dedup: false,
      email: "person@example.test",
      encodedPassword: "encoded-sync-password",
      encodedPrivateKey: "encoded-default-key",
      encryptionType: "DEFAULT",
      server: "sync.example.test",
      syncUsername: "a1b2c3",
    };

    await store.save(profile);

    expect(await store.load()).toEqual(profile);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain("account-password");
  });

  it("returns null when no profile exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-cli-config-"));
    temporaryDirectories.push(directory);
    await expect(new ConfigStore(path.join(directory, "missing.json")).load())
      .resolves.toBeNull();
  });

  it("rejects symlinked and overly permissive profiles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-cli-config-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "target.json");
    const file = path.join(directory, "config.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, file);
    await expect(new ConfigStore(file).load()).rejects.toThrow(/unsafe/i);
    await import("node:fs/promises").then(({ rm }) => rm(file));
    await writeFile(file, "{}", { mode: 0o644 });
    await chmod(file, 0o644);
    await expect(new ConfigStore(file).load()).rejects.toThrow(/permissions/i);
  });

  it("serializes concurrent saves without leaving temporary files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-cli-config-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "config.json");
    const store = new ConfigStore(file);
    const profiles = Array.from({ length: 20 }, (_, index): StoredProfile => ({
      dedup: false,
      email: `person-${index}@example.test`,
      encodedPassword: "password",
      encodedPrivateKey: "key",
      encryptionType: "DEFAULT",
      server: "server",
      syncUsername: `user-${index}`,
    }));
    await Promise.all(profiles.map((profile) => store.save(profile)));
    expect(profiles).toContainEqual(await store.load());
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    expect(names).toEqual(["config.json"]);
  });
});
