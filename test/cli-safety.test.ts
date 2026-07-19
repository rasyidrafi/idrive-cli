import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProcessRunner } from "../src/process-runner.js";

const executable = path.resolve("node_modules", ".bin", "tsx");
const cli = path.resolve("src", "cli.ts");
let isolatedDirectory = "";
let isolatedEnvironment: NodeJS.ProcessEnv;

describe("destructive CLI safeguards", () => {
  beforeAll(async () => {
    isolatedDirectory = await mkdtemp(path.join(tmpdir(), "idrive-cli-safety-"));
    isolatedEnvironment = {
      ...process.env,
      IDRIVE_CLI_CONFIG_DIR: path.join(isolatedDirectory, "config"),
      IDRIVE_CLI_DATA_DIR: path.join(isolatedDirectory, "data"),
    };
  });

  afterAll(async () => {
    if (isolatedDirectory) {
      await rm(isolatedDirectory, { force: true, recursive: true });
    }
  });

  it("reports the version from package.json", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--version"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it.each(["rm", "purge"])("requires --yes for %s", async (command) => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, command, "/Codex-Safety-Test"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/required option '--yes' not specified/i);
  });

  it.each(["rm", "purge"])("refuses the Cloud Drive root for %s", async (command) => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, command, "/", "--yes"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to delete the Cloud Drive root/i);
  });
});
