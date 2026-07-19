import { describe, expect, it } from "vitest";

import {
  embeddedPayload,
  engineArchiveForArchitecture,
} from "../src/setup-extractor.js";

describe("embeddedPayload", () => {
  it("returns bytes after the official self-extractor marker", () => {
    const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    const wrapper = Buffer.concat([
      Buffer.from("#!/bin/bash\necho setup\n__idrive__\n"),
      archive,
    ]);
    expect(embeddedPayload(wrapper)).toEqual(archive);
  });

  it("rejects packages without the marker", () => {
    expect(() => embeddedPayload(Buffer.from("not an IDrive bundle")))
      .toThrow(/marker/i);
  });
});

describe("engineArchiveForArchitecture", () => {
  it("selects the official Linux x64 engine archive", () => {
    expect(engineArchiveForArchitecture("x64")).toBe("IDrive_linux_64bit.tar.gz");
  });

  it("rejects architectures unavailable in the desktop package", () => {
    expect(() => engineArchiveForArchitecture("arm64")).toThrow(/unsupported/i);
  });
});
