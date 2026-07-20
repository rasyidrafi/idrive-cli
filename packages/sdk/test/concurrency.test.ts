import { describe, expect, it, vi } from "vitest";

import { runFailFast } from "../src/concurrency.js";

describe("runFailFast", () => {
  it("aborts and awaits sibling workers after the first failure", async () => {
    const siblingFinished = vi.fn();
    await expect(runFailFast(["fail", "wait"], new AbortController().signal, async (value, signal) => {
      if (value === "fail") throw new Error("primary failure");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        siblingFinished();
        resolve();
      }, { once: true }));
    })).rejects.toThrow("primary failure");
    expect(siblingFinished).toHaveBeenCalledOnce();
  });
});
