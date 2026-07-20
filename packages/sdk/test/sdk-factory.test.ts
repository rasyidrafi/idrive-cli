import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudDriveClient,
  cleanupCloudDriveWorkspaces,
  createEngineInstaller,
  createCloudDriveClient,
  diagnoseCloudDriveEngine,
  IDriveAuthClient,
  IDriveError,
  IdDriveAuthClient,
  IdriveError,
  type AuthTransport,
  type IDriveErrorCode,
  type IdriveErrorCode,
  type ProfileStore,
  type TransferEngine,
} from "../src/index.js";
import type { StoredProfile } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

describe("createCloudDriveClient", () => {
  it("offers conventional aliases without breaking existing exported names", () => {
    expect(IDriveAuthClient).toBe(IdDriveAuthClient);
    expect(IDriveError).toBe(IdriveError);
    const canonicalCode: IDriveErrorCode = "usage";
    const legacyCode: IdriveErrorCode = canonicalCode;
    expect(legacyCode).toBe("usage");
  });

  it("creates a ready-to-use client with isolated legacy locations", async () => {
    const root = await temporaryDirectory();
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");

    const client = createCloudDriveClient({ configDirectory, dataDirectory });

    expect(client).toBeInstanceOf(CloudDriveClient);
    await expect(client.status()).resolves.toEqual({
      engineInstalled: false,
      loggedIn: false,
    });
  });

  it("loads an existing CLI profile from a custom configuration directory", async () => {
    const root = await temporaryDirectory();
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    const profile: StoredProfile = {
      dedup: false,
      email: "person@example.test",
      encodedPassword: "encoded-password",
      encodedPrivateKey: "encoded-key",
      encryptionType: "DEFAULT",
      server: "server.example.test",
      syncUsername: "sync-user",
    };
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDirectory, "config.json"), JSON.stringify(profile), { mode: 0o600 });

    const client = createCloudDriveClient({ configDirectory, dataDirectory });

    await expect(client.status()).resolves.toMatchObject({
      email: profile.email,
      loggedIn: true,
      server: profile.server,
    });
  });

  it("honors legacy location overrides from process.env by default", async () => {
    const root = await temporaryDirectory();
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    const profile: StoredProfile = {
      dedup: false,
      email: "environment@example.test",
      encodedPassword: "encoded-password",
      encodedPrivateKey: "encoded-key",
      encryptionType: "DEFAULT",
      server: "server.example.test",
      syncUsername: "sync-user",
    };
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDirectory, "config.json"), JSON.stringify(profile), { mode: 0o600 });
    vi.stubEnv("IDRIVE_CLI_CONFIG_DIR", configDirectory);
    vi.stubEnv("IDRIVE_CLI_DATA_DIR", dataDirectory);

    const client = createCloudDriveClient();

    await expect(client.status()).resolves.toMatchObject({
      email: profile.email,
      loggedIn: true,
    });
  });

  it("uses injected ports without replacing the public client contract", async () => {
    const profile: StoredProfile = {
      dedup: true,
      email: "injected@example.test",
      encodedPassword: "encoded-password",
      encodedPrivateKey: "encoded-key",
      encryptionType: "PRIVATE",
      server: "server.example.test",
      syncUsername: "sync-user",
    };
    const auth: AuthTransport = {
      authenticate: vi.fn(),
      linkMachine: vi.fn(),
    };
    const load = vi.fn().mockResolvedValue(profile);
    const isInstalled = vi.fn().mockResolvedValue(true);
    const profileStore: ProfileStore = {
      clear: vi.fn(),
      load,
      save: vi.fn(),
    };
    const transferEngine: TransferEngine = {
      encodeSecret: vi.fn(),
      execute: vi.fn(),
      isInstalled,
    };

    const client = createCloudDriveClient({ auth, profileStore, transferEngine });

    await expect(client.status()).resolves.toEqual({
      email: profile.email,
      engineInstalled: true,
      loggedIn: true,
      server: profile.server,
    });
    expect(load).toHaveBeenCalledOnce();
    expect(isInstalled).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous exact and directory location overrides", () => {
    expect(() => createCloudDriveClient({
      configDirectory: "/custom/config",
      locations: {
        configFile: "/exact/config.json",
        dataDirectory: "/exact/data",
        engineDirectory: "/exact/data/bin",
        manifestFile: "/exact/data/engine.json",
        temporaryDirectory: "/exact/data/tmp",
      },
    })).toThrow(/locations cannot be combined/i);
  });

  it("creates lifecycle helpers with the same resolved locations as the client", async () => {
    const root = await temporaryDirectory();
    const configDirectory = path.join(root, "config");
    const dataDirectory = path.join(root, "data");
    const workDirectory = path.join(root, "work");
    const commandRunner = { run: vi.fn() };

    const installer = createEngineInstaller({
      commandRunner,
      configDirectory,
      dataDirectory,
      temporaryDirectory: workDirectory,
    });

    expect(installer).toBeDefined();
    await expect(diagnoseCloudDriveEngine({
      commandRunner,
      configDirectory,
      dataDirectory,
      temporaryDirectory: workDirectory,
    })).resolves.toMatchObject({ installed: false });
    await expect(cleanupCloudDriveWorkspaces({
      configDirectory,
      dataDirectory,
      temporaryDirectory: workDirectory,
    }, 0)).resolves.toBe(0);
  });

  it("limits concurrent engine operations and cancels queued work", async () => {
    const profile = storedProfile();
    let releaseFirst: (() => void) | undefined;
    const firstOperation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (execute.mock.calls.length === 1) await firstOperation;
      if (report) await writeFile(report, '<tree message="SUCCESS"/>');
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = createCloudDriveClient({
      auth: { authenticate: vi.fn(), linkMachine: vi.fn() },
      locations: exactLocations(await temporaryDirectory()),
      maxConcurrentOperations: 1,
      profileStore: {
        clear: vi.fn(),
        load: vi.fn().mockResolvedValue(profile),
        save: vi.fn(),
      },
      transferEngine: {
        encodeSecret: vi.fn(),
        execute,
        isInstalled: vi.fn().mockResolvedValue(true),
      },
    });
    const queuedController = new AbortController();

    const first = client.list("/first", { retries: 1 });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const second = client.list("/second", { retries: 1, signal: queuedController.signal });
    queuedController.abort();

    await expect(second).rejects.toMatchObject({ code: "cancelled", operation: "list" });
    expect(execute).toHaveBeenCalledOnce();
    releaseFirst?.();
    await expect(first).resolves.toEqual([]);
    await expect(client.list("/third", { retries: 1 })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function storedProfile(): StoredProfile {
  return {
    dedup: false,
    email: "person@example.test",
    encodedPassword: "encoded-password",
    encodedPrivateKey: "encoded-key",
    encryptionType: "DEFAULT",
    server: "server.example.test",
    syncUsername: "sync-user",
  };
}

function exactLocations(root: string) {
  return {
    configFile: path.join(root, "config.json"),
    dataDirectory: root,
    engineDirectory: path.join(root, "bin"),
    manifestFile: path.join(root, "engine.json"),
    temporaryDirectory: path.join(root, "tmp"),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = path.join(tmpdir(), `idrive-sdk-factory-${process.pid}-${temporaryDirectories.length}`);
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
