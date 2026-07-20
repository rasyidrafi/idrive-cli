import { XMLParser } from "fast-xml-parser";

export interface CloudDriveEntry {
  modifiedAt?: string;
  name: string;
  size?: number;
  type: "directory" | "file";
}

export interface CloudDriveQuota {
  total: number;
  used: number;
}

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
    return {
      ...(modifiedAt ? { modifiedAt } : {}),
      name,
      ...(size === undefined ? {} : { size }),
      type: restype === "D" ? "directory" : "file",
    };
  });
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

function numberValue(value: unknown, field: string): number | undefined {
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  const parsed = safeInteger(raw);
  if (parsed === undefined) {
    throw new Error(`Invalid IDrive file-list ${field}`);
  }
  return parsed;
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
