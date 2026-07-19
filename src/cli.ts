#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { Command } from "commander";

import { IdDriveAuthClient } from "./auth-client.js";
import { CloudDriveClient } from "./cloud-drive-client.js";
import { ConfigStore } from "./config-store.js";
import { EngineInstaller } from "./engine-installer.js";
import { EngineRunner } from "./engine-runner.js";
import { defaultLocations } from "./locations.js";
import { ProcessRunner } from "./process-runner.js";

interface LoginCommandOptions {
  link: boolean;
  passwordStdin?: boolean;
}

interface ListCommandOptions {
  json?: boolean;
}

const locations = defaultLocations();
const processRunner = new ProcessRunner();
const engineRunner = new EngineRunner(processRunner, locations);
const client = new CloudDriveClient(
  new IdDriveAuthClient(),
  new ConfigStore(locations.configFile),
  engineRunner,
  locations,
);

export async function main(arguments_: readonly string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("idrive-cli")
    .description("Headless CLI for IDrive Cloud Drive (Sync storage)")
    .version("0.1.0")
    .showHelpAfterError();

  program.command("setup")
    .description("Extract the Cloud Drive transfer engine from the official IDrive .deb")
    .requiredOption("--deb <path>", "path to the official IDriveForLinux.deb")
    .requiredOption(
      "--trust-package",
      "confirm that the supplied package came from a trusted IDrive source",
    )
    .action(async (options: { deb: string; trustPackage: boolean }) => {
      const manifest = await new EngineInstaller(processRunner, locations)
        .installFromDeb(options.deb);
      process.stdout.write(
        `Installed IDrive Cloud Drive engine${manifest.packageVersion ? ` ${manifest.packageVersion}` : ""}\n`,
      );
      process.stdout.write(`Source SHA-256: ${manifest.sourceSha256}\n`);
    });

  program.command("login")
    .description("Authenticate and store encoded Cloud Drive transfer credentials")
    .argument("<email>", "IDrive account email")
    .option("--password-stdin", "read the account password from standard input")
    .option("--no-link", "do not link this server as an IDrive Sync device")
    .action(async (email: string, options: LoginCommandOptions) => {
      const password = await accountPassword(options.passwordStdin === true);
      const profile = await client.login(email, password, {
        linkMachine: options.link,
        privateKeyProvider: async () =>
          process.env.IDRIVE_PRIVATE_KEY ?? await readSecret("Private encryption key: "),
      });
      process.stdout.write(`Logged in to IDrive Cloud Drive as ${profile.email}\n`);
    });

  program.command("logout")
    .description("Remove the locally stored Cloud Drive profile")
    .action(async () => {
      await client.logout();
      process.stdout.write("Local IDrive Cloud Drive credentials removed\n");
    });

  program.command("status")
    .description("Show local engine and authentication status")
    .action(async () => {
      const status = await client.status();
      process.stdout.write(`Engine: ${status.engineInstalled ? "installed" : "not installed"}\n`);
      process.stdout.write(`Login: ${status.loggedIn ? status.email : "not logged in"}\n`);
      if (status.server) {
        process.stdout.write(`Server: ${status.server}\n`);
      }
    });

  program.command("upload")
    .description("Upload one local file; the original file name is preserved")
    .argument("<file>", "local file")
    .argument("[remote-directory]", "Cloud Drive destination directory", "/")
    .action(async (file: string, remoteDirectory: string) => {
      await client.upload(file, remoteDirectory);
      process.stdout.write(
        `Uploaded ${path.basename(file)} to /${remoteDirectory.replace(/^\/+|\/+$/g, "")}\n`,
      );
    });

  program.command("ls")
    .description("List a Cloud Drive directory")
    .argument("[remote-path]", "Cloud Drive directory", "/")
    .option("--json", "print machine-readable JSON")
    .action(async (remotePath: string, options: ListCommandOptions) => {
      const entries = await client.list(remotePath);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        return;
      }
      for (const entry of entries) {
        process.stdout.write(
          `${entry.type === "directory" ? "d" : "f"}\t${entry.size ?? "-"}\t${entry.name}\n`,
        );
      }
    });

  program.command("download")
    .description("Download a Cloud Drive file into a local directory")
    .argument("<remote-file>", "Cloud Drive file path")
    .argument("[destination]", "local destination directory", ".")
    .action(async (remoteFile: string, destination: string) => {
      const expectedPath = await client.download(remoteFile, destination);
      process.stdout.write(`Download completed; expected path: ${expectedPath}\n`);
    });

  program.command("mkdir")
    .description("Create a Cloud Drive directory")
    .argument("<remote-path>", "Cloud Drive directory path")
    .action(async (remotePath: string) => {
      await client.createDirectory(remotePath);
      process.stdout.write(`Created /${remotePath.replace(/^\/+|\/+$/g, "")}\n`);
    });

  program.command("rm")
    .description("Move one Cloud Drive file or directory tree to trash")
    .argument("<remote-path>", "Cloud Drive path to remove")
    .requiredOption("--yes", "confirm the remote removal")
    .action(async (remotePath: string) => {
      await client.remove(remotePath);
      process.stdout.write(`Removed /${remotePath.replace(/^\/+|\/+$/g, "")}\n`);
    });

  program.command("purge")
    .description("Permanently delete one scoped path from Cloud Drive trash")
    .argument("<remote-path>", "Cloud Drive trash path to permanently delete")
    .requiredOption("--yes", "confirm permanent deletion")
    .action(async (remotePath: string) => {
      await client.purgeTrash(remotePath);
      process.stdout.write(
        `Permanently deleted /${remotePath.replace(/^\/+|\/+$/g, "")} from trash\n`,
      );
    });

  program.command("quota")
    .description("Show Cloud Drive storage usage")
    .action(async () => {
      const quota = await client.quota();
      process.stdout.write(`Used: ${formatBytes(quota.used)}\n`);
      process.stdout.write(`Total: ${formatBytes(quota.total)}\n`);
    });

  await program.parseAsync([...arguments_]);
}

async function accountPassword(fromStdin: boolean): Promise<string> {
  const environmentPassword = process.env.IDRIVE_PASSWORD;
  if (environmentPassword !== undefined) {
    return environmentPassword;
  }
  if (fromStdin) {
    return (await readStandardInput()).replace(/[\r\n]+$/, "");
  }
  return await readSecret("IDrive password: ");
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "A TTY is required for secret input; use IDRIVE_PASSWORD, IDRIVE_PRIVATE_KEY, or --password-stdin",
    );
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return await new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Secret input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    process.stdin.on("data", onData);
  });
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = units[0] ?? "B";
  for (const candidate of units) {
    unit = candidate;
    if (Math.abs(amount) < 1024 || candidate === units.at(-1)) {
      break;
    }
    amount /= 1024;
  }
  return `${amount.toFixed(amount >= 10 || unit === "B" ? 0 : 1)} ${unit}`;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
