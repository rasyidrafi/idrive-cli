import { XMLParser } from "fast-xml-parser";

export interface CloudDriveEntry {
  checksum?: string;
  inTrash?: boolean;
  label?: string;
  modifiedAt?: string;
  name: string;
  shareAccess?: string;
  shareId?: string;
  size?: number;
  softLink?: boolean;
  thumbnailAvailable?: boolean;
  type: "directory" | "file";
  url?: string;
  version?: number;
}

export interface CloudDriveQuota {
  total: number;
  used: number;
}

export interface CloudDriveSearchEntry extends Omit<CloudDriveEntry, "name"> {
  path: string;
}

export interface CloudDriveSearchResult {
  entries: CloudDriveSearchEntry[];
  total: number;
}

export interface CloudDriveProperties {
  accessedAt?: string;
  createdAt?: string;
  fileCount?: number;
  modifiedAt?: string;
  size?: number;
}

export interface CloudDriveDirectorySize {
  fileCount: number;
  size: number;
}

export interface CloudDriveItemStatus {
  exists: boolean;
  path: string;
  type?: "directory" | "file";
}

export interface CloudDriveVersion {
  modifiedAt: string;
  size: number;
  version: number;
}

export interface CloudDriveChange extends CloudDriveSearchEntry {
  cursor: string;
  previousPath?: string;
  referenceId?: string;
  repositoryId?: string;
  trashState: number;
}

export interface CloudDriveChanges {
  changes: CloudDriveChange[];
  nextCursor: string;
}

export interface CloudDriveEngineVersion {
  raw: string;
  releaseDate?: string;
  variant?: string;
  version: string;
}

/** @deprecated Use CloudDriveEngineVersion. */
export type CloudDriveServerVersion = CloudDriveEngineVersion;

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseAttributeValue: false,
  processEntities: true,
  trimValues: false,
});

export function parseListReport(report: string): CloudDriveEntry[] {
  const normalizedReport = stripListNoise(report);
  if (normalizedReport.trim().length === 0) {
    return [];
  }
  rejectDeclarations(normalizedReport);
  const parsed = parser.parse(`<root>${normalizedReport}</root>`) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.root)) {
    throw new Error("Invalid IDrive file-list report");
  }
  const rawTrees = parsed.root.tree;
  const trees = rawTrees === undefined
    ? []
    : Array.isArray(rawTrees) ? rawTrees : [rawTrees];
  for (const tree of trees) {
    if (isRecord(tree) && stringValue(tree.message) === "ERROR") {
      throw new Error(`IDrive file-list failed: ${stringValue(tree.desc) ?? "unknown list error"}`);
    }
  }

  const rawItems = parsed.root.item;
  if (rawItems === undefined) {
    const successfulEmptyTree = trees.length > 0
      && trees.every((tree) => isRecord(tree) && stringValue(tree.message) === "SUCCESS");
    if (successfulEmptyTree) return [];
    throw new Error("Invalid IDrive file-list report");
  }
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  if (!items.every(isRecord)) throw new Error("Invalid IDrive file-list entry");
  return items.map((item) => {
    const name = exactStringValue(item.fname);
    if (!name) {
      throw new Error("IDrive file-list entry is missing fname");
    }
    if (name === "." || name === ".." || /[\\/\0\n\r]/.test(name)) {
      throw new Error(`IDrive returned an unsafe file-list name: ${name}`);
    }

    const restype = stringValue(item.restype);
    if (restype !== "D" && restype !== "F") {
      throw new Error(`Unsupported IDrive file-list type: ${restype ?? "missing"}`);
    }

    const size = numberValue(item.size, "size");
    const modifiedAt = stringValue(item.mod_time);
    const version = numberValue(item.file_ver, "version", true);
    const thumbnailAvailable = booleanNumberValue(item.thumb, "thumbnail");
    const checksum = optionalMetadata(item.chk);
    const url = optionalMetadata(item.url);
    const label = optionalMetadata(item.label);
    const shareId = optionalMetadata(item.share_id);
    const shareAccess = optionalMetadata(item.share_access);
    const inTrash = booleanNumberValue(item.in_trash, "trash state");
    const softLink = booleanNumberValue(item.soft_link, "soft-link state");
    return {
      ...(checksum ? { checksum } : {}),
      ...(inTrash === undefined ? {} : { inTrash }),
      ...(label ? { label } : {}),
      ...(modifiedAt ? { modifiedAt } : {}),
      name,
      ...(shareAccess ? { shareAccess } : {}),
      ...(shareId ? { shareId } : {}),
      ...(size === undefined ? {} : { size }),
      ...(softLink === undefined ? {} : { softLink }),
      ...(thumbnailAvailable === undefined ? {} : { thumbnailAvailable }),
      type: restype === "D" ? "directory" : "file",
      ...(url ? { url } : {}),
      ...(version === undefined ? {} : { version }),
    };
  });
}

