import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudDriveClient,
  type AuthTransport,
  type ProfileStore,
  type TransferEngine,
} from "../src/cloud-drive-client.js";
import type { AppLocations } from "../src/locations.js";
import type { StoredProfile } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("CloudDriveClient login", () => {
  it("stores encoded transfer credentials without the account password", async () => {
    const linkMachine = vi.fn();
    const auth: AuthTransport = {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          encryptionType: "DEFAULT",
          syncPassword: "raw-sync-password",
          syncUsername: "a1b2",
        },
        server: {
          accountType: "sync",
          dedup: false,
          encryptionType: "DEFAULT",
          serverDns: "server",
          webServerDns: "web",
        },
      }),
      linkMachine,
    };
    let savedProfile: StoredProfile | null = null;
    const store: ProfileStore = {
      clear: vi.fn(),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn((profile: StoredProfile) => {
        savedProfile = profile;
        return Promise.resolve();
      }),
    };
    const engine: TransferEngine = {
      encodeSecret: vi.fn((value: string) => Promise.resolve(`encoded:${value}`)),
      execute: vi.fn(),
      isInstalled: vi.fn().mockResolvedValue(true),
    };
    const client = new CloudDriveClient(auth, store, engine, await locations());

    const result = await client.login("person@example.test", "account-password", {
      linkMachine: false,
    });

    expect(result).toEqual(savedProfile);
    expect(JSON.stringify(savedProfile)).not.toContain("account-password");
    expect(result.encodedPassword).toBe("encoded:raw-sync-password");
    expect(linkMachine).not.toHaveBeenCalled();
  });

  it("requests a private key only for private-encryption accounts", async () => {
    const encodeSecret = vi.fn((value: string) => Promise.resolve(`encoded:${value}`));
    const auth: AuthTransport = {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          encryptionType: "PRIVATE",
          syncPassword: "sync-password",
          syncUsername: "a1b2",
        },
        server: {
          accountType: "sync",
          dedup: true,
          encryptionType: "PRIVATE",
          serverDns: "server",
          webServerDns: "web",
        },
      }),
      linkMachine: vi.fn(),
    };
    const store: ProfileStore = {
      clear: vi.fn(),
      load: vi.fn(),
      save: vi.fn(),
    };
    const execute = vi.fn(async (
      _profile: StoredProfile,
      arguments_: readonly string[],
    ) => {
      const reportFile = arguments_.find((argument) => argument.startsWith("--o="))
        ?.slice(4);
      if (reportFile) {
        await writeFile(reportFile, '<quota totalquota="1000" usedquota="250" />');
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const engine: TransferEngine = {
      encodeSecret,
      execute,
      isInstalled: vi.fn().mockResolvedValue(true),
    };
    const provider = vi.fn().mockResolvedValue("private-key");
    const client = new CloudDriveClient(auth, store, engine, await locations());

    await client.login("person@example.test", "password", {
      linkMachine: false,
      privateKeyProvider: provider,
    });

    expect(provider).toHaveBeenCalledOnce();
    expect(encodeSecret).toHaveBeenCalledWith("private-key");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not save or link a private account when its key cannot be verified", async () => {
    const save = vi.fn();
    const linkMachine = vi.fn();
    const auth: AuthTransport = {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          encryptionType: "PRIVATE",
          syncPassword: "sync-password",
          syncUsername: "a1b2",
        },
        server: {
          accountType: "sync",
          dedup: false,
          encryptionType: "PRIVATE",
          serverDns: "server",
          webServerDns: "web",
        },
      }),
      linkMachine,
    };
    const store: ProfileStore = {
      clear: vi.fn(),
      load: vi.fn().mockResolvedValue(null),
      save,
    };
    const engine: TransferEngine = {
      encodeSecret: vi.fn((value: string) => Promise.resolve(`encoded:${value}`)),
      execute: vi.fn().mockResolvedValue({
        code: 5,
        stderr: "invalid private key",
        stdout: "",
      }),
      isInstalled: vi.fn().mockResolvedValue(true),
    };
    const client = new CloudDriveClient(auth, store, engine, await locations());

    await expect(client.login("person@example.test", "password", {
      privateKeyProvider: vi.fn().mockResolvedValue("wrong-key"),
    })).rejects.toThrow(/private encryption key could not be verified/i);
    expect(save).not.toHaveBeenCalled();
    expect(linkMachine).not.toHaveBeenCalled();
  });

  it("rolls back the local profile when remote device linking fails", async () => {
    const linkMachine = vi.fn().mockRejectedValue(new Error("link failed"));
    const auth: AuthTransport = {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          encryptionType: "DEFAULT",
          syncPassword: "sync-password",
          syncUsername: "a1b2",
        },
        server: {
          accountType: "sync",
          dedup: false,
          encryptionType: "DEFAULT",
          serverDns: "server",
          webServerDns: "web",
        },
      }),
      linkMachine,
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    const store: ProfileStore = {
      clear,
      load: vi.fn(),
      save,
    };
    const engine: TransferEngine = {
      encodeSecret: vi.fn((value: string) => Promise.resolve(`encoded:${value}`)),
      execute: vi.fn(),
      isInstalled: vi.fn().mockResolvedValue(true),
    };
    const client = new CloudDriveClient(auth, store, engine, await locations());

    await expect(client.login("person@example.test", "password"))
      .rejects.toThrow("link failed");
    expect(save).toHaveBeenCalledOnce();
    expect(linkMachine).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      linkMachine.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("restores an existing profile when re-login linking fails", async () => {
    const previous = storedProfile();
    const saved: StoredProfile[] = [];
    const clear = vi.fn();
    const store: ProfileStore = {
      clear,
      load: vi.fn().mockResolvedValue(previous),
      save: vi.fn((profile: StoredProfile) => {
        saved.push(profile);
        return Promise.resolve();
      }),
    };
    const auth: AuthTransport = {
      authenticate: vi.fn().mockResolvedValue({
        account: {
          encryptionType: "DEFAULT",
          syncPassword: "new-sync-password",
          syncUsername: "new-user",
        },
        server: {
          accountType: "sync",
          dedup: false,
          encryptionType: "DEFAULT",
          serverDns: "new-server",
          webServerDns: "new-web",
        },
      }),
      linkMachine: vi.fn().mockRejectedValue(new Error("temporary link failure")),
    };
    const engine: TransferEngine = {
      encodeSecret: vi.fn((value: string) => Promise.resolve(`encoded:${value}`)),
      execute: vi.fn(),
      isInstalled: vi.fn().mockResolvedValue(true),
    };
    const client = new CloudDriveClient(auth, store, engine, await locations());

    await expect(client.login("new@example.test", "password"))
      .rejects.toThrow("temporary link failure");
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).toEqual(previous);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("CloudDriveClient file operations", () => {
  it("uploads, lists, downloads, creates directories, and reads quota", async () => {
    const appLocations = await locations();
    const profile = storedProfile();
    const store = profileStore(profile);
    const execute = vi.fn(async (
      _profile: StoredProfile,
      arguments_: readonly string[],
    ) => {
      const reportFile = arguments_.find((argument) => argument.startsWith("--o="))
        ?.slice(4);
      if (arguments_.includes("--auth-list") && reportFile) {
        await writeFile(reportFile, '<item restype="F" fname="movie.mp4" size="42" />');
      }
      if (arguments_.includes("--get-quota") && reportFile) {
        await writeFile(reportFile, '<quota totalquota="1000" usedquota="250" />');
      }
      if (arguments_.includes("--add-progress")) {
        const fileList = arguments_.find((argument) => argument.startsWith("--files-from="))
          ?.slice("--files-from=".length);
        const destination = arguments_.at(-1);
        if (fileList && destination) {
          const remoteFile = (await readFile(fileList, "utf8")).trim().replace(/^\//, "");
          const target = path.join(destination, remoteFile);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, "download fixture", { mode: 0o777 });
        }
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(
      unusedAuth(),
      store,
      transferEngine(execute),
      appLocations,
    );
    const localFile = path.join(appLocations.dataDirectory, "movie.mp4");
    await writeFile(localFile, "video fixture");

    await client.upload(localFile, "/Videos");
    expect(await client.list("/Videos")).toEqual([
      { name: "movie.mp4", size: 42, type: "file" },
    ]);
    const downloaded = await client.download(
      "/Videos/movie.mp4",
      appLocations.dataDirectory,
    );
    expect(downloaded).toBe(path.join(appLocations.dataDirectory, "Videos/movie.mp4"));
    expect((await stat(downloaded)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(downloaded))).mode & 0o777).toBe(0o700);
    const existingDirectory = path.join(appLocations.dataDirectory, "Existing");
    await mkdir(existingDirectory, { mode: 0o750 });
    const secondDownload = await client.download(
      "/Existing/second.mp4",
      appLocations.dataDirectory,
    );
    expect((await stat(secondDownload)).mode & 0o777).toBe(0o600);
    expect((await stat(existingDirectory)).mode & 0o777).toBe(0o750);
    const longName = `${"a".repeat(240)}.mp4`;
    const longDownload = await client.download(
      `/${longName}`,
      appLocations.dataDirectory,
    );
    expect(path.basename(longDownload)).toBe(longName);
    expect((await stat(longDownload)).mode & 0o777).toBe(0o600);
    await client.createDirectory("/Videos/Uploads");
    await client.remove("/Videos/Uploads");
    await client.purgeTrash("/Videos/Uploads");
    await expect(client.remove("/")).rejects.toThrow(/refusing to delete/i);
    await expect(client.purgeTrash("/")).rejects.toThrow(/refusing to delete/i);
    expect(await client.quota()).toEqual({ total: 1000, used: 250 });

    const commands = execute.mock.calls.map((call) => call[1]);
    expect(commands.some((command) => command.includes("--auth-list"))).toBe(true);
    expect(commands.some((command) => command.includes("--get-quota"))).toBe(true);
    expect(commands.some((command) => command.includes("--delete-items"))).toBe(true);
    expect(commands.some((command) => command.includes("--deletefrom-trash"))).toBe(true);
    expect(commands.some((command) =>
      command.includes("a1b2@server::ibackup/Videos/"))).toBe(true);
    expect(await readdir(appLocations.temporaryDirectory)).toEqual([]);
  });

  it("surfaces engine error reports", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (
      _profile: StoredProfile,
      arguments_: readonly string[],
    ) => {
      const errorFile = arguments_.find((argument) => argument.startsWith("--e="))
        ?.slice(4);
      if (errorFile) {
        await writeFile(errorFile, '<item op_status="failed" desc="permission denied" />');
      }
      return { code: 23, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(storedProfile()),
      transferEngine(execute),
      appLocations,
    );

    await expect(client.createDirectory("/Videos"))
      .rejects.toThrow(/permission denied/i);
    expect(await readdir(appLocations.temporaryDirectory)).toEqual([]);
  });

  it("retries IDrive's explicit transient quota response", async () => {
    const appLocations = await locations();
    let attempt = 0;
    const execute = vi.fn(async (
      _profile: StoredProfile,
      arguments_: readonly string[],
    ) => {
      attempt++;
      const reportFile = arguments_.find((argument) => argument.startsWith("--o="))
        ?.slice(4);
      const errorFile = arguments_.find((argument) => argument.startsWith("--e="))
        ?.slice(4);
      if (attempt === 1 && errorFile) {
        await writeFile(
          errorFile,
          'connection established\n<tree message="ERROR" desc="Unable to retrieve the quota. Try again."/>',
        );
      } else if (reportFile) {
        await writeFile(reportFile, '<quota totalquota="1000" usedquota="250" />');
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(storedProfile()),
      transferEngine(execute),
      appLocations,
    );

    await expect(client.quota()).resolves.toEqual({ total: 1000, used: 250 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects symlinks in the destination hierarchy", async () => {
    const appLocations = await locations();
    const outside = await mkdtemp(path.join(tmpdir(), "idrive-outside-test-"));
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(appLocations.dataDirectory, "Unsafe"));
    const execute = vi.fn(async (
      _profile: StoredProfile,
      arguments_: readonly string[],
    ) => {
      const fileList = arguments_.find((argument) => argument.startsWith("--files-from="))
        ?.slice("--files-from=".length);
      const destination = arguments_.at(-1);
      if (fileList && destination) {
        const remoteFile = (await readFile(fileList, "utf8")).trim().replace(/^\//, "");
        const target = path.join(destination, remoteFile);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "download fixture");
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(storedProfile()),
      transferEngine(execute),
      appLocations,
    );

    await expect(client.download("/Unsafe/movie.mp4", appLocations.dataDirectory))
      .rejects.toThrow(/unsafe download destination component/i);
    expect(await readdir(outside)).toEqual([]);
  });
});

async function locations(): Promise<AppLocations> {
  const directory = await mkdtemp(path.join(tmpdir(), "idrive-client-test-"));
  temporaryDirectories.push(directory);
  return {
    configFile: path.join(directory, "config.json"),
    dataDirectory: directory,
    engineDirectory: path.join(directory, "bin"),
    manifestFile: path.join(directory, "engine.json"),
    temporaryDirectory: path.join(directory, "tmp"),
  };
}

function storedProfile(): StoredProfile {
  return {
    dedup: false,
    email: "person@example.test",
    encodedPassword: "encoded-password",
    encodedPrivateKey: "encoded-key",
    encryptionType: "DEFAULT",
    server: "server",
    syncUsername: "a1b2",
  };
}

function profileStore(profile: StoredProfile): ProfileStore {
  return {
    clear: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(profile),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function unusedAuth(): AuthTransport {
  return {
    authenticate: vi.fn(),
    linkMachine: vi.fn(),
  };
}

function transferEngine(
  execute: TransferEngine["execute"],
): TransferEngine {
  return {
    encodeSecret: vi.fn(),
    execute,
    isInstalled: vi.fn().mockResolvedValue(true),
  };
}
