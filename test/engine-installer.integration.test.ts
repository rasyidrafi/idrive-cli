import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EngineInstaller } from "../src/engine-installer.js";
import { EngineRunner } from "../src/engine-runner.js";
import type { AppLocations } from "../src/locations.js";
import { ProcessRunner } from "../src/process-runner.js";

const debPath = process.env.IDRIVE_TEST_DEB;
const suite = debPath ? describe : describe.skip;
let directory = "";
let locations: AppLocations;

suite("official IDrive package extraction", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "idrive-installer-test-"));
    locations = {
      configFile: path.join(directory, "config.json"),
      dataDirectory: directory,
      engineDirectory: path.join(directory, "bin"),
      manifestFile: path.join(directory, "engine.json"),
      temporaryDirectory: path.join(directory, "tmp"),
    };
  });

  afterAll(async () => {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("extracts and executes only the headless Cloud Drive engines", async () => {
    const runner = new ProcessRunner();
    const manifest = await new EngineInstaller(runner, locations)
      .installFromDeb(debPath ?? "");
    const engine = new EngineRunner(runner, locations);

    await expect(engine.isInstalled()).resolves.toBe(true);
    expect(manifest.engineDirectory).toMatch(/^releases\//);
    expect(manifest.packageVersion).toBe("1.8.0");
    expect(manifest.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await engine.encodeSecret("integration-test")).toMatch(/^[A-Za-z0-9+/=]+$/);
  }, 60_000);
});
