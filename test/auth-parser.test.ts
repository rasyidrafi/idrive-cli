import { describe, expect, it } from "vitest";

import {
  parseAccountDetails,
  parseSyncServerDetails,
} from "../src/auth-parser.js";

describe("parseAccountDetails", () => {
  it("extracts activated Cloud Drive credentials", () => {
    const result = parseAccountDetails(`
      <root><login message="SUCCESS" username_sync="a1b2" password_sync="c3d4"
        enctype="DEFAULT" pns_sync="notify.idrive.com" /></root>
    `);

    expect(result).toEqual({
      encryptionType: "DEFAULT",
      notificationServer: "notify.idrive.com",
      syncPassword: "c3d4",
      syncUsername: "a1b2",
    });
  });

  it("returns null when Cloud Drive has not been activated", () => {
    expect(
      parseAccountDetails(
        '<root><login message="SUCCESS" enctype="DEFAULT" /></root>',
      ),
    ).toBeNull();
  });

  it("surfaces IDrive login failures without exposing credentials", () => {
    expect(() =>
      parseAccountDetails(
        '<root><login message="FAILURE" desc="Invalid username or password" /></root>',
      ),
    ).toThrow(/Google, Apple, or another SSO provider/i);
  });
});

describe("parseSyncServerDetails", () => {
  it("extracts the EVS server and quota metadata", () => {
    const result = parseSyncServerDetails(`
      <root><login message="SUCCESS" acctype="sync" evssrvr="s12.idrivesync.com"
        evssrvrip="192.0.2.10" evswebsrvr="w12.idrivesync.com"
        evswebsrvrip="192.0.2.11" enctype="DEFAULT" dedup="on"
        quota="1000" quota_used="250" /></root>
    `);

    expect(result).toEqual({
      accountType: "sync",
      dedup: true,
      encryptionType: "DEFAULT",
      quota: 1000,
      quotaUsed: 250,
      serverDns: "s12.idrivesync.com",
      serverIp: "192.0.2.10",
      webServerDns: "w12.idrivesync.com",
      webServerIp: "192.0.2.11",
    });
  });

  it("accepts a bare login document and maps dedup=off", () => {
    const result = parseSyncServerDetails(
      '<login acctype="sync" evssrvr="server" evswebsrvr="web" enctype="PRIVATE" dedup="off" />',
    );
    expect(result.dedup).toBe(false);
    expect(result.encryptionType).toBe("PRIVATE");
  });

  it("rejects incomplete server responses", () => {
    expect(() => parseSyncServerDetails("<root><login /></root>"))
      .toThrow(/missing evssrvr/i);
  });
});
