import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultLocations } from "../src/locations.js";

describe("defaultLocations", () => {
  it("uses only the idrive-cli environment names", () => {
    const locations = defaultLocations({
      IDRIVE_CLI_CONFIG_DIR: "/tmp/idrive-cli-config",
      IDRIVE_CLI_DATA_DIR: "/tmp/idrive-cli-data",
    });

    expect(locations.configFile).toBe(
      path.join("/tmp/idrive-cli-config", "config.json"),
    );
    expect(locations.dataDirectory).toBe("/tmp/idrive-cli-data");
    expect(locations.engineDirectory).toBe(
      path.join("/tmp/idrive-cli-data", "bin"),
    );
  });

  it("uses idrive-cli directories below the XDG roots", () => {
    const locations = defaultLocations({
      XDG_CONFIG_HOME: "/tmp/current-config",
      XDG_DATA_HOME: "/tmp/current-data",
    });

    expect(locations.configFile).toBe(
      path.join("/tmp/current-config", "idrive-cli", "config.json"),
    );
    expect(locations.dataDirectory).toBe(
      path.join("/tmp/current-data", "idrive-cli"),
    );
  });
});
