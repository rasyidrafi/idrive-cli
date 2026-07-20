import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { EncryptionType, StoredProfile } from "./types.js";
import { withFileLock } from "./file-lock.js";
import { ensurePrivateDirectory } from "./secure-directory.js";

export class ConfigStore {
  public constructor(public readonly filePath: string) {}

  public async load(): Promise<StoredProfile | null> {
    let text: string;
    try {
      const metadata = await lstat(this.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Unsafe IDrive Cloud Drive profile file");
      }
      if (process.getuid && metadata.uid !== process.getuid()) {
        throw new Error("IDrive Cloud Drive profile is owned by another user");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("IDrive Cloud Drive profile permissions are too open");
      }
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
    await withFileLock(`${this.filePath}.lock`, async () => this.saveUnlocked(profile));
  }

  private async saveUnlocked(profile: StoredProfile): Promise<void> {
    const validated = validateProfile(profile);
    const directory = path.dirname(this.filePath);
    const temporaryFile = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );

    await ensurePrivateDirectory(directory);
    try {
      const handle = await open(temporaryFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryFile, this.filePath);
      await chmod(this.filePath, 0o600);
      const directoryHandle = await open(directory, "r");
      await directoryHandle.sync();
      await directoryHandle.close();
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  public async clear(): Promise<void> {
    await withFileLock(`${this.filePath}.lock`, async () => {
      await rm(this.filePath, { force: true });
      const directory = path.dirname(this.filePath);
      await ensurePrivateDirectory(directory);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    });
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
