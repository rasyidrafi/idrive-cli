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
});
