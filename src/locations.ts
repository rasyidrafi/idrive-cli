import os from "node:os";
import path from "node:path";

export interface AppLocations {
  configFile: string;
  dataDirectory: string;
  engineDirectory: string;
  manifestFile: string;
  temporaryDirectory: string;
}

export function defaultLocations(environment: NodeJS.ProcessEnv = process.env): AppLocations {
  const home = os.homedir();
  const configRoot = environment.IDRIVE_CLOUD_CONFIG_DIR
    ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "idrive-cloud");
  const dataDirectory = environment.IDRIVE_CLOUD_DATA_DIR
    ?? path.join(environment.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "idrive-cloud");

  return {
    configFile: path.join(configRoot, "config.json"),
    dataDirectory,
    engineDirectory: path.join(dataDirectory, "bin"),
    manifestFile: path.join(dataDirectory, "engine.json"),
    temporaryDirectory: path.join(dataDirectory, "tmp"),
  };
}
