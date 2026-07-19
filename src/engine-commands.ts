import path from "node:path";

import { normalizeRemotePath } from "./remote-path.js";
import type { EngineContext, ReportPaths } from "./types.js";

interface UploadOptions extends ReportPaths {
  fileList: string;
  localRoot: string;
  remoteDirectory: string;
  tempDirectory: string;
}

interface DownloadOptions extends ReportPaths {
  destination: string;
  fileList: string;
  tempDirectory: string;
}

interface ListOptions extends ReportPaths {
  remotePath: string;
}

interface MkdirOptions {
  errorFile: string;
  remotePath: string;
}

interface DeleteOptions extends ReportPaths {
  fileList: string;
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
    "--auth-list",
    `--o=${options.reportFile}`,
    `--e=${options.errorFile}`,
    remote(context, "home", options.remotePath),
  ];
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
