import { describe, expect, it } from "vitest";

import { parseListReport, parseQuotaReport } from "../src/report-parser.js";

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
