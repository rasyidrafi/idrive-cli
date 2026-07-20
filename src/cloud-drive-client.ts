import { randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AuthenticationResult } from "./auth-client.js";
import {
  buildDownloadCommand,
  buildDeleteCommand,
  buildListCommand,
  buildMkdirCommand,
  buildPurgeCommand,
  buildQuotaCommand,
  buildUploadCommand,
} from "./engine-commands.js";
import type { AppLocations } from "./locations.js";
import { normalizeRemotePath, splitRemoteFilePath } from "./remote-path.js";
import {
  parseListReport,
  parseQuotaReport,
  type CloudDriveEntry,
  type CloudDriveQuota,
} from "./report-parser.js";
import type { StoredProfile } from "./types.js";
import type { CommandResult } from "./process-runner.js";
import { readTextFileLimited } from "./bounded-input.js";
import { ensurePrivateDirectory } from "./secure-directory.js";
import { IdriveError } from "./errors.js";

export interface LoginOptions {
  linkMachine?: boolean;
  privateKeyProvider?: () => Promise<string>;
  signal?: AbortSignal;
}

export async function cleanupStaleWorkspaces(
  locations: AppLocations,
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  await ensurePrivateDirectory(locations.temporaryDirectory);
  let removed = 0;
  for (const entry of await readdir(locations.temporaryDirectory, { withFileTypes: true })) {
    if (!/^(?:command|operation)-/.test(entry.name)) continue;
    const candidate = path.join(locations.temporaryDirectory, entry.name);
    const metadata = await lstat(candidate);
    if (entry.isDirectory() && await hasLiveWorkspaceOwner(candidate)) continue;
    if (Date.now() - metadata.mtimeMs < olderThanMs) continue;
    await rm(candidate, { force: true, recursive: entry.isDirectory() && !entry.isSymbolicLink() });
    removed++;
  }
  return removed;
}

export async function prepareDownloadDirectory(destination: string, remotePath: string): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(destination);
  let current = root;
  for (const segment of normalizeRemotePath(remotePath).split("/").filter(Boolean)) {
    current = path.join(current, segment);
    await ensureSafeDirectory(current);
  }
  return current;
}

export interface OperationOptions {
  dryRun?: boolean;
  onProgress?: (percent: number) => void;
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  transfers?: number;
}

export interface ClientStatus {
  email?: string;
  engineInstalled: boolean;
  loggedIn: boolean;
  server?: string;
}

export interface RecursiveCloudDriveEntry extends CloudDriveEntry {
  path: string;
}

