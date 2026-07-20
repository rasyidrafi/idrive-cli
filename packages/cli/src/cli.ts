#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";

import { Command } from "commander";

import {
  cleanupStaleWorkspaces,
  CloudDriveClient,
  ConfigStore,
  defaultLocations,
  EngineInstaller,
  EngineRunner,
  exitCode,
  IdDriveAuthClient,
  IdriveError,
  normalizeRemotePath,
  ProcessRunner,
} from "idrive-sdk";

interface LoginCommandOptions {
  link: boolean;
  passwordStdin?: boolean;
}

interface ListCommandOptions {
  detailed?: boolean;
  json?: boolean;
  recursive?: boolean;
  trash?: boolean;
}

const locations = defaultLocations();
const processRunner = new ProcessRunner();
const engineRunner = new EngineRunner(processRunner, locations);
const client = new CloudDriveClient(
  new IdDriveAuthClient(),
  new ConfigStore(locations.configFile),
  engineRunner,
  locations,
  16,
);
const version = packageVersion();
let terminationSignal: NodeJS.Signals | undefined;

export async function main(arguments_: readonly string[] = process.argv): Promise<void> {
  terminationSignal = undefined;
  const controller = new AbortController();
  const onSigint = (): void => { terminationSignal = "SIGINT"; controller.abort(); };
  const onSigterm = (): void => { terminationSignal = "SIGTERM"; controller.abort(); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const program = new Command();
  program
    .name("idrive-cli")
    .description("Headless CLI for IDrive Cloud Drive (Sync storage)")
    .version(version)
    .option("--dry-run", "show mutations without executing them")
    .option("--json", "print machine-readable output where supported")
    .option("--quiet", "suppress successful human-readable output")
    .option("--progress", "show engine transfer progress on stderr")
    .option("--bwlimit-kbps <kilobytes>", "limit upload/download bandwidth in KB/s")
    .option("--retries <count>", "retry count for safe read operations", "3")
    .option("--temp-dir <path>", "private transfer workspace directory")
    .option("--timeout-seconds <seconds>", "engine operation timeout")
    .option("--transfers <count>", "maximum concurrent batch transfers", "1")
    .showHelpAfterError();
  const operationOptions = (): { bandwidthKbps?: number; dryRun?: boolean; onProgress?: (percent: number) => void; retries: number; signal: AbortSignal; timeoutMs?: number; transfers: number } => {
    const options = program.opts<{ bwlimitKbps?: string; dryRun?: boolean; json?: boolean; progress?: boolean; quiet?: boolean; retries: string; tempDir?: string; timeoutSeconds?: string; transfers: string }>();
    const retries = Number(options.retries);
    if (!Number.isSafeInteger(retries) || retries < 1 || retries > 10) {
      throw new IdriveError("usage", "retries must be an integer between 1 and 10");
    }
    const transfers = Number(options.transfers);
    if (!Number.isSafeInteger(transfers) || transfers < 1 || transfers > 16) {
      throw new IdriveError("usage", "transfers must be an integer between 1 and 16");
    }
    if (options.progress && transfers > 1) {
      throw new IdriveError("usage", "progress requires --transfers 1");
    }
    const bandwidthKbps = options.bwlimitKbps === undefined ? undefined : Number(options.bwlimitKbps);
    if (bandwidthKbps !== undefined && (!Number.isSafeInteger(bandwidthKbps) || bandwidthKbps < 1 || bandwidthKbps > 1_000_000_000)) {
      throw new IdriveError("usage", "bwlimit-kbps must be an integer between 1 and 1000000000");
    }
    if (options.tempDir) locations.temporaryDirectory = path.join(path.resolve(options.tempDir), "idrive-cli");
    const seconds = options.timeoutSeconds === undefined ? undefined : Number(options.timeoutSeconds);
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2_147_483)) {
      throw new IdriveError("usage", "timeout-seconds must be positive and no greater than 2147483");
    }
    return {
      ...(bandwidthKbps === undefined ? {} : { bandwidthKbps }),
      ...(options.dryRun ? { dryRun: true } : {}),
      retries,
      signal: controller.signal,
      transfers,
      ...(options.progress && transfers === 1 && !options.json && !options.quiet ? { onProgress: (percent: number) => {
        process.stderr.write(`\rIDrive progress: ${percent}%${percent === 100 ? "\n" : ""}`);
      } } : {}),
      ...(seconds === undefined ? {} : { timeoutMs: seconds * 1000 }),
    };
  };
  const writeSuccess = (message: string, data: Record<string, unknown> = {}): void => {
    const options = program.opts<{ json?: boolean; quiet?: boolean }>();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: program.args[0] ?? "unknown", data: { ...data, message: message.trim() } })}\n`);
    } else if (!options.quiet) {
      process.stdout.write(message);
    }
  };

  program.command("setup")
    .description("Extract the Cloud Drive transfer engine from the official IDrive .deb")
    .requiredOption("--deb <path>", "path to the official IDriveForLinux.deb")
    .requiredOption(
      "--trust-package",
      "confirm that the supplied package came from a trusted IDrive source",
    )
    .action(async (options: { deb: string; trustPackage: boolean }) => {
      if (operationOptions().dryRun) {
        writeSuccess(`Would install IDrive Cloud Drive engine from ${options.deb}\n`, { dryRun: true, source: options.deb });
        return;
      }
      const manifest = await new EngineInstaller(processRunner, locations)
        .installFromDeb(options.deb, controller.signal);
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "setup", data: {
          packageVersion: manifest.packageVersion,
          sourceSha256: manifest.sourceSha256,
        } })}\n`);
        return;
      }
      writeSuccess(
        `Installed IDrive Cloud Drive engine${manifest.packageVersion ? ` ${manifest.packageVersion}` : ""}\n`,
      );
      if (!program.opts<{ quiet?: boolean }>().quiet) {
        process.stdout.write(`Source SHA-256: ${manifest.sourceSha256}\n`);
      }
    });

  program.command("login")
    .description("Authenticate and store encoded Cloud Drive transfer credentials")
    .argument("<email>", "IDrive account email")
    .option("--password-stdin", "read the account password from standard input")
    .option("--no-link", "do not link this server as an IDrive Sync device")
    .action(async (email: string, options: LoginCommandOptions) => {
      if (operationOptions().dryRun) {
        writeSuccess(`Would authenticate IDrive Cloud Drive as ${email}\n`, { dryRun: true, email });
        return;
      }
      const password = await accountPassword(options.passwordStdin === true, controller.signal);
      const profile = await client.login(email, password, {
        linkMachine: options.link,
        signal: controller.signal,
        privateKeyProvider: async () =>
          process.env.IDRIVE_PRIVATE_KEY ?? await readSecret("Private encryption key: ", controller.signal),
      });
      writeSuccess(`Logged in to IDrive Cloud Drive as ${profile.email}\n`, { email: profile.email });
    });

  program.command("logout")
    .description("Remove the locally stored Cloud Drive profile")
    .action(async () => {
      if (operationOptions().dryRun) {
        writeSuccess("Would remove local IDrive Cloud Drive credentials\n", { dryRun: true });
        return;
      }
      await client.logout();
      writeSuccess("Local IDrive Cloud Drive credentials removed\n", { removed: true });
    });

  program.command("status")
    .description("Show local engine and authentication status")
    .action(async () => {
      const status = await client.status();
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "status", data: status })}\n`);
        return;
      }
      if (program.opts<{ quiet?: boolean }>().quiet) return;
      process.stdout.write(`Engine: ${status.engineInstalled ? "installed" : "not installed"}\n`);
      process.stdout.write(`Login: ${status.loggedIn ? status.email : "not logged in"}\n`);
      if (status.server) {
        process.stdout.write(`Server: ${status.server}\n`);
      }
    });

  program.command("upload")
    .description("Upload one local file; the original file name is preserved")
    .argument("<file>", "local file")
    .argument("[remote-directory]", "Cloud Drive destination directory", "/")
    .action(async (file: string, remoteDirectory: string) => {
      await client.upload(file, remoteDirectory, operationOptions());
      writeSuccess(
        `${operationOptions().dryRun ? "Would upload" : "Uploaded"} ${path.basename(file)} to /${remoteDirectory.replace(/^\/+|\/+$/g, "")}\n`,
        { dryRun: operationOptions().dryRun === true, localFile: path.resolve(file), remoteDirectory },
      );
    });

  program.command("ls")
    .description("List a Cloud Drive directory")
    .argument("[remote-path]", "Cloud Drive directory", "/")
    .option("--json", "print machine-readable JSON")
    .option("--detailed", "include version, checksum, thumbnail, and trash metadata")
    .option("--recursive", "list all descendants")
    .option("--trash", "list items in Cloud Drive trash")
    .action(async (remotePath: string, options: ListCommandOptions) => {
      if (options.recursive && options.trash) throw new IdriveError("usage", "recursive trash listing is not supported");
      const entries = options.recursive
        ? await client.listRecursive(remotePath, operationOptions())
        : await client.list(remotePath, {
            ...operationOptions(),
            ...(options.detailed === undefined ? {} : { detailed: options.detailed }),
            ...(options.trash === undefined ? {} : { trash: options.trash }),
          });
      if (options.json || program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "ls", data: entries })}\n`);
        return;
      }
      if (program.opts<{ quiet?: boolean }>().quiet) return;
      for (const entry of entries) {
        const displayName = "path" in entry && typeof entry.path === "string" ? entry.path : entry.name;
        process.stdout.write(
          `${entry.type === "directory" ? "d" : "f"}\t${entry.size ?? "-"}\t${displayName}\n`,
        );
      }
    });

  program.command("download")
    .description("Download a Cloud Drive file into a local directory")
    .argument("<remote-file>", "Cloud Drive file path")
    .argument("[destination]", "local destination directory", ".")
    .action(async (remoteFile: string, destination: string) => {
      const expectedPath = await client.download(remoteFile, destination, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would download to" : "Download completed; expected path:"} ${expectedPath}\n`, { dryRun: operationOptions().dryRun === true, expectedPath, remoteFile });
    });

  program.command("mkdir")
    .description("Create a Cloud Drive directory")
    .argument("<remote-path>", "Cloud Drive directory path")
    .action(async (remotePath: string) => {
      await client.createDirectory(remotePath, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would create" : "Created"} /${remotePath.replace(/^\/+|\/+$/g, "")}\n`, { dryRun: operationOptions().dryRun === true, remotePath });
    });

  program.command("rename")
    .alias("mv")
    .description("Rename or move one Cloud Drive file or directory")
    .argument("<source>", "existing Cloud Drive path")
    .argument("<destination>", "new Cloud Drive path")
    .action(async (source: string, destination: string) => {
      await client.renameRemote(source, destination, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would rename" : "Renamed"} /${normalizeRemotePath(source)} to /${normalizeRemotePath(destination)}\n`, {
        destination,
        dryRun: operationOptions().dryRun === true,
        source,
      });
    });

  program.command("copy")
    .alias("cp")
    .description("Copy Cloud Drive files or directories within the account")
    .argument("<paths...>", "one or more source paths followed by the destination directory")
    .action(async (paths: string[]) => {
      if (paths.length < 2) throw new IdriveError("usage", "copy requires at least one source and one destination");
      const destination = paths.at(-1) ?? "";
      const sources = paths.slice(0, -1);
      await client.copyRemote(sources, destination, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would copy" : "Copied"} ${sources.length} item${sources.length === 1 ? "" : "s"} to /${normalizeRemotePath(destination)}\n`, {
        destination,
        dryRun: operationOptions().dryRun === true,
        sources,
      });
    });

  program.command("rm")
    .description("Move one Cloud Drive file or directory tree to trash")
    .argument("<remote-path>", "Cloud Drive path to remove")
    .option("--yes", "confirm the remote removal")
    .action(async (remotePath: string, options: { yes?: boolean }) => {
      if (!options.yes && !operationOptions().dryRun) throw new IdriveError("usage", "required option '--yes' not specified");
      await client.remove(remotePath, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would remove" : "Removed"} /${remotePath.replace(/^\/+|\/+$/g, "")}\n`, { dryRun: operationOptions().dryRun === true, remotePath });
    });

  program.command("purge")
    .description("Permanently delete one scoped path from Cloud Drive trash")
    .argument("<remote-path>", "Cloud Drive trash path to permanently delete")
    .option("--yes", "confirm permanent deletion")
    .action(async (remotePath: string, options: { yes?: boolean }) => {
      if (!options.yes && !operationOptions().dryRun) throw new IdriveError("usage", "required option '--yes' not specified");
      await client.purgeTrash(remotePath, operationOptions());
      writeSuccess(
        `${operationOptions().dryRun ? "Would permanently delete" : "Permanently deleted"} /${remotePath.replace(/^\/+|\/+$/g, "")} from trash\n`,
        { dryRun: operationOptions().dryRun === true, remotePath },
      );
    });

  program.command("trash-ls")
    .description("List files and directories in Cloud Drive trash")
    .argument("[remote-path]", "trash directory", "/")
    .action(async (remotePath: string) => {
      const entries = await client.listTrash(remotePath, operationOptions());
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "trash-ls", data: entries })}\n`);
      } else if (!program.opts<{ quiet?: boolean }>().quiet) {
        for (const entry of entries) process.stdout.write(`${entry.type === "directory" ? "d" : "f"}\t${entry.size ?? "-"}\t${entry.name}\n`);
      }
    });

  program.command("trash-restore")
    .description("Restore files or directories from Cloud Drive trash to their original locations")
    .argument("<remote-paths...>", "trash paths to restore")
    .action(async (remotePaths: string[]) => {
      await client.restoreTrash(remotePaths, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would restore" : "Restored"} ${remotePaths.length} trash item${remotePaths.length === 1 ? "" : "s"}\n`, {
        dryRun: operationOptions().dryRun === true,
        remotePaths,
      });
    });

  program.command("trash-empty")
    .description("Permanently delete every item in Cloud Drive trash")
    .option("--yes", "confirm permanent deletion of all trash")
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes && !operationOptions().dryRun) throw new IdriveError("usage", "required option '--yes' not specified");
      await client.emptyTrash(operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would empty" : "Emptied"} Cloud Drive trash\n`, {
        dryRun: operationOptions().dryRun === true,
      });
    });

  program.command("search")
    .description("Search Cloud Drive by file or directory name")
    .argument("<query>", "search query")
    .option("--path <remote-path>", "scope search to a Cloud Drive directory", "/")
    .option("--trash", "search deleted items")
    .action(async (query: string, options: { path: string; trash?: boolean }) => {
      const result = await client.search(query, {
        ...operationOptions(),
        remotePath: options.path,
        ...(options.trash === undefined ? {} : { trash: options.trash }),
      });
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "search", data: result })}\n`);
      } else if (!program.opts<{ quiet?: boolean }>().quiet) {
        for (const entry of result.entries) process.stdout.write(`${entry.type === "directory" ? "d" : "f"}\t${entry.size ?? "-"}\t${entry.path}\n`);
      }
    });

  program.command("properties")
    .description("Show detailed properties for a Cloud Drive path")
    .argument("<remote-path>")
    .action(async (remotePath: string) => {
      const properties = await client.properties(remotePath, operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "properties", data: properties })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) for (const [key, value] of Object.entries(properties)) process.stdout.write(`${key}\t${value}\n`);
    });

  program.command("du")
    .description("Show recursive size and file count for a Cloud Drive directory")
    .argument("<remote-path>")
    .action(async (remotePath: string) => {
      const result = await client.directorySize(remotePath, operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "du", data: result })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) process.stdout.write(`${result.size}\t${result.fileCount}\t/${normalizeRemotePath(remotePath)}\n`);
    });

  program.command("items-status")
    .description("Check whether Cloud Drive files or directories exist")
    .argument("<remote-paths...>")
    .action(async (remotePaths: string[]) => {
      const result = await client.itemsStatus(remotePaths, operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "items-status", data: result })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) for (const item of result) process.stdout.write(`${item.exists ? "exists" : "missing"}\t${item.type ?? "unknown"}\t${item.path}\n`);
    });

  program.command("versions")
    .description("List previous versions of a Cloud Drive file")
    .argument("<remote-path>")
    .action(async (remotePath: string) => {
      const versions = await client.versions(remotePath, operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "versions", data: versions })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) for (const item of versions) process.stdout.write(`${item.version}\t${item.size}\t${item.modifiedAt}\n`);
    });

  program.command("changes")
    .description("Read incremental Cloud Drive changes after a decimal cursor")
    .option("--cursor <cursor>", "last processed change cursor", "0")
    .action(async (options: { cursor: string }) => {
      const changes = await client.changes(options.cursor, operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "changes", data: changes })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) {
        for (const change of changes.changes) process.stdout.write(`${change.cursor}\t${change.trashState}\t${change.path}\n`);
        process.stdout.write(`Next cursor: ${changes.nextCursor}\n`);
      }
    });

  program.command("server-version")
    .description("Show the connected Cloud Drive server version")
    .action(async () => {
      const result = await client.serverVersion(operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "server-version", data: result })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) process.stdout.write(`${result.raw}\n`);
    });

  program.command("client-version")
    .description("Show the installed Cloud Drive transfer-engine version")
    .action(async () => {
      const result = await client.clientVersion(operationOptions());
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "client-version", data: result })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) process.stdout.write(`${result.raw}\n`);
    });

  program.command("quota")
    .description("Show Cloud Drive storage usage")
    .action(async () => {
      const quota = await client.quota(operationOptions());
      if (program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "quota", data: quota })}\n`);
        return;
      }
      if (program.opts<{ quiet?: boolean }>().quiet) return;
      process.stdout.write(`Used: ${formatBytes(quota.used)}\n`);
      process.stdout.write(`Total: ${formatBytes(quota.total)}\n`);
    });

  program.command("stat")
    .description("Show metadata for one Cloud Drive path")
    .argument("<remote-path>")
    .option("--json", "print machine-readable JSON")
    .action(async (remotePath: string, options: { json?: boolean }) => {
      const entry = await client.stat(remotePath, operationOptions());
      if (!entry) throw new IdriveError("not-found", `Cloud Drive path was not found: ${remotePath}`, "stat");
      if (options.json || program.opts<{ json?: boolean }>().json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "stat", data: entry })}\n`);
      } else if (!program.opts<{ quiet?: boolean }>().quiet) {
        process.stdout.write(`${entry.type}\t${entry.size ?? "-"}\t${entry.name || "/"}\n`);
      }
    });

  program.command("upload-dir")
    .description("Recursively upload a local directory")
    .argument("<local-directory>")
    .argument("[remote-directory]", "Cloud Drive destination", "/")
    .action(async (localDirectory: string, remoteDirectory: string) => {
      await client.uploadDirectory(localDirectory, remoteDirectory, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would upload" : "Uploaded"} directory ${localDirectory}\n`, { dryRun: operationOptions().dryRun === true, localDirectory: path.resolve(localDirectory), remoteDirectory });
    });

  program.command("download-dir")
    .description("Recursively download a Cloud Drive directory")
    .argument("<remote-directory>")
    .argument("[destination]", "local destination", ".")
    .action(async (remoteDirectory: string, destination: string) => {
      await client.downloadDirectory(remoteDirectory, destination, operationOptions());
      writeSuccess(`${operationOptions().dryRun ? "Would download" : "Downloaded"} directory /${remoteDirectory.replace(/^\/+|\/+$/g, "")}\n`, { destination: path.resolve(destination), dryRun: operationOptions().dryRun === true, remoteDirectory });
    });

  program.command("cleanup")
    .description("Remove stale private operation workspaces")
    .option("--older-than-hours <hours>", "minimum workspace age", "24")
    .action(async (options: { olderThanHours: string }) => {
      const hours = Number(options.olderThanHours);
      if (!Number.isFinite(hours) || hours < 1) throw new IdriveError("usage", "older-than-hours must be at least 1");
      if (operationOptions().dryRun) {
        writeSuccess(`Would remove stale workspaces older than ${hours} hours\n`);
        return;
      }
      const removed = await cleanupStaleWorkspaces(locations, hours * 60 * 60 * 1000);
      writeSuccess(`Removed ${removed} stale workspace${removed === 1 ? "" : "s"}\n`);
    });

  program.command("doctor")
    .description("Check local IDrive CLI configuration and engine integrity")
    .option("--online", "also verify authenticated quota access")
    .action(async (options: { online?: boolean }) => {
      const engine = await engineRunner.diagnose();
      let profile: { data?: Record<string, unknown>; status: "ok" | "error"; message: string };
      try {
        const loaded = await new ConfigStore(locations.configFile).load();
        profile = loaded
          ? {
              data: { dedup: loaded.dedup, encryptionType: loaded.encryptionType },
              status: "ok",
              message: "profile is configured",
            }
          : { status: "error", message: "profile is not configured" };
      } catch (error) {
        profile = { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
      const checks = [
        { name: "platform", status: process.platform === "linux" && process.arch === "x64" ? "ok" : "error", message: `${process.platform}/${process.arch}` },
        {
          data: {
            architecture: engine.architecture,
            hashes: engine.hashes,
            packageVersion: engine.packageVersion,
          },
          name: "engine",
          status: engine.installed ? "ok" : "error",
          message: engine.message,
        },
        { name: "profile", ...profile },
      ];
      if (options.online) {
        try {
          const quota = await client.quota(operationOptions());
          checks.push({ data: { quota }, name: "online", status: "ok", message: "quota access succeeded" });
        } catch (error) {
          checks.push({ name: "online", status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "doctor", data: checks })}\n`);
      else if (!program.opts<{ quiet?: boolean }>().quiet) for (const check of checks) process.stdout.write(`${check.status}\t${check.name}\t${check.message}\n`);
      if (checks.some((check) => check.status === "error")) process.exitCode = 1;
    });

  try {
    await program.parseAsync([...arguments_]);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  const receivedSignal = currentTerminationSignal();
  if (receivedSignal) throw new IdriveError("cancelled", `Operation cancelled by ${receivedSignal}`);
}

function currentTerminationSignal(): NodeJS.Signals | undefined {
  return terminationSignal;
}

async function accountPassword(fromStdin: boolean, signal?: AbortSignal): Promise<string> {
  const environmentPassword = process.env.IDRIVE_PASSWORD;
  if (environmentPassword !== undefined) {
    return environmentPassword;
  }
  if (fromStdin) {
    return (await readStandardInput(signal)).replace(/[\r\n]+$/, "");
  }
  return await readSecret("IDrive password: ", signal);
}

async function readStandardInput(signal?: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => { cleanup(); reject(new IdriveError("cancelled", "Secret input was cancelled")); };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readSecret(prompt: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "A TTY is required for secret input; use IDRIVE_PASSWORD, IDRIVE_PRIVATE_KEY, or --password-stdin",
    );
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return await new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new IdriveError("cancelled", "Secret input was cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    const finish = (): void => {
      process.stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onAbort = (): void => {
      finish();
      reject(new IdriveError("cancelled", "Secret input was cancelled"));
    };
    process.stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = units[0] ?? "B";
  for (const candidate of units) {
    unit = candidate;
    if (Math.abs(amount) < 1024 || candidate === units.at(-1)) {
      break;
    }
    amount /= 1024;
  }
  return `${amount.toFixed(amount >= 10 || unit === "B" ? 0 : 1)} ${unit}`;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = terminationSignal !== undefined;
    const normalized = error instanceof IdriveError
      ? error
      : new IdriveError(inferErrorCode(error, message), message, undefined, false, { cause: error });
    if (process.argv.includes("--json")) {
      const code = cancelled ? "cancelled" : normalized.code;
      process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: {
        code,
        message,
        operation: normalized.operation,
        retryable: normalized.retryable,
      } })}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exitCode = terminationSignal === "SIGINT"
      ? 130
      : terminationSignal === "SIGTERM"
        ? 143
        : exitCode(normalized);
  });
}

function inferErrorCode(error: unknown, message: string): "auth" | "config" | "engine" | "local-io" | "usage" {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return "local-io";
  if (/profile|config|not logged in/i.test(message)) return "config";
  if (/password|private encryption key|authenticate|machine-link/i.test(message)) return "auth";
  if (/required|invalid|unsafe|refusing|cannot create the cloud drive root/i.test(message)) return "usage";
  return "engine";
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function packageVersion(): string {
  const packageFile = new URL("../package.json", import.meta.url);
  const value = JSON.parse(readFileSync(packageFile, "utf8")) as unknown;
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || typeof value.version !== "string"
  ) {
    throw new Error("Unable to read the idrive-cli package version");
  }
  return value.version;
}
