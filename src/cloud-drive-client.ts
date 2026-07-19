import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
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
import { normalizeRemotePath } from "./remote-path.js";
import {
  parseListReport,
  parseQuotaReport,
  type CloudDriveEntry,
  type CloudDriveQuota,
} from "./report-parser.js";
import type { StoredProfile } from "./types.js";
import type { CommandResult } from "./process-runner.js";

export interface LoginOptions {
  linkMachine?: boolean;
  privateKeyProvider?: () => Promise<string>;
}

export interface ClientStatus {
  email?: string;
  engineInstalled: boolean;
  loggedIn: boolean;
  server?: string;
}

export interface AuthTransport {
  authenticate(email: string, password: string): Promise<AuthenticationResult>;
  linkMachine(
    email: string,
    password: string,
    deviceId: string,
    deviceName: string,
  ): Promise<void>;
}

export interface ProfileStore {
  clear(): Promise<void>;
  load(): Promise<StoredProfile | null>;
  save(profile: StoredProfile): Promise<void>;
}

export interface TransferEngine {
  encodeSecret(value: string): Promise<string>;
  execute(
    profile: StoredProfile,
    arguments_: readonly string[],
    timeoutMs?: number,
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
    const result = await this.auth.authenticate(email, password);
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
      this.engine.encodeSecret(result.account.syncPassword),
      this.engine.encodeSecret(encryptionKey),
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
        await this.validatePrivateProfile(profile);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Private encryption key could not be verified: ${detail}`, {
          cause: error,
        });
      }
    }
    const previousProfile = await this.config.load();
    await this.config.save(profile);
    if (options.linkMachine !== false) {
      try {
        await this.auth.linkMachine(
          email,
          password,
          await machineId(),
          os.hostname(),
        );
      } catch (error) {
        if (previousProfile) {
          await this.config.save(previousProfile);
        } else {
          await this.config.clear();
        }
        throw error;
      }
    }
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
  ): Promise<void> {
    const profile = await this.requireProfile();
    const source = path.resolve(localFile);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) {
      throw new Error(`Upload source is not a file: ${source}`);
    }
    safeLocalName(path.basename(source));

    await this.withOperationWorkspace(async (workspace) => {
      const files = path.join(workspace, "files.txt");
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const temporary = path.join(workspace, "transfer");
      await mkdir(temporary);
      await writeFile(files, `${path.basename(source)}\n`, { mode: 0o600 });
      const arguments_ = buildUploadCommand(profile, {
        errorFile: errors,
        fileList: files,
        localRoot: path.dirname(source),
        remoteDirectory,
        reportFile: report,
        tempDirectory: temporary,
      });
      await this.execute(profile, arguments_, errors, "upload");
    });
  }

  public async list(remotePath = "/"): Promise<CloudDriveEntry[]> {
    const profile = await this.requireProfile();
    return await this.withOperationWorkspace(async (workspace) => {
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildListCommand(profile, {
        errorFile: errors,
        remotePath,
        reportFile: report,
      });
      await this.execute(profile, arguments_, errors, "list");
      return parseListReport(await readFile(report, "utf8"));
    });
  }

  public async download(
    remoteFile: string,
    destination = ".",
  ): Promise<string> {
    const profile = await this.requireProfile();
    const normalized = normalizeRemotePath(remoteFile);
    if (normalized.length === 0) {
      throw new Error("A remote file path is required");
    }
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
      await this.execute(profile, arguments_, errors, "download");
      const stagedFile = await validateStagedDownload(staging, normalized);
      return await publishDownloadedFile(
        stagedFile,
        destinationRoot,
        normalized,
      );
    });
  }

  public async createDirectory(remotePath: string): Promise<void> {
    const profile = await this.requireProfile();
    await this.withOperationWorkspace(async (workspace) => {
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildMkdirCommand(profile, {
        errorFile: errors,
        remotePath,
      });
      await this.execute(profile, arguments_, errors, "mkdir");
    });
  }

  public async remove(remotePath: string): Promise<void> {
    await this.runRemoteDeletion(remotePath, false);
  }

  public async purgeTrash(remotePath: string): Promise<void> {
    await this.runRemoteDeletion(remotePath, true);
  }

  private async runRemoteDeletion(
    remotePath: string,
    permanent: boolean,
  ): Promise<void> {
    const normalized = normalizeRemotePath(remotePath);
    if (normalized.length === 0) {
      throw new Error("Refusing to delete the Cloud Drive root");
    }
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
      );
    });
  }

  public async quota(): Promise<CloudDriveQuota> {
    const profile = await this.requireProfile();
    return await this.runQuota(profile, "quota");
  }

  private async runQuota(
    profile: StoredProfile,
    operation: string,
  ): Promise<CloudDriveQuota> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.runQuotaAttempt(profile, operation);
      } catch (error) {
        lastError = error;
        if (!isTransientQuotaError(error) || attempt === 3) {
          throw error;
        }
        await delay(250 * attempt);
      }
    }
    throw lastError;
  }

  private async runQuotaAttempt(
    profile: StoredProfile,
    operation: string,
  ): Promise<CloudDriveQuota> {
    return await this.withOperationWorkspace(async (workspace) => {
      const report = path.join(workspace, "report.xml");
      const errors = path.join(workspace, "errors.xml");
      const arguments_ = buildQuotaCommand(profile, {
        errorFile: errors,
        reportFile: report,
      });
      await this.execute(profile, arguments_, errors, operation);
      return await parseQuotaOperation(report, errors);
    });
  }

  private async requireEngine(): Promise<void> {
    if (!(await this.engine.isInstalled())) {
      throw new Error("IDrive transfer engine is not installed; run idrive-cloud setup first");
    }
  }

  private async requireProfile(): Promise<StoredProfile> {
    await this.requireEngine();
    const profile = await this.config.load();
    if (!profile) {
      throw new Error("Not logged in; run idrive-cloud login first");
    }
    return profile;
  }

  private async execute(
    profile: StoredProfile,
    arguments_: readonly string[],
    errorFile: string,
    operation: string,
  ): Promise<void> {
    const result = await this.engine.execute(profile, arguments_, operationTimeout(operation));
    if (result.code === 0) {
      return;
    }
    const report = await readOptionalFile(errorFile);
    const detail = report.trim() || result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `IDrive ${operation} failed with code ${result.code}${detail ? `: ${detail}` : ""}`,
    );
  }

  private async validatePrivateProfile(profile: StoredProfile): Promise<void> {
    await this.runQuota(profile, "private-key validation");
  }

  private async withOperationWorkspace<T>(
    operation: (workspace: string) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.locations.temporaryDirectory, { mode: 0o700, recursive: true });
    const workspace = await mkdtemp(
      path.join(this.locations.temporaryDirectory, "operation-"),
    );
    try {
      return await operation(workspace);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }
}

async function readOptionalFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
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
  const temporaryFile = path.join(
    parent,
    `.idrive-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(stagedFile, temporaryFile, fsConstants.COPYFILE_EXCL);
    await chmod(temporaryFile, 0o600);
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
    await mkdir(directory, { mode: 0o700 });
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
  return error instanceof Error
    && /Unable to retrieve the quota\. Try again\./i.test(error.message);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function machineId(): Promise<string> {
  try {
    return (await readFile("/etc/machine-id", "utf8")).trim();
  } catch {
    return os.hostname();
  }
}
