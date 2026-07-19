import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EncryptionType, StoredProfile } from "./types.js";

export class ConfigStore {
  public constructor(public readonly filePath: string) {}

  public async load(): Promise<StoredProfile | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    return validateProfile(JSON.parse(text) as unknown);
  }

  public async save(profile: StoredProfile): Promise<void> {
    const validated = validateProfile(profile);
    const directory = path.dirname(this.filePath);
    const temporaryFile = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );

    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporaryFile, `${JSON.stringify(validated, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryFile, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  public async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function validateProfile(value: unknown): StoredProfile {
  if (!isRecord(value)) {
    throw new Error("Invalid IDrive Cloud Drive profile");
  }

  return {
    dedup: requiredBoolean(value, "dedup"),
    email: requiredString(value, "email"),
    encodedPassword: requiredString(value, "encodedPassword"),
    encodedPrivateKey: requiredString(value, "encodedPrivateKey"),
    encryptionType: requiredEncryptionType(value, "encryptionType"),
    server: requiredString(value, "server"),
    syncUsername: requiredString(value, "syncUsername"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid profile field: ${key}`);
  }
  return field;
}

function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`Invalid profile field: ${key}`);
  }
  return field;
}

function requiredEncryptionType(
  value: Record<string, unknown>,
  key: string,
): EncryptionType {
  const field = value[key];
  if (field !== "DEFAULT" && field !== "PRIVATE") {
    throw new Error(`Invalid profile field: ${key}`);
  }
  return field;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
