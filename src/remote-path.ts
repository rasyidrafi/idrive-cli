import path from "node:path";

const unsafeCharacters = /[\\\0\n\r]/;

export function normalizeRemotePath(value: string): string {
  if (unsafeCharacters.test(value)) {
    throw new Error("Remote path contains unsafe characters");
  }

  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Remote path cannot contain relative path segments");
  }

  return segments.join("/");
}

export function splitRemoteFilePath(value: string): {
  directory: string;
  fileName: string;
} {
  const normalized = normalizeRemotePath(value);
  if (normalized.length === 0) {
    throw new Error("A remote file path is required");
  }

  return {
    directory: path.posix.dirname(normalized) === "."
      ? ""
      : path.posix.dirname(normalized),
    fileName: path.posix.basename(normalized),
  };
}
