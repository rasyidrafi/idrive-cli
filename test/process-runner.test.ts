import { describe, expect, it } from "vitest";

import { ProcessRunner } from "../src/process-runner.js";

describe("ProcessRunner", () => {
  it("terminates commands that exceed their timeout", async () => {
    const runner = new ProcessRunner();

    await expect(
      runner.run(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { killGraceMs: 20, timeoutMs: 30 },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
