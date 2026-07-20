import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  name?: string;
  private?: boolean;
  publishConfig?: { access?: string };
  version?: string;
}

export function validateReleaseConsistency(
  sdkPackage: PackageManifest,
  cliPackage: PackageManifest,
): string[] {
  const errors: string[] = [];
  const sdkVersion = validatedVersion(sdkPackage, "SDK", errors);
  validatedVersion(cliPackage, "CLI", errors);

  validatePackageName(sdkPackage, "SDK", "idrive-sdk", errors);
  validatePackageName(cliPackage, "CLI", "idrive-cli", errors);

  if (sdkPackage.private === true) errors.push("SDK package must not be private");
  if (cliPackage.private === true) errors.push("CLI package must not be private");
  if (sdkPackage.publishConfig?.access !== "public") errors.push("SDK publishConfig.access must be public");
  if (cliPackage.publishConfig?.access !== "public") errors.push("CLI publishConfig.access must be public");
  if (sdkPackage.engines?.node !== cliPackage.engines?.node) {
    errors.push("SDK and CLI must declare the same Node.js engine range");
  }

  if (sdkVersion !== undefined) {
    const expectedRange = `^${sdkVersion}`;
    const actualRange = cliPackage.dependencies?.["idrive-sdk"];
    if (actualRange !== expectedRange) {
      errors.push(`CLI SDK dependency must be ${expectedRange}, received ${actualRange ?? "missing"}`);
    }
  }

  return errors;
}

function validatePackageName(
  package_: PackageManifest,
  label: string,
  expectedName: string,
  errors: string[],
): void {
  if (package_.name !== expectedName) {
    errors.push(`${label} package name must be ${expectedName}, received ${package_.name ?? "missing"}`);
  }
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const [sdkPackage, cliPackage] = await Promise.all([
    readPackage(path.join(workspace, "packages/sdk/package.json")),
    readPackage(path.join(workspace, "packages/cli/package.json")),
  ]);
  const errors = validateReleaseConsistency(sdkPackage, cliPackage);
  if (errors.length > 0) {
    throw new Error(`Release metadata is inconsistent:\n- ${errors.join("\n- ")}`);
  }

  process.stdout.write(
    `Release metadata is consistent. Publish ${sdkPackage.name}@${sdkPackage.version} before ${cliPackage.name}@${cliPackage.version}.\n`,
  );
}

function validatedVersion(
  package_: PackageManifest,
  label: string,
  errors: string[],
): string | undefined {
  if (package_.version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(package_.version)) {
    errors.push(`${label} package must have a valid publishable semantic version`);
    return undefined;
  }
  if (package_.version === "0.0.0") {
    errors.push(`${label} package version must not be the workspace placeholder 0.0.0`);
  }
  return package_.version;
}

async function readPackage(filename: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(filename, "utf8")) as PackageManifest;
}

const executablePath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (executablePath === fileURLToPath(import.meta.url)) {
  await main();
}