export function parseSearchReport(report: string): CloudDriveSearchResult {
  const items = parseItems(report, "search");
  const totalItem = items.find((item) => item.files_found !== undefined);
  const entries = items.filter((item) => item.fname !== undefined).map(parseSearchEntry);
  const total = totalItem ? requiredNumber(totalItem.files_found, "search result count") : entries.length;
  return { entries, total };
}

export function parsePropertiesReport(report: string): CloudDriveProperties {
  const items = parseItems(report, "properties");
  const result: CloudDriveProperties = {};
  for (const item of items) {
    const createdAt = stringValue(item.create_time);
    const accessedAt = stringValue(item.access_time);
    const modifiedAt = stringValue(item.mod_time);
    const fileCount = numberValue(item.files_count, "file count");
    const size = byteSizeValue(item.size, "size");
    if (createdAt) result.createdAt = createdAt;
    if (accessedAt) result.accessedAt = accessedAt;
    if (modifiedAt) result.modifiedAt = modifiedAt;
    if (fileCount !== undefined) result.fileCount = fileCount;
    if (size !== undefined) result.size = size;
  }
  if (Object.keys(result).length === 0) throw new Error("Invalid IDrive properties report");
  return result;
}

export function parseDirectorySizeReport(report: string): CloudDriveDirectorySize {
  const items = parseItems(report, "directory-size");
  let size: number | undefined;
  let fileCount: number | undefined;
  for (const item of items) {
    size ??= byteSizeValue(item.folder_size, "folder size");
    fileCount ??= numberValue(item.files_count, "file count");
  }
  if (size === undefined || fileCount === undefined) {
    throw new Error("Invalid IDrive directory-size report");
  }
  return { fileCount, size };
}

export function parseItemsStatusReport(report: string): CloudDriveItemStatus[] {
  return parseItems(report, "item-status").map((item) => {
    const rawPath = exactStringValue(item.fname);
    const status = stringValue(item.status);
    if (!rawPath || !status) throw new Error("Invalid IDrive item-status entry");
    const directory = rawPath.endsWith("/");
    const remotePath = safeReportPath(rawPath, "item-status path");
    const exists = /exists/i.test(status) && !/not|missing/i.test(status);
    const type = /directory/i.test(status) || directory
      ? "directory" as const
      : /file/i.test(status) ? "file" as const : undefined;
    return { exists, path: remotePath, ...(type ? { type } : {}) };
  });
}

export function parseVersionsReport(report: string): CloudDriveVersion[] {
  if (/\bNo version found\b/i.test(report)) return [];
  return parseItems(report, "versions").map((item) => {
    const modifiedAt = stringValue(item.mod_time);
    if (!modifiedAt) throw new Error("Invalid IDrive version modified time");
    return {
      modifiedAt,
      size: requiredNumber(item.size, "version size"),
      version: requiredNumber(item.ver ?? item.file_ver, "version number"),
    };
  });
}

export function parseChangesReport(report: string): CloudDriveChanges {
  const changes = parseItems(report, "changes")
    .filter((item) => item.fname !== undefined)
    .map((item): CloudDriveChange => {
      const entry = parseSearchEntry(item);
      const cursor = requiredDigitString(item.index, "change index");
      const previousPath = optionalReportPath(item.fnameold, "previous path");
      const referenceId = stringValue(item.ref_id);
      const repositoryId = stringValue(item.rc_id);
      return {
        ...entry,
        cursor,
        ...(previousPath ? { previousPath } : {}),
        ...(referenceId ? { referenceId } : {}),
        ...(repositoryId ? { repositoryId } : {}),
        trashState: requiredNumber(item.in_trash, "trash state"),
      };
    });
  const nextCursor = changes.reduce(
    (largest, change) => compareDigitStrings(change.cursor, largest) > 0 ? change.cursor : largest,
    "0",
  );
  return { changes, nextCursor };
}

export function parseServerVersionReport(report: string): CloudDriveEngineVersion {
  return parseVersionLine(report, /^idevs\s+version\s+/i, "server-version");
}

function parseVersionLine(
  report: string,
  prefix: RegExp,
  operation: string,
): CloudDriveEngineVersion {
  const raw = report.split(/\r?\n/).map((line) => line.trim()).find((line) => prefix.test(line));
  if (!raw) throw new Error(`Invalid IDrive ${operation} report`);
  const version = raw.match(/^idevs(?:util)?\s+version\s+([^\s]+)/i)?.[1] ?? "unknown";
  const bracketValues = [...raw.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] ?? "");
  const releaseDate = bracketValues.at(-1);
  const variant = bracketValues.find((value) => /SYNC|IDRIVE/i.test(value));
  return {
    raw,
    ...(releaseDate ? { releaseDate } : {}),
    ...(variant ? { variant } : {}),
    version,
  };
}

export function parseClientVersionReport(report: string): CloudDriveEngineVersion {
  return parseVersionLine(report, /^idevsutil\s+version\s+/i, "client-version");
}

