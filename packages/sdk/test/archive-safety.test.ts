import { describe, expect, it } from "vitest";

import { validateArchiveTypes } from "../src/engine-installer.js";

describe("validateArchiveTypes", () => {
  it("accepts regular files and directories", () => {
    expect(() => validateArchiveTypes([
      "drwxr-xr-x user/group 0 2026-01-01 00:00 payload/",
      "-rwxr-xr-x user/group 12 2026-01-01 00:00 payload/engine",
    ].join("\n"))).not.toThrow();
  });

  it.each(["l", "h", "p", "c", "b"])("rejects archive type %s", (type) => {
    expect(() => validateArchiveTypes(`${type}rwxrwxrwx user/group 0 date unsafe`))
      .toThrow(/unsafe archive entry type/i);
  });
});
