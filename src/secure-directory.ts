import { chmod, lstat, mkdir } from "node:fs/promises";

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Unsafe private directory: ${directory}`);
  }
  if (process.getuid && metadata.uid !== process.getuid()) {
    throw new Error(`Private directory is owned by another user: ${directory}`);
  }
  await chmod(directory, 0o700);
}
