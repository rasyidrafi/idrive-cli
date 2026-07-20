import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readTextFileLimited, responseTextLimited } from "../src/bounded-input.js";

describe("bounded input", () => {
  it("rejects oversized files before reading them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "idrive-bounds-"));
    try {
      const file = path.join(directory, "report.xml");
      await writeFile(file, "12345");
      await expect(readTextFileLimited(file, 4)).rejects.toThrow(/limit/i);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects declared and streamed oversized responses", async () => {
    await expect(responseTextLimited(new Response("small", {
      headers: { "content-length": "100" },
    }), 10)).rejects.toThrow(/limit/i);
    await expect(responseTextLimited(new Response("too large"), 4))
      .rejects.toThrow(/limit/i);
  });
});
