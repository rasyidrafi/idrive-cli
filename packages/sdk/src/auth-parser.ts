import { XMLParser } from "fast-xml-parser";

import type {
  AccountDetails,
  EncryptionType,
  SyncServerDetails,
} from "./types.js";

type XmlValue = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseAttributeValue: false,
  trimValues: true,
});

export class IdDriveApiError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdDriveApiError";
  }
}

function loginAttributes(xml: string): XmlValue {
  let document: unknown;
  try {
    document = parser.parse(xml) as unknown;
  } catch (error) {
    throw new IdDriveApiError(
      `IDrive returned invalid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(document)) {
    throw new IdDriveApiError("IDrive response did not contain a login element");
  }

  const root = isRecord(document.root) ? document.root : document;
  if (root.login === "") {
    return {};
  }
  if (!isRecord(root.login)) {
    throw new IdDriveApiError("IDrive response did not contain a login element");
  }

  return root.login;
}

function isRecord(value: unknown): value is XmlValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(attributes: XmlValue, key: string): string {
  const value = optionalString(attributes[key]);
  if (!value) {
    throw new IdDriveApiError(`IDrive response is missing ${key}`);
  }
  return value;
}

function encryptionType(value: unknown): EncryptionType {
  if (value === "DEFAULT" || value === "PRIVATE") {
    return value;
  }
  throw new IdDriveApiError("IDrive returned an unsupported encryption type");
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function throwForFailure(attributes: XmlValue): void {
  if (attributes.message === "FAILURE") {
    const description = optionalString(attributes.desc) ?? "IDrive authentication failed";
    if (/username|password/i.test(description)) {
      throw new IdDriveApiError(
        "IDrive rejected the username or password. If this account was created with Google, Apple, or another SSO provider, set an IDrive account password in the web account first.",
      );
    }
    throw new IdDriveApiError(description);
  }
}

export function parseAccountDetails(xml: string): AccountDetails | null {
  const attributes = loginAttributes(xml);
  throwForFailure(attributes);

  const syncUsername = optionalString(attributes.username_sync);
  const syncPassword = optionalString(attributes.password_sync);
  if (!syncUsername || !syncPassword) {
    return null;
  }

  const notificationServer = optionalString(attributes.pns_sync);
  return {
    encryptionType: encryptionType(attributes.enctype),
    ...(notificationServer ? { notificationServer } : {}),
    syncPassword,
    syncUsername,
  };
}

export function parseSyncServerDetails(xml: string): SyncServerDetails {
  const attributes = loginAttributes(xml);
  throwForFailure(attributes);

  const serverDns = requiredString(attributes, "evssrvr");
  const webServerDns = requiredString(attributes, "evswebsrvr");
  const accountType = requiredString(attributes, "acctype");
  const serverIp = optionalString(attributes.evssrvrip);
  const webServerIp = optionalString(attributes.evswebsrvrip);
  const quota = optionalNumber(attributes.quota);
  const quotaUsed = optionalNumber(attributes.quota_used);

  return {
    accountType,
    dedup: attributes.dedup !== "off",
    encryptionType: encryptionType(attributes.enctype),
    ...(quota === undefined ? {} : { quota }),
    ...(quotaUsed === undefined ? {} : { quotaUsed }),
    serverDns,
    ...(serverIp ? { serverIp } : {}),
    webServerDns,
    ...(webServerIp ? { webServerIp } : {}),
  };
}
