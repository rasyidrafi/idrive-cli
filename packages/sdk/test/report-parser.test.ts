import { describe, expect, expectTypeOf, it } from "vitest";

import type { CloudDriveEngineVersion, CloudDriveServerVersion } from "../src/index.js";

import {
  parseChangesReport,
  parseClientVersionReport,
  parseDirectorySizeReport,
  parseItemsStatusReport,
  parseListReport,
  parsePropertiesReport,
  parseQuotaReport,
  parseSearchReport,
  parseServerVersionReport,
  parseVersionsReport,
} from "../src/report-parser.js";

describe("parseListReport", () => {
  it("parses the XML fragments emitted by idevsutil", () => {
    const result = parseListReport(`
      <item restype="D" fname="Uploads" size="0" />
      <item restype="F" fname="movie &amp; one.mp4" size="42" mod_time="2026/01/02 03:04:05" />
    `);

    expect(result).toEqual([
      { name: "Uploads", size: 0, type: "directory" },
      {
        modifiedAt: "2026/01/02 03:04:05",
        name: "movie & one.mp4",
        size: 42,
        type: "file",
      },
    ]);
  });

  it("retains rich Cloud Drive metadata", () => {
    expect(parseListReport('<item restype="F" fname="movie.mp4" size="42" file_ver="3" thumb="1" url="NA" chk="abc"/>'))
      .toEqual([{
        checksum: "abc",
        name: "movie.mp4",
        size: 42,
        thumbnailAvailable: true,
        type: "file",
        version: 3,
      }]);
  });

  it("returns an empty list for an empty report", () => {
    expect(parseListReport("\n")).toEqual([]);
    expect(parseListReport("connection established\n")).toEqual([]);
    expect(parseListReport([
      "connection established",
      "receiving file list ... ",
      "",
      "sent 4 bytes  received 9 bytes  8.67 bytes/sec",
    ].join("\n"))).toEqual([]);
  });

  it("surfaces engine-level list errors after the connection preamble", () => {
    expect(() => parseListReport('connection established\n<tree message="ERROR" desc="temporary list failure"/>'))
      .toThrow(/temporary list failure/i);
    expect(() => parseListReport("<tree desc='attribute order &amp; quote failure' message='ERROR'/>") )
      .toThrow(/attribute order & quote failure/i);
  });

  it("preserves leading and trailing spaces in file names", () => {
    expect(parseListReport('<item restype="F" fname=" spaced " size="1"/>'))
      .toEqual([{ name: " spaced ", size: 1, type: "file" }]);
  });

  it("rejects unknown and malformed non-empty reports", () => {
    expect(() => parseListReport("<garbage/>")).toThrow(/invalid/i);
    expect(() => parseListReport("<item>text</item>")).toThrow(/invalid/i);
  });

  it.each(["../escape", "folder/file", "folder\\file", ".", "..", "bad\nname"])(
    "rejects unsafe engine names: %s",
    (name) => {
      expect(() => parseListReport(`<item restype="F" fname="${name}" size="1" />`))
        .toThrow(/unsafe/i);
    },
  );

  it("rejects XML declarations and entities", () => {
    expect(() => parseListReport('<!DOCTYPE x [<!ENTITY y "boom">]><item restype="F" fname="&y;" />'))
      .toThrow(/doctype|entity/i);
  });

  it("rejects unsafe numeric sizes", () => {
    expect(() => parseListReport('<item restype="F" fname="x" size="9007199254740992" />'))
      .toThrow(/size/i);
  });
});