function stripListNoise(report: string): string {
  const noise = [
    /^\s*connection established\s*$/i,
    /^\s*receiving file list \.\.\.\s*$/i,
    /^\s*sent \d+ bytes\s+received \d+ bytes\s+[\d.]+ bytes\/sec\s*$/i,
    /^\s*total size is \d+\s+speedup is [\d.]+\s*$/i,
  ];
  return report.split(/\r?\n/)
    .filter((line) => !noise.some((pattern) => pattern.test(line)))
    .join("\n");
}

export function parseQuotaReport(report: string): CloudDriveQuota {
  rejectDeclarations(report);
  const total = report.match(/\btotalquota="(\d+)"/)?.[1];
  const used = report.match(/\busedquota="(\d+)"/)?.[1];
  if (!total || !used) {
    throw new Error("Invalid IDrive quota report");
  }
  const parsedTotal = safeInteger(total);
  const parsedUsed = safeInteger(used);
  if (parsedTotal === undefined || parsedUsed === undefined || parsedUsed > parsedTotal) {
    throw new Error("Invalid IDrive quota values");
  }
  return { total: parsedTotal, used: parsedUsed };
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function exactStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, field: string, allowDash = false): number | undefined {
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  if (allowDash && raw === "-") return undefined;
  const parsed = safeInteger(raw);
  if (parsed === undefined) {
    throw new Error(`Invalid IDrive file-list ${field}`);
  }
  return parsed;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = numberValue(value, field);
  if (parsed === undefined) throw new Error(`Invalid IDrive ${field}`);
  return parsed;
}

function byteSizeValue(value: unknown, field: string): number | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)\s*(?:bytes?)?$/i);
  if (!match?.[1]) throw new Error(`Invalid IDrive ${field}`);
  const parsed = safeInteger(match[1]);
  if (parsed === undefined) throw new Error(`Invalid IDrive ${field}`);
  return parsed;
}

function booleanNumberValue(value: unknown, field: string): boolean | undefined {
  const raw = stringValue(value);
  if (raw === undefined) return undefined;
  if (raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`Invalid IDrive ${field}`);
}

function optionalMetadata(value: unknown): string | undefined {
  const parsed = stringValue(value);
  return parsed && parsed !== "NA" ? parsed : undefined;
}

function parseSearchEntry(item: XmlRecord): CloudDriveSearchEntry {
  const rawPath = exactStringValue(item.fname);
  if (!rawPath) throw new Error("Invalid IDrive search path");
  const directory = rawPath.endsWith("/");
  const path = safeReportPath(rawPath, "search path");
  const size = numberValue(item.size, "search size");
  const version = numberValue(item.file_ver, "search version");
  const trashState = numberValue(item.in_trash, "search trash state");
  const thumbnailAvailable = booleanNumberValue(item.thumb, "search thumbnail");
  const softLink = booleanNumberValue(item.soft_link, "search soft-link state");
  const modifiedAt = stringValue(item.mod_time);
  const checksum = optionalMetadata(item.chk);
  const url = optionalMetadata(item.url);
  const label = optionalMetadata(item.label);
  return {
    ...(checksum ? { checksum } : {}),
    ...(trashState === undefined ? {} : { inTrash: trashState > 0 }),
    ...(label ? { label } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
    path,
    ...(size === undefined ? {} : { size }),
    ...(softLink === undefined ? {} : { softLink }),
    ...(thumbnailAvailable === undefined ? {} : { thumbnailAvailable }),
    type: directory ? "directory" : "file",
    ...(url ? { url } : {}),
    ...(version === undefined ? {} : { version }),
  };
}

function parseItems(report: string, operation: string): XmlRecord[] {
  const normalized = stripListNoise(report);
  if (normalized.trim().length === 0) return [];
  rejectDeclarations(normalized);
  const parsed = parser.parse(`<root>${normalized}</root>`) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.root)) {
    throw new Error(`Invalid IDrive ${operation} report`);
  }
  const rawItems = parsed.root.item;
  if (rawItems === undefined) throw new Error(`Invalid IDrive ${operation} report`);
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  if (!items.every(isRecord)) throw new Error(`Invalid IDrive ${operation} entry`);
  return items;
}

function safeReportPath(value: string, field: string): string {
  if (/[\\\0\n\r]/.test(value)) throw new Error(`Unsafe IDrive ${field}`);
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe IDrive ${field}`);
  }
  return segments.join("/");
}

function optionalReportPath(value: unknown, field: string): string | undefined {
  const raw = exactStringValue(value);
  return raw ? safeReportPath(raw, field) : undefined;
}

function requiredDigitString(value: unknown, field: string): string {
  const raw = stringValue(value);
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`Invalid IDrive ${field}`);
  return raw.replace(/^0+(?=\d)/, "");
}

function compareDigitStrings(left: string, right: string): number {
  return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}

function safeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function rejectDeclarations(value: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) {
    throw new Error("IDrive XML DOCTYPE or ENTITY declarations are unsupported");
  }
}
