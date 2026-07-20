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
import { IdriveError } from "../src/errors.js";

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

  it("does not mutate the local profile when remote device linking fails", async () => {
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
    expect(save).not.toHaveBeenCalled();
    expect(linkMachine).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });

  it("leaves an existing profile untouched when re-login linking fails", async () => {
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
    expect(saved).toHaveLength(0);
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

  it("retries transient list reports but not malformed reports", async () => {
    const appLocations = await locations();
    let attempt = 0;
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      attempt++;
      const reportFile = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (reportFile) {
        await writeFile(reportFile, attempt === 1
          ? "<tree desc='temporarily unavailable' message='ERROR'/>"
          : '<item restype="F" fname="ready.txt" size="1"/>');
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);
    await expect(client.list("/Retry")).resolves.toEqual([
      { name: "ready.txt", size: 1, type: "file" },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);

    const malformed = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const reportFile = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (reportFile) await writeFile(reportFile, "<garbage/>");
      return { code: 0, stderr: "", stdout: "" };
    });
    const malformedClient = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(malformed), appLocations);
    await expect(malformedClient.list("/Malformed")).rejects.toThrow(/invalid/i);
    expect(malformed).toHaveBeenCalledOnce();
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

  it("uses one engine invocation for batch uploads and downloads", async () => {
    const appLocations = await locations();
    const localRoot = path.join(appLocations.dataDirectory, "batch-source");
    await mkdir(path.join(localRoot, "nested"), { recursive: true });
    await writeFile(path.join(localRoot, "one.txt"), "one");
    await writeFile(path.join(localRoot, "nested/two.txt"), "two");
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      if (!arguments_.includes("--add-progress")) return { code: 0, stderr: "", stdout: "" };
      const fileList = arguments_.find((argument) => argument.startsWith("--files-from="))?.slice("--files-from=".length);
      const destination = arguments_.at(-1);
      if (fileList && destination) {
        for (const remoteFile of (await readFile(fileList, "utf8")).trim().split("\n")) {
          const target = path.join(destination, remoteFile.replace(/^\//, ""));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, remoteFile);
        }
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await client.uploadBatch(localRoot, ["one.txt", "nested/two.txt"], "/Batch");
    const downloaded = await client.downloadBatch(["Batch/one.txt", "Batch/nested/two.txt"], path.join(appLocations.dataDirectory, "batch-download"));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(downloaded).toHaveLength(2);
  });

  it("provides stat and deterministic recursive listings", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      const remote = arguments_.at(-1) ?? "";
      if (report) {
        await writeFile(report, remote.endsWith("home/Root")
          ? '<item restype="F" fname="z.txt" size="1"/><item restype="D" fname="A" size="0"/>'
          : remote.endsWith("home/Root/A")
            ? '<item restype="F" fname="b.txt" size="2"/>'
            : "");
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.stat("Root/z.txt")).resolves.toMatchObject({ name: "z.txt", type: "file" });
    await expect(client.stat("Root/missing")).resolves.toBeNull();
    await expect(client.listRecursive("Root")).resolves.toEqual([
      { name: "A", path: "Root/A", size: 0, type: "directory" },
      { name: "b.txt", path: "Root/A/b.txt", size: 2, type: "file" },
      { name: "z.txt", path: "Root/z.txt", size: 1, type: "file" },
    ]);
  });

  it("cancels before staging or invoking the engine", async () => {
    const appLocations = await locations();
    const source = path.join(appLocations.dataDirectory, "cancel.txt");
    await writeFile(source, "cancel me");
    const execute = vi.fn();
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);
    const controller = new AbortController();
    controller.abort();
    await expect(client.upload(source, "/", { signal: controller.signal }))
      .rejects.toThrow(/abort/i);
    expect(execute).not.toHaveBeenCalled();
    expect(await readdir(appLocations.temporaryDirectory)).toEqual([]);
  });

  it("validates empty batch destinations during dry-run", async () => {
    const appLocations = await locations();
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(vi.fn()), appLocations);
    await expect(client.uploadBatch(appLocations.dataDirectory, [], "../unsafe", { dryRun: true }))
      .rejects.toThrow(/relative path/i);
  });

  it("supports native Cloud Drive management and discovery operations", async () => {
    const appLocations = await locations();
    const fileLists: string[] = [];
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      if (arguments_.includes("--client-version")) {
        return { code: 0, stderr: "", stdout: "idevsutil version 1.0.2.8 release date [SYNC] [2026]" };
      }
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      const fileList = arguments_.find((argument) => argument.startsWith("--files-from="))?.slice("--files-from=".length);
      if (fileList) fileLists.push(await readFile(fileList, "utf8"));
      if (!report) return { code: 0, stderr: "", stdout: "" };
      if (arguments_.includes("--auth-list2")) {
        await writeFile(report, '<item restype="F" fname="deleted.txt" size="1" file_ver="2" in_trash="1"/>');
      } else if (arguments_.includes("--search") && arguments_.some((argument) => argument.startsWith("--file-index64="))) {
        await writeFile(report, '<item mod_time="x" size="1" file_ver="1" in_trash="0" thumb="0" index="12" fnameold="" ref_id="1" rc_id="2" chk="NA" url="NA" fname="/file.txt" soft_link="0"/>');
      } else if (arguments_.includes("--search")) {
        await writeFile(report, '<item size="1" file_ver="1" in_trash="0" thumb="0" fname="/file.txt" soft_link="0"/><item files_found="1"/>');
      } else if (arguments_.includes("--properties")) {
        await writeFile(report, '<item create_time="now"/><item size="1 bytes"/>');
      } else if (arguments_.includes("--get-size")) {
        await writeFile(report, '<item folder_size="1 Bytes"/><item files_count="1"/>');
      } else if (arguments_.includes("--items-status")) {
        await writeFile(report, '<item status="file exists" fname="/file.txt"/>');
      } else if (arguments_.includes("--version-info")) {
        await writeFile(report, '<item mod_time="before" size="1" ver="1"/>');
      } else if (arguments_.includes("--server-version")) {
        await writeFile(report, 'idevs version 2.0.0 release date [SYNC] [2026]');
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await client.renameRemote("/old.txt", "/new.txt");
    await client.copyRemote(["/new.txt"], "/Copies");
    await client.restoreTrash(["/Copies/new.txt"]);
    await client.emptyTrash();
    await expect(client.listTrash("/Copies")).resolves.toEqual([
      expect.objectContaining({ inTrash: true, name: "deleted.txt", version: 2 }),
    ]);
    await expect(client.search("file", { remotePath: "/" })).resolves.toMatchObject({ total: 1 });
    await expect(client.properties("/file.txt")).resolves.toEqual({ createdAt: "now", size: 1 });
    await expect(client.directorySize("/Folder")).resolves.toEqual({ fileCount: 1, size: 1 });
    await expect(client.itemsStatus(["/file.txt"])).resolves.toEqual([{ exists: true, path: "file.txt", type: "file" }]);
    await expect(client.versions("/file.txt")).resolves.toEqual([{ modifiedAt: "before", size: 1, version: 1 }]);
    await expect(client.changes("10")).resolves.toMatchObject({ nextCursor: "12" });
    await expect(client.serverVersion()).resolves.toMatchObject({ version: "2.0.0" });
    await expect(client.clientVersion()).resolves.toMatchObject({ version: "1.0.2.8" });

    expect(fileLists).toContain("/new.txt\n");
    expect(fileLists).toContain("/Copies/new.txt\n");
    expect(await readdir(appLocations.temporaryDirectory)).toEqual([]);
  });

  it("preserves the requested change cursor when no changes are returned", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, "connection established\n");
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);
    await expect(client.changes("90071992547409930001")).resolves.toEqual({
      changes: [],
      nextCursor: "90071992547409930001",
    });
  });

  it("never regresses the requested change cursor", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, [
        '<item fname="/older.txt" index="90071992547409930000" in_trash="0"/>',
        '<item fname="/old.txt" index="90071992547409930001" in_trash="0"/>',
      ].join(""));
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.changes("90071992547409930002")).resolves.toMatchObject({
      nextCursor: "90071992547409930002",
    });
  });

  it("accepts large bounded result reports and rejects oversized reports", async () => {
    const appLocations = await locations();
    let reportSize = 1024 * 1024 + 1;
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, `${" ".repeat(reportSize)}<item files_found="0"/>`);
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.search("missing", { retries: 1 })).resolves.toEqual({ entries: [], total: 0 });
    reportSize = 16 * 1024 * 1024 + 1;
    await expect(client.search("missing", { retries: 1 })).rejects.toThrow(/16777216-byte limit/i);
  });

  it("keeps engine error reports at the smaller bound", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const errorFile = arguments_.find((argument) => argument.startsWith("--e="))?.slice(4);
      if (errorFile) await writeFile(errorFile, "x".repeat(1024 * 1024 + 1));
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.search("missing", { retries: 1 })).rejects.toThrow(/1048576-byte limit/i);
  });

  it("validates SDK operation options before profile or engine access", async () => {
    const appLocations = await locations();
    const execute = vi.fn();
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(null as unknown as StoredProfile),
      transferEngine(execute),
      appLocations,
    );

    await expect(client.search("file", { retries: 0 })).rejects.toMatchObject({ code: "usage" });
    await expect(client.list("/", { retries: 0 })).rejects.toMatchObject({ code: "usage" });
    await expect(client.quota({ retries: 0 })).rejects.toMatchObject({ code: "usage" });
    await expect(client.search("file", { timeoutMs: Number.NaN })).rejects.toMatchObject({ code: "usage" });
    await expect(client.search("file", { timeoutMs: 0 })).rejects.toMatchObject({ code: "usage" });
    await expect(client.upload("/missing", "/", { bandwidthKbps: 0 })).rejects.toMatchObject({ code: "usage" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes read-only item status even when global dry-run is enabled", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, '<item status="file exists" fname="/exists.txt"/>');
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.itemsStatus(["/exists.txt"], { dryRun: true })).resolves.toEqual([
      { exists: true, path: "exists.txt", type: "file" },
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retries transient parsed and file-list read reports", async () => {
    const appLocations = await locations();
    let searchAttempts = 0;
    let statusAttempts = 0;
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (!report) return { code: 0, stderr: "", stdout: "" };
      if (arguments_.includes("--items-status")) {
        statusAttempts++;
        await writeFile(report, statusAttempts === 1
          ? '<tree message="ERROR" desc="temporary status failure"/>'
          : '<item status="file exists" fname="/exists.txt"/>');
      } else {
        searchAttempts++;
        await writeFile(report, searchAttempts === 1
          ? '<tree message="ERROR" desc="temporary search failure"/>'
          : '<item files_found="0"/>');
      }
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.search("missing", { retries: 2, signal: controller.signal })).resolves.toEqual({ entries: [], total: 0 });
    await expect(client.itemsStatus(["/exists.txt"], { retries: 2, signal: controller.signal })).resolves.toEqual([
      { exists: true, path: "exists.txt", type: "file" },
    ]);
    expect(searchAttempts).toBe(2);
    expect(statusAttempts).toBe(2);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("returns typed cancellation when aborted during retry backoff", async () => {
    const appLocations = await locations();
    const controller = new AbortController();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, '<tree message="ERROR" desc="temporary search failure"/>');
      setTimeout(() => controller.abort(), 10);
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.search("missing", { retries: 2, signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled", operation: "search" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects exit-zero error XML in parsed read reports", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const report = arguments_.find((argument) => argument.startsWith("--o="))?.slice(4);
      if (report) await writeFile(report, '<item op_status="failed" desc="read denied"/>');
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);

    await expect(client.search("file", { retries: 1 })).rejects.toThrow(/read denied/i);
    await expect(client.changes("0", { retries: 1 })).rejects.toThrow(/read denied/i);
  });

  it("reads the local engine version without a stored profile", async () => {
    const appLocations = await locations();
    const executeLocal = vi.fn().mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "idevsutil version 1.0.2.8 release date [CG] [SYNC] [RELEASE] [1.0.0.0] [02/DEC/2025]",
    });
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(null as unknown as StoredProfile),
      transferEngine(vi.fn(), executeLocal),
      appLocations,
    );

    await expect(client.clientVersion()).resolves.toMatchObject({ version: "1.0.2.8" });
    expect(executeLocal).toHaveBeenCalledWith(["--client-version"], expect.any(Number), undefined);
  });

  it.each([false, true])("preserves client-version cancellation with stored profile: %s", async (hasProfile) => {
    const appLocations = await locations();
    const controller = new AbortController();
    const waitForAbort = async (signal?: AbortSignal): Promise<never> => await new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("adapter aborted")), { once: true });
    });
    const execute = vi.fn(async (_profile: StoredProfile, _arguments: readonly string[], _timeout?: number, signal?: AbortSignal) =>
      await waitForAbort(signal));
    const executeLocal = vi.fn(async (_arguments: readonly string[], _timeout?: number, signal?: AbortSignal) =>
      await waitForAbort(signal));
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(hasProfile ? storedProfile() : null as unknown as StoredProfile),
      transferEngine(execute, executeLocal),
      appLocations,
    );

    const version = client.clientVersion({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(version).rejects.toMatchObject({ code: "cancelled", operation: "client version" });
    expect(hasProfile ? execute : executeLocal).toHaveBeenCalledOnce();
  });

  it("preserves typed client-version adapter errors", async () => {
    const appLocations = await locations();
    const adapterError = new IdriveError("transient", "adapter unavailable", "client version", true);
    const executeLocal = vi.fn().mockRejectedValue(adapterError);
    const client = new CloudDriveClient(
      unusedAuth(),
      profileStore(null as unknown as StoredProfile),
      transferEngine(vi.fn(), executeLocal),
      appLocations,
    );

    await expect(client.clientVersion()).rejects.toBe(adapterError);
  });

  it("validates new mutations during dry-run without requiring a profile", async () => {
    const appLocations = await locations();
    const client = new CloudDriveClient(unusedAuth(), profileStore(null as unknown as StoredProfile), transferEngine(vi.fn()), appLocations);
    await expect(client.renameRemote("/a", "/b", { dryRun: true })).resolves.toBeUndefined();
    await expect(client.copyRemote(["/a"], "/b", { dryRun: true })).resolves.toBeUndefined();
    await expect(client.restoreTrash(["/a"], { dryRun: true })).resolves.toBeUndefined();
    await expect(client.emptyTrash({ dryRun: true })).resolves.toBeUndefined();
    await expect(client.renameRemote("/", "/b", { dryRun: true })).rejects.toThrow(/source/i);
    await expect(client.copyRemote([], "/b", { dryRun: true })).rejects.toThrow(/at least one/i);
  });

  it("rejects exit-zero engine error reports for new operations", async () => {
    const appLocations = await locations();
    const execute = vi.fn(async (_profile: StoredProfile, arguments_: readonly string[]) => {
      const errorFile = arguments_.find((argument) => argument.startsWith("--e="))?.slice(4);
      if (errorFile) await writeFile(errorFile, '<item op_status="failed" desc="collision"/>');
      return { code: 0, stderr: "", stdout: "" };
    });
    const client = new CloudDriveClient(unusedAuth(), profileStore(storedProfile()), transferEngine(execute), appLocations);
    await expect(client.renameRemote("/a", "/b")).rejects.toThrow(/collision/i);
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
  executeLocal: NonNullable<TransferEngine["executeLocal"]> = async (arguments_, timeoutMs, signal) =>
    await execute(storedProfile(), arguments_, timeoutMs, signal),
): TransferEngine {
  return {
    encodeSecret: vi.fn(),
    execute,
    executeLocal,
    isInstalled: vi.fn().mockResolvedValue(true),
  };
}