export interface AuthTransport {
  authenticate(email: string, password: string, signal?: AbortSignal): Promise<AuthenticationResult>;
  linkMachine(
    email: string,
    password: string,
    deviceId: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ProfileStore {
  clear(): Promise<void>;
  load(): Promise<StoredProfile | null>;
  save(profile: StoredProfile): Promise<void>;
}

export interface TransferEngine {
  encodeSecret(value: string, signal?: AbortSignal): Promise<string>;
  execute(
    profile: StoredProfile,
    arguments_: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ): Promise<CommandResult>;
  isInstalled(): Promise<boolean>;
}

export class CloudDriveClient {
  public constructor(
    private readonly auth: AuthTransport,
    private readonly config: ProfileStore,
    private readonly engine: TransferEngine,
    private readonly locations: AppLocations,
  ) {}

  public async login(
    email: string,
    password: string,
    options: LoginOptions = {},
  ): Promise<StoredProfile> {
    if (email.trim().length === 0 || password.length === 0) {
      throw new Error("IDrive email and password are required");
    }
    await this.requireEngine();
    let result: AuthenticationResult;
    try {
      result = options.signal
        ? await this.auth.authenticate(email, password, options.signal)
        : await this.auth.authenticate(email, password);
    } catch (error) {
      throw new IdriveError("auth", error instanceof Error ? error.message : "IDrive authentication failed", "login", false, { cause: error });
    }
    if (result.account.encryptionType !== result.server.encryptionType) {
      throw new Error("IDrive returned inconsistent encryption settings");
    }

    let encryptionKey = "DEFAULT";
    if (result.account.encryptionType === "PRIVATE") {
      if (!options.privateKeyProvider) {
        throw new Error("This IDrive account requires a private encryption key");
      }
      encryptionKey = await options.privateKeyProvider();
      if (encryptionKey.length === 0) {
        throw new Error("The private encryption key cannot be empty");
      }
    }

    const [encodedPassword, encodedPrivateKey] = await Promise.all([
      options.signal
        ? this.engine.encodeSecret(result.account.syncPassword, options.signal)
        : this.engine.encodeSecret(result.account.syncPassword),
      options.signal
        ? this.engine.encodeSecret(encryptionKey, options.signal)
        : this.engine.encodeSecret(encryptionKey),
    ]);
    const profile: StoredProfile = {
      dedup: result.server.dedup,
      email,
      encodedPassword,
      encodedPrivateKey,
      encryptionType: result.account.encryptionType,
      server: result.server.serverDns,
      syncUsername: result.account.syncUsername,
    };
    if (profile.encryptionType === "PRIVATE") {
      try {
        await this.validatePrivateProfile(profile, options.signal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Private encryption key could not be verified: ${detail}`, {
          cause: error,
        });
      }
    }
    if (options.linkMachine !== false) {
      const linkArguments = [email, password, await machineId(), os.hostname()] as const;
      if (options.signal) await this.auth.linkMachine(...linkArguments, options.signal);
      else await this.auth.linkMachine(...linkArguments);
    }
    await this.config.save(profile);
    return profile;
  }

  public async logout(): Promise<void> {
    await this.config.clear();
  }

  public async status(): Promise<ClientStatus> {
    const [engineInstalled, profile] = await Promise.all([
      this.engine.isInstalled(),
      this.config.load(),
    ]);
    return {
      ...(profile ? { email: profile.email, server: profile.server } : {}),
      engineInstalled,
      loggedIn: profile !== null,
    };
  }

  public async upload(
    localFile: string,
    remoteDirectory = "/",
    options: OperationOptions = {},
  ): Promise<void> {
    const source = path.resolve(localFile);
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Upload source is not a file: ${source}`);
    }
    safeLocalName(path.basename(source));
    normalizeRemotePath(remoteDirectory);
    if (options.dryRun) return;
    const profile = await this.requireProfile();

    await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "files.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const temporary = path.join(workspace, "transfer");
      const snapshotRoot = path.join(workspace, "source");
      await mkdir(temporary);
      await mkdir(snapshotRoot, { mode: 0o700 });
      await snapshotFile(source, path.join(snapshotRoot, path.basename(source)), sourceStat, options.signal);
      await writeFile(files, `${path.basename(source)}\n`, { mode: 0o600 });
      const arguments_ = buildUploadCommand(profile, {
        errorFile: errors,
        fileList: files,
        localRoot: snapshotRoot,
        remoteDirectory,
        reportFile: report,
        tempDirectory: temporary,
      });
      await this.execute(profile, arguments_, errors, "upload", options.signal, options.timeoutMs, options.onProgress);
    });
  }

  public async uploadBatch(
    localRoot: string,
    relativeFiles: readonly string[],
    remoteDirectory = "/",
    options: OperationOptions = {},
    prepareRemote?: () => Promise<void>,
  ): Promise<void> {
    normalizeRemotePath(remoteDirectory);
    if (relativeFiles.length === 0) {
      if (!options.dryRun) await prepareRemote?.();
      return;
    }
    const root = await realpath(path.resolve(localRoot));
    const sources = await Promise.all(relativeFiles.map(async (relative) => {
      const normalized = normalizeRemotePath(relative);
      if (!normalized || normalized !== relative) throw new Error(`Invalid relative upload path: ${relative}`);
      const source = path.join(root, ...normalized.split("/"));
      if (!isWithin(root, source)) throw new Error(`Upload path escaped its root: ${relative}`);
      await rejectSymlinkComponents(root, normalized);
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Upload source is not a regular file: ${source}`);
      return { metadata, normalized, source };
    }));
    if (options.dryRun) return;
    const profile = await this.requireProfile();
    await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "files.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const temporary = path.join(workspace, "transfer");
      const snapshotRoot = path.join(workspace, "source");
      await mkdir(temporary);
      await mkdir(snapshotRoot, { mode: 0o700 });
      for (const source of sources) {
        const snapshot = path.join(snapshotRoot, ...source.normalized.split("/"));
        await mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
        await snapshotFile(source.source, snapshot, source.metadata, options.signal);
      }
      await prepareRemote?.();
      await writeFile(files, `${sources.map((source) => source.normalized).join("\n")}\n`, { mode: 0o600 });
      await this.execute(profile, buildUploadCommand(profile, {
        errorFile: errors, fileList: files, localRoot: snapshotRoot, remoteDirectory,
        reportFile: report, tempDirectory: temporary,
      }), errors, "upload", options.signal, options.timeoutMs, options.onProgress);
    });
  }

  public async downloadBatch(
    remoteFiles: readonly string[],
    destination = ".",
    options: OperationOptions = {},
  ): Promise<string[]> {
    if (remoteFiles.length === 0) return [];
    const normalizedFiles = remoteFiles.map((file) => {
      const normalized = normalizeRemotePath(file);
      if (!normalized) throw new Error("A remote file path is required");
      return normalized;
    });
    if (options.dryRun) {
      return normalizedFiles.map((file) => path.join(path.resolve(destination), ...file.split("/")));
    }
    const profile = await this.requireProfile();
    const destinationPath = path.resolve(destination);
    await mkdir(destinationPath, { recursive: true });
    const destinationRoot = await realpath(destinationPath);
    return await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "files.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const temporary = path.join(workspace, "transfer");
      const staging = path.join(workspace, "download");
      await mkdir(temporary);
      await mkdir(staging, { mode: 0o700 });
      await writeFile(files, `${normalizedFiles.map((file) => `/${file}`).join("\n")}\n`, { mode: 0o600 });
      await this.execute(profile, buildDownloadCommand(profile, {
        destination: staging, errorFile: errors, fileList: files,
        reportFile: report, tempDirectory: temporary,
      }), errors, "download", options.signal, options.timeoutMs, options.onProgress);
      const staged = await Promise.all(normalizedFiles.map((file) => validateStagedDownload(staging, file)));
      const published: string[] = [];
      for (const [index, file] of staged.entries()) {
        published.push(await publishDownloadedFile(file, destinationRoot, normalizedFiles[index] ?? "", options.signal));
      }
      return published;
    });
  }

  public async list(remotePath = "/", options: OperationOptions = {}): Promise<CloudDriveEntry[]> {
    const profile = await this.requireProfile();
    let lastError: unknown;
    const attempts = options.retries ?? 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.listAttempt(profile, remotePath, options);
      } catch (error) {
        lastError = error;
        if (!(error instanceof IdriveError && error.retryable) || attempt === attempts) throw error;
        await delay(Math.min(4_000, 250 * 2 ** (attempt - 1)), options.signal);
      }
    }
    throw lastError;
  }

  private async listAttempt(
    profile: StoredProfile,
    remotePath: string,
    options: OperationOptions,
  ): Promise<CloudDriveEntry[]> {
    return await this.withOperationWorkspace(async (workspace) => {
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildListCommand(profile, {
        errorFile: errors,
        remotePath,
        reportFile: report,
      });
      await this.execute(profile, arguments_, errors, "list", options.signal, options.timeoutMs, options.onProgress);
      const reportText = await readTextFileLimited(report, 16 * 1024 * 1024);
      try {
        return parseListReport(reportText);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid IDrive file-list report";
        const transient = isTransientEngineDetail(message);
        throw new IdriveError(
          transient ? "transient" : "engine",
          `${message}: ${sanitizeDetail(reportText).slice(0, 500)}`,
          "list",
          transient,
          { cause: error },
        );
      }
    });
  }

  public async stat(remotePath: string, options: OperationOptions = {}): Promise<CloudDriveEntry | null> {
    const normalized = normalizeRemotePath(remotePath);
    if (!normalized) return { name: "", type: "directory" };
    const { directory, fileName } = splitRemoteFilePath(normalized);
    return (await this.list(directory, options)).find((entry) => entry.name === fileName) ?? null;
  }

  public async listRecursive(
    remotePath = "/",
    options: OperationOptions = {},
  ): Promise<RecursiveCloudDriveEntry[]> {
    const root = normalizeRemotePath(remotePath);
    const result: RecursiveCloudDriveEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await this.list(directory, options);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = [directory, entry.name].filter(Boolean).join("/");
        result.push({ ...entry, path: entryPath });
        if (entry.type === "directory") await visit(entryPath);
      }
    };
    await visit(root);
    return result;
  }

  public async download(
    remoteFile: string,
    destination = ".",
    options: OperationOptions = {},
  ): Promise<string> {
    const normalized = normalizeRemotePath(remoteFile);
    if (normalized.length === 0) {
      throw new Error("A remote file path is required");
    }
    if (options.dryRun) return path.join(path.resolve(destination), ...normalized.split("/"));
    const profile = await this.requireProfile();
    const destinationPath = path.resolve(destination);
    await mkdir(destinationPath, { recursive: true });
    const destinationRoot = await realpath(destinationPath);

    return await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "files.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const temporary = path.join(workspace, "transfer");
      const staging = path.join(workspace, "download");
      await mkdir(temporary);
      await mkdir(staging, { mode: 0o700 });
      await writeFile(files, `/${normalized}\n`, { mode: 0o600 });
      const arguments_ = buildDownloadCommand(profile, {
        destination: staging,
        errorFile: errors,
        fileList: files,
        reportFile: report,
        tempDirectory: temporary,
      });
      await this.execute(profile, arguments_, errors, "download", options.signal, options.timeoutMs, options.onProgress);
      const stagedFile = await validateStagedDownload(staging, normalized);
      return await publishDownloadedFile(
        stagedFile,
        destinationRoot,
        normalized,
        options.signal,
      );
    });
  }

  public async createDirectory(remotePath: string, options: OperationOptions = {}): Promise<void> {
    if (!normalizeRemotePath(remotePath)) throw new IdriveError("usage", "Cannot create the Cloud Drive root");
    if (options.dryRun) return;
    const profile = await this.requireProfile();
    await this.withOperationWorkspace(async (workspace) => {
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildMkdirCommand(profile, {
        errorFile: errors,
        remotePath,
      });
      await this.execute(profile, arguments_, errors, "mkdir", options.signal, options.timeoutMs, options.onProgress);
    });
  }

  public async remove(remotePath: string, options: OperationOptions = {}): Promise<void> {
    await this.runRemoteDeletion(remotePath, false, options);
  }

  public async purgeTrash(remotePath: string, options: OperationOptions = {}): Promise<void> {
    await this.runRemoteDeletion(remotePath, true, options);
  }

  private async runRemoteDeletion(
    remotePath: string,
    permanent: boolean,
    options: OperationOptions,
  ): Promise<void> {
    const normalized = normalizeRemotePath(remotePath);
    if (normalized.length === 0) {
      throw new IdriveError("usage", "Refusing to delete the Cloud Drive root");
    }
    if (options.dryRun) return;
    const profile = await this.requireProfile();
    await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "delete.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      await writeFile(files, `/${normalized}\n`, { mode: 0o600 });
      const commandOptions = {
        errorFile: errors,
        fileList: files,
        reportFile: report,
      };
      const arguments_ = permanent
        ? buildPurgeCommand(profile, commandOptions)
        : buildDeleteCommand(profile, commandOptions);
      await this.execute(
        profile,
        arguments_,
        errors,
        permanent ? "purge" : "delete",
        options.signal,
        options.timeoutMs,
        options.onProgress,
      );
    });
  }

  public async quota(options: OperationOptions = {}): Promise<CloudDriveQuota> {
    const profile = await this.requireProfile();
    return await this.runQuota(profile, "quota", options);
  }

  private async runQuota(
    profile: StoredProfile,
    operation: string,
    options: OperationOptions = {},
  ): Promise<CloudDriveQuota> {
    let lastError: unknown;
    const attempts = options.retries ?? 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.runQuotaAttempt(profile, operation, options);
      } catch (error) {
        lastError = error;
        if (!isTransientQuotaError(error) || attempt === attempts) {
          throw error;
        }
        await delay(Math.min(4_000, 250 * 2 ** (attempt - 1)), options.signal);
      }
    }
    throw lastError;
  }

  private async runQuotaAttempt(
    profile: StoredProfile,
    operation: string,
    options: OperationOptions,
  ): Promise<CloudDriveQuota> {
    return await this.withOperationWorkspace(async (workspace) => {
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildQuotaCommand(profile, {
        errorFile: errors,
        reportFile: report,
      });
      await this.execute(profile, arguments_, errors, operation, options.signal, options.timeoutMs, options.onProgress);
      return await parseQuotaOperation(report, errors);
    });
  }

  private async requireEngine(): Promise<void> {
    if (!(await this.engine.isInstalled())) {
      throw new IdriveError("engine", "IDrive transfer engine is not installed; run idrive-cli setup first");
    }
  }

  private async requireProfile(): Promise<StoredProfile> {
    await this.requireEngine();
    const profile = await this.config.load();
    if (!profile) {
      throw new IdriveError("config", "Not logged in; run idrive-cli login first");
    }
    return profile;
  }

  private async execute(
    profile: StoredProfile,
    arguments_: readonly string[],
    errorFile: string,
    operation: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    let result: CommandResult;
    try {
      result = signal
        ? await this.engine.execute(profile, arguments_, timeoutMs ?? operationTimeout(operation), signal, onProgress)
        : await this.engine.execute(profile, arguments_, timeoutMs ?? operationTimeout(operation), undefined, onProgress);
    } catch (error) {
      if (signal?.aborted) {
        throw new IdriveError("cancelled", `IDrive ${operation} was cancelled`, operation, false, { cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      const transient = /timed out|temporar|connection|unavailable/i.test(message);
      throw new IdriveError(transient ? "transient" : "engine", message, operation, transient, { cause: error });
    }
    if (result.code === 0) {
      return;
    }
    const report = await readOptionalFile(errorFile);
    const detail = sanitizeDetail(report.trim() || result.stderr.trim() || result.stdout.trim());
    throw new IdriveError("engine",
      `IDrive ${operation} failed with code ${result.code}${detail ? `: ${detail}` : ""}`,
      operation,
      isTransientEngineDetail(detail),
    );
  }

  private async validatePrivateProfile(profile: StoredProfile, signal?: AbortSignal): Promise<void> {
    await this.runQuota(profile, "private-key validation", signal ? { signal } : {});
  }

  private async withOperationWorkspace<T>(
    operation: (workspace: string) => Promise<T>,
  ): Promise<T> {
    await ensurePrivateDirectory(this.locations.temporaryDirectory);
    const workspace = await mkdtemp(
      path.join(this.locations.temporaryDirectory, "operation-"),
    );
    try {
      await writeFile(path.join(workspace, ".owner"), `${process.pid}\n`, { mode: 0o600 });
      return await operation(workspace);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }
}

async function hasLiveWorkspaceOwner(workspace: string): Promise<boolean> {
  try {
    const value = await readTextFileLimited(path.join(workspace, ".owner"), 64);
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function readOptionalFile(file: string): Promise<string> {
  try {
    return await readTextFileLimited(file, 1024 * 1024);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function parseQuotaOperation(
  reportFile: string,
  errorFile: string,
): Promise<CloudDriveQuota> {
  const report = await readOptionalFile(reportFile);
  try {
    return parseQuotaReport(report);
  } catch (error) {
    const engineError = (await readOptionalFile(errorFile)).trim();
    const detail = engineError || report.trim() || "the engine returned an empty report";
    throw new Error(`Invalid IDrive quota report: ${detail.slice(0, 500)}`, {
      cause: error,
    });
  }
}

function safeLocalName(value: string): void {
  if (/[\0\n\r]/.test(value)) {
    throw new Error("Local file names containing control characters are unsupported");
  }
  if (/\s$/.test(value)) {
    throw new Error("Local file names ending in whitespace are unsupported by the IDrive engine");
  }
}

function operationTimeout(operation: string): number {
  return operation === "upload" || operation === "download"
    ? 2 * 60 * 60 * 1000
    : 2 * 60 * 1000;
}

async function validateStagedDownload(
  stagingRoot: string,
  normalizedRemotePath: string,
): Promise<string> {
  let current = stagingRoot;
  const segments = normalizedRemotePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`IDrive restored an unsafe symbolic link: ${current}`);
    }
    const isLast = index === segments.length - 1;
    if (isLast ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`IDrive restored an unexpected file type: ${current}`);
    }
  }

  const realStagingRoot = await realpath(stagingRoot);
  const realFile = await realpath(current);
  if (!isWithin(realStagingRoot, realFile)) {
    throw new Error("IDrive restored a file outside the private staging directory");
  }
  await chmod(realFile, 0o600);
  return realFile;
}

async function publishDownloadedFile(
  stagedFile: string,
  destinationRoot: string,
  normalizedRemotePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const segments = normalizedRemotePath.split("/");
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error("A remote file name is required");
  }

  let parent = destinationRoot;
  for (const segment of segments) {
    parent = path.join(parent, segment);
    await ensureSafeDirectory(parent);
  }
  if (!isWithin(destinationRoot, parent)) {
    throw new Error("Download destination escaped its root directory");
  }

  const destinationFile = path.join(parent, fileName);
  await rejectUnsafeExistingDestination(destinationFile);
  if (await realpath(parent) !== parent) {
    throw new Error("Download destination changed during validation");
  }
  const temporaryFile = path.join(
    parent,
    `.idrive-${randomUUID()}.tmp`,
  );
  try {
    signal?.throwIfAborted();
    await pipeline(
      createReadStream(stagedFile),
      createWriteStream(temporaryFile, { flags: "wx", mode: 0o600 }),
      signal ? { signal } : {},
    );
    await chmod(temporaryFile, 0o600);
    if (await realpath(parent) !== parent) {
      throw new Error("Download destination changed during publication");
    }
    signal?.throwIfAborted();
    await rename(temporaryFile, destinationFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return destinationFile;
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Unsafe download destination component: ${directory}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
        throw mkdirError;
      }
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Unsafe download destination component: ${directory}`, { cause: mkdirError });
      }
    }
  }
}

async function rejectUnsafeExistingDestination(file: string): Promise<void> {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Unsafe existing download destination: ${file}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function rejectSymlinkComponents(root: string, relative: string): Promise<void> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`Refusing symbolic link upload path: ${current}`);
  }
}

