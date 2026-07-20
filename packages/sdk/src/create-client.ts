import { IdDriveAuthClient, type Fetcher } from "./auth-client.js";
import {
  CloudDriveClient,
  type AuthTransport,
  type ProfileStore,
  type TransferEngine,
} from "./cloud-drive-client.js";
import { ConfigStore } from "./config-store.js";
import { EngineRunner } from "./engine-runner.js";
import { EngineInstaller } from "./engine-installer.js";
import { defaultLocations, type AppLocations } from "./locations.js";
import { ProcessRunner, type CommandRunner } from "./process-runner.js";
import { cleanupStaleWorkspaces } from "./cloud-drive-client.js";
import { IDriveError } from "./errors.js";

export interface CloudDriveLocationOptions {
  configDirectory?: string;
  dataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  locations?: AppLocations;
  temporaryDirectory?: string;
}

export interface CreateCloudDriveClientOptions extends CloudDriveLocationOptions {
  auth?: AuthTransport;
  commandRunner?: CommandRunner;
  fetcher?: Fetcher;
  maxConcurrentOperations?: number;
  profileStore?: ProfileStore;
  transferEngine?: TransferEngine;
}

export interface CreateEngineInstallerOptions extends CloudDriveLocationOptions {
  commandRunner?: CommandRunner;
}

export function createCloudDriveClient(
  options: CreateCloudDriveClientOptions = {},
): CloudDriveClient {
  const locations = resolveCloudDriveLocations(options);
  const commandRunner = options.commandRunner ?? new ProcessRunner();
  const auth = options.auth ?? new IdDriveAuthClient(options.fetcher);
  const profileStore = options.profileStore ?? new ConfigStore(locations.configFile);
  const transferEngine = options.transferEngine ?? new EngineRunner(commandRunner, locations);

  return new CloudDriveClient(
    auth,
    profileStore,
    transferEngine,
    locations,
    options.maxConcurrentOperations ?? 1,
  );
}

export function createEngineInstaller(
  options: CreateEngineInstallerOptions = {},
): EngineInstaller {
  return new EngineInstaller(
    options.commandRunner ?? new ProcessRunner(),
    resolveCloudDriveLocations(options),
  );
}

export async function cleanupCloudDriveWorkspaces(
  options: CloudDriveLocationOptions = {},
  olderThanMs?: number,
): Promise<number> {
  const locations = resolveCloudDriveLocations(options);
  return olderThanMs === undefined
    ? await cleanupStaleWorkspaces(locations)
    : await cleanupStaleWorkspaces(locations, olderThanMs);
}

export async function diagnoseCloudDriveEngine(
  options: CreateEngineInstallerOptions = {},
): ReturnType<EngineRunner["diagnose"]> {
  return await new EngineRunner(
    options.commandRunner ?? new ProcessRunner(),
    resolveCloudDriveLocations(options),
  ).diagnose();
}

export function resolveCloudDriveLocations(options: CloudDriveLocationOptions = {}): AppLocations {
  if (
    options.locations
    && (
      options.configDirectory !== undefined
      || options.dataDirectory !== undefined
      || options.temporaryDirectory !== undefined
    )
  ) {
    throw new IDriveError("usage", "locations cannot be combined with directory overrides", "create client");
  }
  if (options.locations) return { ...options.locations };

  const environment = { ...(options.environment ?? process.env) };
  if (options.configDirectory !== undefined) {
    environment.IDRIVE_CLI_CONFIG_DIR = options.configDirectory;
  }
  if (options.dataDirectory !== undefined) {
    environment.IDRIVE_CLI_DATA_DIR = options.dataDirectory;
  }
  const locations = defaultLocations(environment);
  return options.temporaryDirectory === undefined
    ? locations
    : { ...locations, temporaryDirectory: options.temporaryDirectory };
}
