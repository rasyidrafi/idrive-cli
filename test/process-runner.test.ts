import { describe, expect, it, vi } from "vitest";

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

  it("terminates commands when aborted", async () => {
    const runner = new ProcessRunner();
    const controller = new AbortController();
    const result = runner.run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { killGraceMs: 20, signal: controller.signal },
    );
    controller.abort();
    await expect(result).rejects.toThrow(/aborted/i);
  });

  it("rejects an already aborted command without spawning it", async () => {
    const runner = new ProcessRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run(process.execPath, ["--version"], {
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i);
  });

  it("streams bounded output to observers", async () => {
    const onOutput = vi.fn();
    await new ProcessRunner().run(process.execPath, ["-e", "console.log('42%')"], { onOutput });
    expect(onOutput).toHaveBeenCalledWith("stdout", expect.stringContaining("42%"));
  });
});
