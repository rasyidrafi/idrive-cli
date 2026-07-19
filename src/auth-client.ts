import {
  parseAccountDetails,
  parseSyncServerDetails,
} from "./auth-parser.js";
import type { AccountDetails, SyncServerDetails } from "./types.js";

const accountDetailsUrl = "https://www1.idrive.com/cgi-bin/v1/user-details.cgi";
const syncServerUrl =
  "https://evs.idrivesync.com/cgi-bin/get_idsync_evs_details_xml_ip.cgi";
const linkMachineUrl = "https://tomcat.idrive.com/idrivee/appjsp/idriveLink.jsp";

export type Fetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthenticationResult {
  account: AccountDetails;
  server: SyncServerDetails;
}

export class IdDriveAuthClient {
  public constructor(private readonly fetcher: Fetcher = fetch) {}

  public async authenticate(
    email: string,
    password: string,
  ): Promise<AuthenticationResult> {
    const accountUrl = new URL(accountDetailsUrl);
    accountUrl.searchParams.set("username", email);
    accountUrl.searchParams.set("password", password);

    const accountXml = await this.getText(accountUrl);
    const account = parseAccountDetails(accountXml);
    if (!account) {
      throw new Error(
        "IDrive Cloud Drive is not activated for this account; activate it in the official client before logging in",
      );
    }

    const serverUrl = new URL(syncServerUrl);
    serverUrl.searchParams.set("username", account.syncUsername);
    serverUrl.searchParams.set("password", account.syncPassword);
    const server = parseSyncServerDetails(await this.getText(serverUrl));

    return { account, server };
  }

  public async linkMachine(
    email: string,
    password: string,
    deviceId: string,
    deviceName: string,
  ): Promise<void> {
    const body = new URLSearchParams({
      app_type: "S",
      device_id: deviceId,
      device_name: deviceName,
      device_type: "1",
      password,
      username: email,
    });
    const response = await this.request(linkMachineUrl, {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const responseText = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(responseText) as unknown;
    } catch {
      throw new Error("IDrive returned an invalid machine-link response");
    }
    if (!isSuccessfulLinkResponse(data)) {
      throw new Error("IDrive rejected the machine-link request");
    }
  }

  private async getText(url: URL): Promise<string> {
    return await (await this.request(url)).text();
  }

  private async request(
    url: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`IDrive request failed with HTTP ${response.status}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isSuccessfulLinkResponse(value: unknown): boolean {
  if (!isRecord(value) || value.error) {
    return false;
  }
  const status = value.device_status ?? value.status ?? value.message;
  if (status === undefined) {
    return false;
  }
  if (status === false || status === 0) {
    return false;
  }
  if (status === true || status === 1) {
    return true;
  }
  if (typeof status === "string") {
    return /^(?:1|linked|ok|success(?:ful)?|y|yes)$/i.test(status.trim());
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
