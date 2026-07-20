import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
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

  it("previews destructive commands without credentials or confirmation", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--dry-run", "rm", "/Preview"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Would remove \/Preview/);
  });

  it("emits structured JSON mutation plans", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--json", "--dry-run", "rm", "/Preview"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "rm",
      data: { dryRun: true, remotePath: "/Preview" },
    });
  });

  it("advertises recursive, diagnostic, and cleanup commands", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--help"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.stdout).toMatch(/upload-dir/);
    expect(result.stdout).toMatch(/download-dir/);
    expect(result.stdout).toMatch(/doctor/);
    expect(result.stdout).toMatch(/cleanup/);
  });

  it("emits structured JSON errors with stable exit codes", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--json", "stat", "/missing"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stderr)).toMatchObject({ schemaVersion: 1, error: { code: "engine" } });
  });

  it("uses conventional exit status when secret input is terminated", async () => {
    const child = spawn(executable, [cli, "login", "person@example.test", "--password-stdin"], {
      env: isolatedEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(143);
  });

  it("uses a private child without changing custom temp-root permissions", async () => {
    const shared = path.join(isolatedDirectory, "shared-temp");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--temp-dir", shared, "cleanup", "--older-than-hours", "24"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect((await stat(shared)).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(shared, "idrive-cli"))).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["--retries", "0"],
    ["--timeout-seconds", "2147484"],
    ["--transfers", "17"],
  ])("rejects invalid global option %s", async (option, value) => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, option, value, "--dry-run", "rm", "/Preview"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(2);
  });

  it("rejects non-aggregated progress with concurrent transfers", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--progress", "--transfers", "2", "--dry-run", "rm", "/Preview"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/progress requires/i);
  });

  it.each([
    ["setup", "--deb", "/does/not/exist.deb", "--trust-package"],
    ["login", "person@example.test"],
    ["logout"],
    ["download", "/Remote/file.txt", path.join(isolatedDirectory, "dry-download")],
    ["cleanup", "--older-than-hours", "24"],
  ])("dry-run prevents local mutation for %s", async (...command) => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--dry-run", ...command],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    await expect(stat(path.join(isolatedDirectory, "dry-download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns structured degraded doctor results without identifiers", async () => {
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--json", "doctor"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout) as { data: Array<{ name: string; status: string }> };
    expect(output.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "engine", status: "error" }),
      expect.objectContaining({ name: "profile", status: "error" }),
    ]));
    expect(result.stdout).not.toContain("encodedPassword");
  });

  it("preflights all directory names before an upload-dir mutation", async () => {
    const source = path.join(isolatedDirectory, "upload-tree-preflight");
    await mkdir(path.join(source, "valid-directory"), { recursive: true });
    await mkdir(path.join(source, "unsupported-directory "));
    const result = await new ProcessRunner().run(
      executable,
      [cli, "--dry-run", "upload-dir", source, "/Preflight"],
      { env: isolatedEnvironment, timeoutMs: 10_000 },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/ending in whitespace/i);
  });
});
