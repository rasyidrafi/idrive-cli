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
  trimValues: true,
});

export function parseListReport(report: string): CloudDriveEntry[] {
  if (report.trim().length === 0) {
    return [];
  }

  const parsed = parser.parse(`<root>${report}</root>`) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.root)) {
    throw new Error("Invalid IDrive file-list report");
  }

  const rawItems = parsed.root.item;
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return items.filter(isRecord).map((item) => {
    const name = stringValue(item.fname);
    if (!name) {
      throw new Error("IDrive file-list entry is missing fname");
    }

    const restype = stringValue(item.restype);
    if (restype !== "D" && restype !== "F") {
      throw new Error(`Unsupported IDrive file-list type: ${restype ?? "missing"}`);
    }

    const size = numberValue(item.size);
    const modifiedAt = stringValue(item.mod_time);
    return {
      ...(modifiedAt ? { modifiedAt } : {}),
      name,
      ...(size === undefined ? {} : { size }),
      type: restype === "D" ? "directory" : "file",
    };
  });
}

export function parseQuotaReport(report: string): CloudDriveQuota {
  const total = report.match(/\btotalquota="(\d+)"/)?.[1];
  const used = report.match(/\busedquota="(\d+)"/)?.[1];
  if (!total || !used) {
    throw new Error("Invalid IDrive quota report");
  }
  return { total: Number(total), used: Number(used) };
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
