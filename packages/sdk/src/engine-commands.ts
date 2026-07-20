import path from "node:path";

import { normalizeRemotePath } from "./remote-path.js";
import type { EngineContext, ReportPaths } from "./types.js";

interface UploadOptions extends ReportPaths {
  bandwidthKbps?: number;
  fileList: string;
  localRoot: string;
  remoteDirectory: string;
  tempDirectory: string;
}

interface DownloadOptions extends ReportPaths {
  bandwidthKbps?: number;
  destination: string;
  fileList: string;
  tempDirectory: string;
}

interface ListOptions extends ReportPaths {
  detailed?: boolean;
  remotePath: string;
  trash?: boolean;
}

interface MkdirOptions {
  errorFile: string;
  remotePath: string;
}

interface DeleteOptions extends ReportPaths {
  fileList: string;
}

interface RenameOptions extends ReportPaths {
  newPath: string;
  oldPath: string;
}

interface CopyOptions extends DeleteOptions {
  destination: string;
}

interface SearchOptions extends ReportPaths {
  query: string;
  remotePath?: string;
  trash?: boolean;
}

interface PathReportOptions extends ReportPaths {
  remotePath: string;
}

interface ChangesOptions extends ReportPaths {
  cursor?: string;
}

export function selectEngineName(dedup: boolean): string {
  return dedup ? "idevsutil_dedup_sync" : "idevsutil_sync";
}

function baseArguments(context: EngineContext): string[] {
  return [
    "--acl",
    "--xml-output",
    "--port=443",
    "--encode",
    `--password-file=${context.encodedPassword}`,
    `--pvt-key=${context.encodedPrivateKey}`,
  ];
}

function remote(
  context: EngineContext,
  namespace: "home" | "ibackup",
  remotePath: string,
  trailingSlash = false,
): string {
  const normalized = normalizeRemotePath(remotePath);
  const suffix = normalized.length > 0 ? `/${normalized}` : "/";
  return `${context.syncUsername}@${context.server}::${namespace}${suffix}${
    trailingSlash && normalized.length > 0 ? "/" : ""
  }`;
}

function localDirectory(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

export function buildUploadCommand(
  context: EngineContext,
  options: UploadOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--100percent-progress",
    "--type",
    ...bandwidthArguments(options.bandwidthKbps),
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    `--files-from=${options.fileList}`,
    localDirectory(options.localRoot),
    `--temp=${options.tempDirectory}`,
    remote(context, "ibackup", options.remoteDirectory, true),
  ];
}

export function buildDownloadCommand(
  context: EngineContext,
  options: DownloadOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--add-progress",
    "--type",
    ...bandwidthArguments(options.bandwidthKbps),
    "--chmod=u=rwX,go=",
    `--files-from=${options.fileList}`,
    `--temp=${options.tempDirectory}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
    localDirectory(options.destination),
  ];
}

export function buildListCommand(
  context: EngineContext,
  options: ListOptions,
): string[] {
  return [
    ...baseArguments(context),
    options.detailed ? "--auth-list2" : "--auth-list",
    ...(options.trash ? ["--trash"] : []),
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", options.remotePath),
  ];
}

export function buildRenameCommand(
  context: EngineContext,
  options: RenameOptions,
): string[] {
  const oldPath = requiredRemotePath(options.oldPath, "rename source");
  const newPath = requiredRemotePath(options.newPath, "rename destination");
  return [
    ...baseArguments(context),
    "--rename",
    `--old-path=/${oldPath}`,
    `--new-path=/${newPath}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildCopyCommand(
  context: EngineContext,
  options: CopyOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--copy-within",
    `--files-from=${options.fileList}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", options.destination),
  ];
}

export function buildRestoreTrashCommand(
  context: EngineContext,
  options: DeleteOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--moveto-original",
    `--files-from=${options.fileList}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildEmptyTrashCommand(
  context: EngineContext,
  options: ReportPaths,
): string[] {
  return [
    ...baseArguments(context),
    "--empty-trash",
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildSearchCommand(
  context: EngineContext,
  options: SearchOptions,
): string[] {
  const query = safeOptionValue(options.query, "search query");
  return [
    ...baseArguments(context),
    "--search",
    `--search-key=${query}`,
    ...(options.trash ? ["--trash"] : []),
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", options.remotePath ?? ""),
  ];
}

export function buildPropertiesCommand(
  context: EngineContext,
  options: PathReportOptions,
): string[] {
  return reportPathCommand(context, "--properties", options);
}

export function buildDirectorySizeCommand(
  context: EngineContext,
  options: PathReportOptions,
): string[] {
  return reportPathCommand(context, "--get-size", options);
}

export function buildItemsStatusCommand(
  context: EngineContext,
  options: DeleteOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--items-status",
    `--files-from=${options.fileList}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildVersionsCommand(
  context: EngineContext,
  options: PathReportOptions,
): string[] {
  return reportPathCommand(context, "--version-info", options);
}

export function buildChangesCommand(
  context: EngineContext,
  options: ChangesOptions,
): string[] {
  const cursor = options.cursor ?? "0";
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid Cloud Drive change cursor");
  return [
    ...baseArguments(context),
    "--search",
    `--file-index64=${cursor}`,
    "--ref-id",
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "ibackup", ""),
  ];
}

export function buildServerVersionCommand(
  context: EngineContext,
  options: ReportPaths,
): string[] {
  return [
    ...baseArguments(context),
    "--server-version",
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildClientVersionCommand(): string[] {
  return ["--client-version"];
}

export function buildMkdirCommand(
  context: EngineContext,
  options: MkdirOptions,
): string[] {
  const remotePath = normalizeRemotePath(options.remotePath);
  if (remotePath.length === 0) {
    throw new Error("Cannot create the Cloud Drive root");
  }
  return [
    ...baseArguments(context),
    `--create-dir=${remotePath}`,
    `--e=${options.errorFile}`,
    remote(context, "ibackup", ""),
  ];
}

export function buildQuotaCommand(
  context: EngineContext,
  options: ReportPaths,
): string[] {
  return [
    ...baseArguments(context),
    "--get-quota",
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildDeleteCommand(
  context: EngineContext,
  options: DeleteOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--delete-items",
    `--files-from=${options.fileList}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

export function buildPurgeCommand(
  context: EngineContext,
  options: DeleteOptions,
): string[] {
  return [
    ...baseArguments(context),
    "--deletefrom-trash",
    `--files-from=${options.fileList}`,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", ""),
  ];
}

function reportPathCommand(
  context: EngineContext,
  operation: string,
  options: PathReportOptions,
): string[] {
  const remotePath = requiredRemotePath(options.remotePath, "remote path");
  return [
    ...baseArguments(context),
    operation,
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", remotePath),
  ];
}

function requiredRemotePath(value: string, label: string): string {
  const normalized = normalizeRemotePath(value);
  if (!normalized) throw new Error(`A ${label} is required`);
  return normalized;
}

function safeOptionValue(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`A ${label} is required`);
  if (/[\0\n\r]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function bandwidthArguments(value: number | undefined): string[] {
  if (value === undefined) return [];
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new Error("Bandwidth limit must be an integer between 1 and 1000000000 KB/s");
  }
  return [`--bwlimit=${value}`];
}
