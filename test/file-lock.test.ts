import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { withFileLock } from "../src/file-lock.js";

describe("withFileLock", () => {
  it("does not mistake operation EEXIST failures for lock contention", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-lock-"));
    try {
      const operation = vi.fn(() => Promise.reject(Object.assign(new Error("operation collision"), { code: "EEXIST" })));
      await expect(withFileLock(path.join(directory, "test.lock"), operation))
        .rejects.toThrow("operation collision");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
