import path from "node:path";
import { IdriveError } from "./errors.js";

const unsafeCharacters = /[\\\0\n\r]/;

export function normalizeRemotePath(value: string): string {
  if (unsafeCharacters.test(value)) {
    throw new IdriveError("usage", "Remote path contains unsafe characters");
  }

  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new IdriveError("usage", "Remote path cannot contain relative path segments");
  }
  if (segments.some((segment) => /\s$/.test(segment))) {
    throw new IdriveError("usage", "Remote path segments ending in whitespace are unsupported by the IDrive engine");
  }

  return segments.join("/");
}

export function splitRemoteFilePath(value: string): {
  directory: string;
  fileName: string;
} {
  const normalized = normalizeRemotePath(value);
  if (normalized.length === 0) {
    throw new IdriveError("usage", "A remote file path is required");
  }

  return {
    directory: path.posix.dirname(normalized) === "."
      ? ""
      : path.posix.dirname(normalized),
    fileName: path.posix.basename(normalized),
  };
}
