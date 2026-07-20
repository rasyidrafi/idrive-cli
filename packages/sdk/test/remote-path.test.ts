import { describe, expect, it } from "vitest";

import { normalizeRemotePath, splitRemoteFilePath } from "../src/remote-path.js";

describe("normalizeRemotePath", () => {
  it("normalizes Cloud Drive paths to safe relative POSIX paths", () => {
    expect(normalizeRemotePath("/Videos//Trips/movie.mp4/"))
      .toBe("Videos/Trips/movie.mp4");
    expect(normalizeRemotePath("/")).toBe("");
    expect(normalizeRemotePath("Videos with spaces/movie.mp4")).toBe(
      "Videos with spaces/movie.mp4",
    );
  });

  it.each(["../secret", "Videos/../secret", "./video", "Videos/./video"])(
    "rejects traversal path %s",
    (value) => {
      expect(() => normalizeRemotePath(value)).toThrow(/relative path segments/i);
    },
  );

  it.each(["Videos\\movie.mp4", "Videos\nmovie.mp4", "Videos\0movie.mp4"])(
    "rejects unsafe list-file path %s",
    (value) => {
      expect(() => normalizeRemotePath(value)).toThrow(/unsafe/i);
    },
  );

  it("rejects segments ending in whitespace while preserving leading spaces", () => {
    expect(normalizeRemotePath("/ leading-space.txt")).toBe(" leading-space.txt");
    expect(() => normalizeRemotePath("/trailing-space.txt ")).toThrow(/ending in whitespace/i);
  });
});

describe("splitRemoteFilePath", () => {
  it("returns the parent directory and file name", () => {
    expect(splitRemoteFilePath("/Videos/movie.mp4")).toEqual({
      directory: "Videos",
      fileName: "movie.mp4",
    });
    expect(splitRemoteFilePath("movie.mp4")).toEqual({
      directory: "",
      fileName: "movie.mp4",
    });
  });

  it("rejects the Cloud Drive root as a file", () => {
    expect(() => splitRemoteFilePath("/")).toThrow(/file path/i);
  });
});
