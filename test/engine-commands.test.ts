import { describe, expect, it } from "vitest";

import {
  buildDownloadCommand,
  buildDeleteCommand,
  buildListCommand,
  buildMkdirCommand,
  buildPurgeCommand,
  buildQuotaCommand,
  buildUploadCommand,
  selectEngineName,
} from "../src/engine-commands.js";
import type { EngineContext } from "../src/types.js";

const context: EngineContext = {
  encodedPassword: "encoded-password",
  encodedPrivateKey: "encoded-key",
  server: "sync.example.test",
  syncUsername: "a1b2c3",
};

describe("engine command construction", () => {
  it("selects the matching Cloud Drive engine", () => {
    expect(selectEngineName(false)).toBe("idevsutil_sync");
    expect(selectEngineName(true)).toBe("idevsutil_dedup_sync");
  });

  it("builds an upload command without invoking a shell", () => {
    expect(
      buildUploadCommand(context, {
        errorFile: "/tmp/error.xml",
        fileList: "/tmp/files.txt",
        localRoot: "/data",
        remoteDirectory: "/Videos",
        reportFile: "/tmp/report.xml",
        tempDirectory: "/tmp/work",
      }),
    ).toEqual([
      "--acl",
      "--xml-output",
      "--port=443",
      "--encode",
      "--password-file=encoded-password",
      "--pvt-key=encoded-key",
      "--100percent-progress",
      "--type",
      "--o=/tmp/report.xml",
      "--e=/tmp/error.xml",
      "--files-from=/tmp/files.txt",
      "/data/",
      "--temp=/tmp/work",
      "a1b2c3@sync.example.test::ibackup/Videos/",
    ]);
  });

  it("builds list, download, mkdir, and quota commands", () => {
    expect(
      buildListCommand(context, {
        errorFile: "/tmp/error.xml",
        remotePath: "/Videos",
        reportFile: "/tmp/report.xml",
      }).at(-1),
    ).toBe("a1b2c3@sync.example.test::home/Videos");

    const downloadCommand = buildDownloadCommand(context, {
        destination: "/downloads",
        errorFile: "/tmp/error.xml",
        fileList: "/tmp/files.txt",
        reportFile: "/tmp/report.xml",
        tempDirectory: "/tmp/work",
      });
    expect(downloadCommand).toContain("--chmod=u=rwX,go=");
    expect(downloadCommand.slice(-2)).toEqual([
      "a1b2c3@sync.example.test::home/",
      "/downloads/",
    ]);

    expect(
      buildMkdirCommand(context, {
        errorFile: "/tmp/error.xml",
        remotePath: "/Videos/Uploads",
      }).slice(-2),
    ).toEqual([
      "--e=/tmp/error.xml",
      "a1b2c3@sync.example.test::ibackup/",
    ]);

    expect(
      buildQuotaCommand(context, {
        errorFile: "/tmp/error.xml",
        reportFile: "/tmp/report.xml",
      }).at(-1),
    ).toBe("a1b2c3@sync.example.test::home/");

    expect(buildDeleteCommand(context, {
      errorFile: "/tmp/error.xml",
      fileList: "/tmp/delete.txt",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining([
      "--delete-items",
      "--files-from=/tmp/delete.txt",
      "a1b2c3@sync.example.test::home/",
    ]));

    expect(buildPurgeCommand(context, {
      errorFile: "/tmp/error.xml",
      fileList: "/tmp/delete.txt",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining([
      "--deletefrom-trash",
      "--files-from=/tmp/delete.txt",
      "a1b2c3@sync.example.test::home/",
    ]));
  });
});
