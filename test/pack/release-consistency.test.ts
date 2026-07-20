import { describe, expect, it } from "vitest";

import { validateReleaseConsistency } from "./release-consistency.js";

const sdkPackage = {
  engines: { node: ">=22" },
  name: "@rasyidrafi/idrive-sdk",
  publishConfig: { access: "public" },
  version: "0.1.0",
};
const cliPackage = {
  dependencies: { "@rasyidrafi/idrive-sdk": "^0.1.0" },
  engines: { node: ">=22" },
  name: "idrive-cli",
  publishConfig: { access: "public" },
  version: "0.5.0",
};

describe("release metadata consistency", () => {
  it("accepts synchronized public package metadata", () => {
    expect(validateReleaseConsistency(sdkPackage, cliPackage)).toEqual([]);
  });

  it("rejects an SDK dependency range that was not bumped", () => {
    expect(validateReleaseConsistency(
      { ...sdkPackage, version: "0.2.0" },
      cliPackage,
    )).toContain("CLI SDK dependency must be ^0.2.0, received ^0.1.0");
  });

  it("rejects mismatched runtime support and unsafe publish metadata", () => {
    const errors = validateReleaseConsistency(
      { ...sdkPackage, private: true },
      { ...cliPackage, engines: { node: ">=24" }, publishConfig: {} },
    );

    expect(errors).toContain("SDK package must not be private");
    expect(errors).toContain("CLI publishConfig.access must be public");
    expect(errors).toContain("SDK and CLI must declare the same Node.js engine range");
  });
});
