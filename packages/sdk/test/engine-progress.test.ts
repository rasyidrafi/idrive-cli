import { describe, expect, it } from "vitest";

import { createProgressParser } from "../src/engine-runner.js";

describe("engine progress parsing", () => {
  it("handles percentages split across output chunks", () => {
    const values: number[] = [];
    const parse = createProgressParser((percent) => {
      values.push(percent);
    });
    parse("transferred 4");
    parse("2% then 100");
    parse("% done");
    expect(values).toEqual([42, 100]);
  });
});
