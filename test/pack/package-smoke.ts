import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const workspace = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "idrive-package-smoke-"));
const cliPackage = JSON.parse(await readFile(path.join(workspace, "packages/cli/package.json"), "utf8")) as {
  version: string;
};

try {
  const staleSdkOutput = path.join(workspace, "packages/sdk/dist/stale-output.js");
  const staleCliOutput = path.join(workspace, "packages/cli/dist/stale-output.js");
  await Promise.all([
    mkdir(path.dirname(staleSdkOutput), { recursive: true }),
    mkdir(path.dirname(staleCliOutput), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(staleSdkOutput, "throw new Error('stale SDK output');\n"),
    writeFile(staleCliOutput, "throw new Error('stale CLI output');\n"),
  ]);

  const sdkArchive = await pack("packages/sdk");
  const cliArchive = await pack("packages/cli");
  await Promise.all([
    expectMissing(staleSdkOutput),
    expectMissing(staleCliOutput),
  ]);
  const consumerDirectory = path.join(temporaryDirectory, "consumer");

  await writeFile(path.join(temporaryDirectory, "package.json"), "{}\n");
  await mkdir(consumerDirectory);
  await writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: "idrive-sdk-package-smoke",
    private: true,
    type: "module",
  }, null, 2)}\n`);
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    sdkArchive,
    cliArchive,
  ], { cwd: consumerDirectory });

  await writeFile(path.join(consumerDirectory, "consumer.mjs"), `
import {
  CloudDriveClient,
  EngineInstaller,
  IDriveAuthClient,
  IDriveError,
  IdriveError,
  createCloudDriveClient,
  createEngineInstaller,
} from "idrive-sdk";
import {
  CloudDriveClient as CompatibleCloudDriveClient,
  createCloudDriveClient as compatibleFactory,
} from "idrive-cli";
import { createCloudDriveClient as deepCompatibleFactory } from "idrive-cli/dist/index.js";

const client = createCloudDriveClient({
  configDirectory: new URL("./config", import.meta.url).pathname,
  dataDirectory: new URL("./data", import.meta.url).pathname,
});
const installer = createEngineInstaller({
  configDirectory: new URL("./config", import.meta.url).pathname,
  dataDirectory: new URL("./data", import.meta.url).pathname,
});
if (!(client instanceof CloudDriveClient)) throw new Error("SDK factory returned the wrong client");
if (!(installer instanceof EngineInstaller)) throw new Error("SDK installer factory returned the wrong installer");
if (typeof IDriveAuthClient !== "function") throw new Error("Canonical SDK auth client is not exported");
if (CompatibleCloudDriveClient !== CloudDriveClient) throw new Error("CLI compatibility export is broken");
if (compatibleFactory !== createCloudDriveClient) throw new Error("CLI factory compatibility export is broken");
if (deepCompatibleFactory !== createCloudDriveClient) throw new Error("CLI deep index compatibility export is broken");
if (new IDriveError("usage", "test").code !== "usage") throw new Error("Canonical SDK error is not exported");
if (IdriveError !== IDriveError) throw new Error("Deprecated SDK error alias is broken");
`);
  await run("node", ["consumer.mjs"], { cwd: consumerDirectory });

  await writeFile(path.join(consumerDirectory, "consumer.ts"), `
import {
  IDriveError,
  createCloudDriveClient,
  createEngineInstaller,
  type CloudDriveEntry,
} from "idrive-sdk";
import { createCloudDriveClient as compatibleFactory } from "idrive-cli/dist/index.js";

const client = createCloudDriveClient();
const entries: Promise<CloudDriveEntry[]> = client.list("/");
const installer = createEngineInstaller();
const error: IDriveError = new IDriveError("usage", "test");
const compatibleClient = compatibleFactory();
void entries;
void error;
void installer;
void compatibleClient;
`);
  await writeFile(path.join(consumerDirectory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
      types: ["node"],
    },
    include: ["consumer.ts"],
  }, null, 2)}\n`);
  try {
    await run(path.join(workspace, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
      cwd: consumerDirectory,
    });
  } catch (error) {
    if (hasCommandOutput(error)) {
      throw new Error(`Packed SDK declarations failed external typechecking:\n${error.stdout}${error.stderr}`, {
        cause: error,
      });
    }
    throw error;
  }

  const cliResult = await run(path.join(consumerDirectory, "node_modules", ".bin", "idrive-cli"), ["--version"], {
    cwd: consumerDirectory,
  });
  if (cliResult.stdout.trim() !== cliPackage.version) {
    throw new Error(`Packed CLI reported unexpected version: ${cliResult.stdout.trim()}`);
  }
} finally {
  if (process.env.IDRIVE_PACK_KEEP === "1") {
    process.stderr.write(`Packed-package workspace retained at ${temporaryDirectory}\n`);
  } else {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function pack(packageDirectory: string): Promise<string> {
  const result = await run("npm", [
    "pack",
    "--json",
    "--pack-destination",
    temporaryDirectory,
  ], { cwd: path.join(workspace, packageDirectory) });
  const reports = JSON.parse(result.stdout) as Array<{ filename?: unknown }>;
  const filename = reports[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error(`npm pack did not report an archive for ${packageDirectory}`);
  }
  return path.join(temporaryDirectory, filename);
}

function hasCommandOutput(error: unknown): error is Error & { stderr: string; stdout: string } {
  return error instanceof Error
    && "stderr" in error
    && typeof error.stderr === "string"
    && "stdout" in error
    && typeof error.stdout === "string";
}

async function expectMissing(filename: string): Promise<void> {
  try {
    await access(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Clean package build retained stale output: ${filename}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