describe("Cloud Drive discovery report parsers", () => {
  it("retains the legacy server-version type alias", () => {
    expectTypeOf<CloudDriveServerVersion>().toEqualTypeOf<CloudDriveEngineVersion>();
  });

  it("parses search results and totals", () => {
    expect(parseSearchReport(`
      connection established
      <item mod_time="2026/01/02 03:04:05" size="42" file_ver="2" in_trash="1" thumb="1" chk="abc" url="NA" label="work" fname="/Videos/movie.mp4" soft_link="0"/>
      <item files_found="1"/>
    `)).toEqual({
      entries: [{
        checksum: "abc",
        inTrash: true,
        label: "work",
        modifiedAt: "2026/01/02 03:04:05",
        path: "Videos/movie.mp4",
        size: 42,
        softLink: false,
        thumbnailAvailable: true,
        type: "file",
        version: 2,
      }],
      total: 1,
    });
  });

  it("parses properties, folder size, status, versions, and server version", () => {
    expect(parsePropertiesReport(`
      <item create_time="2026/01/01 00:00:00"/>
      <item access_time="2026/01/02 00:00:00"/>
      <item mod_time="2026/01/03 00:00:00"/>
      <item files_count="4"/>
      <item size="27 bytes"/>
    `)).toEqual({
      accessedAt: "2026/01/02 00:00:00",
      createdAt: "2026/01/01 00:00:00",
      fileCount: 4,
      modifiedAt: "2026/01/03 00:00:00",
      size: 27,
    });
    expect(parseDirectorySizeReport('<item folder_size="27 Bytes"/><item files_count="4"/>'))
      .toEqual({ fileCount: 4, size: 27 });
    expect(parseItemsStatusReport('<item status="file exists" fname="/a.txt"/><item status="directory exists" fname="/dir/"/>'))
      .toEqual([
        { exists: true, path: "a.txt", type: "file" },
        { exists: true, path: "dir", type: "directory" },
      ]);
    expect(parseVersionsReport('<item mod_time="2026/01/01 00:00:00" size="12" ver="1"/>'))
      .toEqual([{ modifiedAt: "2026/01/01 00:00:00", size: 12, version: 1 }]);
    expect(parseVersionsReport("connection established\nNo version found\n")).toEqual([]);
    expect(parseServerVersionReport("connection established\nidevs version 2.0.0 release date [] [SYNC_DEDUP] [RELEASE] [1.0.0.0] [22/APRIL/2026]\n"))
      .toMatchObject({ releaseDate: "22/APRIL/2026", variant: "SYNC_DEDUP", version: "2.0.0" });
    expect(parseClientVersionReport("idevsutil version 1.0.2.8 release date [CG] [SYNC-DEDUP] [RELEASE] [1.0.0.0] [02/DEC/2025]"))
      .toMatchObject({ releaseDate: "02/DEC/2025", variant: "SYNC-DEDUP", version: "1.0.2.8" });
  });

  it("parses incremental changes and returns the largest cursor", () => {
    expect(parseChangesReport(`
      <item mod_time="2026/01/02" size="42" file_ver="2" in_trash="0" thumb="1" index="100" fnameold="/old.txt" ref_id="7" rc_id="9" chk="abc" url="NA" fname="/new.txt" soft_link="0"/>
      <item mod_time="2026/01/03" size="0" file_ver="0" in_trash="2" thumb="0" index="101" fnameold="" ref_id="8" rc_id="9" chk="NA" url="NA" fname="/gone/" soft_link="0"/>
    `)).toEqual({
      changes: [
        expect.objectContaining({ cursor: "100", path: "new.txt", previousPath: "old.txt", trashState: 0 }),
        expect.objectContaining({ cursor: "101", path: "gone", trashState: 2, type: "directory" }),
      ],
      nextCursor: "101",
    });
  });

  it("rejects unsafe discovery paths and numeric values", () => {
    expect(() => parseSearchReport('<item fname="/../escape" size="1"/>')).toThrow(/unsafe/i);
    expect(() => parseChangesReport('<item fname="/x" index="not-a-number"/>')).toThrow(/index/i);
    expect(() => parseDirectorySizeReport('<item folder_size="999999999999999999 Bytes"/>')).toThrow(/size/i);
  });
});

describe("parseQuotaReport", () => {
  it("parses byte totals", () => {
    expect(parseQuotaReport('<quota totalquota="1000" usedquota="250" />'))
      .toEqual({ total: 1000, used: 250 });
  });

  it("rejects malformed quota output", () => {
    expect(() => parseQuotaReport("<quota />")).toThrow(/quota/i);
  });

  it("rejects unsafe or inconsistent quota values", () => {
    expect(() => parseQuotaReport('<quota totalquota="10" usedquota="11" />'))
      .toThrow(/quota/i);
    expect(() => parseQuotaReport('<quota totalquota="9007199254740992" usedquota="1" />'))
      .toThrow(/quota/i);
  });
});