async function snapshotFile(
  source: string,
  destination: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sourceHandle = await import("node:fs/promises").then(({ open }) =>
    open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
  try {
    const actual = await sourceHandle.stat();
    if (!sameSnapshotSource(actual, expected)) {
      throw new Error(`Upload source changed before snapshot: ${source}`);
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      signal ? { signal } : {},
    );
    const [after, destinationStat] = await Promise.all([sourceHandle.stat(), lstat(destination)]);
    if (!sameSnapshotSource(after, expected) || destinationStat.size !== expected.size) {
      throw new Error(`Upload source changed during snapshot: ${source}`);
    }
    const destinationHandle = await import("node:fs/promises").then(({ open }) => open(destination, "r"));
    try { await destinationHandle.sync(); } finally { await destinationHandle.close(); }
  } finally {
    await sourceHandle.close();
  }
}

function sameSnapshotSource(
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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith("..")
    && !path.isAbsolute(relative)
  );
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isTransientQuotaError(error: unknown): boolean {
  return error instanceof IdriveError && error.retryable
    || error instanceof Error && /Unable to retrieve the quota\. Try again\./i.test(error.message);
}

function isTransientEngineDetail(detail: string): boolean {
  return /(?:temporar|timed? out|try again|connection|unavailable|throttl)/i.test(detail);
}

function sanitizeDetail(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127
      ? character
      : "?";
  }).join("").slice(0, 4_000);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("IDrive operation was aborted"));
    }, { once: true });
  });
}

async function machineId(): Promise<string> {
  try {
    return (await readFile("/etc/machine-id", "utf8")).trim();
  } catch {
    return os.hostname();
  }
}
