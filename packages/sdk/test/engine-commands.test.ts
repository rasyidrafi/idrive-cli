import { describe, expect, it } from "vitest";

import {
  buildChangesCommand,
  buildClientVersionCommand,
  buildCopyCommand,
  buildDownloadCommand,
  buildDeleteCommand,
  buildDirectorySizeCommand,
  buildEmptyTrashCommand,
  buildItemsStatusCommand,
  buildListCommand,
  buildMkdirCommand,
  buildPropertiesCommand,
  buildPurgeCommand,
  buildQuotaCommand,
  buildRenameCommand,
  buildRestoreTrashCommand,
  buildSearchCommand,
  buildServerVersionCommand,
  buildUploadCommand,
  buildVersionsCommand,
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
        bandwidthKbps: 2048,
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
      "--bwlimit=2048",
      "--o=/tmp/report.xml",
      "--e=/tmp/error.xml",
      "--files-from=/tmp/files.txt",
      "/data/",
      "--temp=/tmp/work",
      "a1b2c3@sync.example.test::ibackup/Videos/",
    ]);
  });

  it("builds the local engine version command without credentials", () => {
    expect(buildClientVersionCommand()).toEqual(["--client-version"]);
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

  it("builds native file-management commands", () => {
    expect(buildRenameCommand(context, {
      errorFile: "/tmp/error.xml",
      newPath: "/Archive/movie.mp4",
      oldPath: "/Videos/movie.mp4",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining([
      "--rename",
      "--old-path=/Videos/movie.mp4",
      "--new-path=/Archive/movie.mp4",
      "a1b2c3@sync.example.test::home/",
    ]));

    expect(buildCopyCommand(context, {
      destination: "/Archive",
      errorFile: "/tmp/error.xml",
      fileList: "/tmp/files.txt",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining([
      "--copy-within",
      "--files-from=/tmp/files.txt",
      "a1b2c3@sync.example.test::home/Archive",
    ]));

    expect(buildRestoreTrashCommand(context, {
      errorFile: "/tmp/error.xml",
      fileList: "/tmp/files.txt",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining(["--moveto-original"]));
    expect(buildEmptyTrashCommand(context, {
      errorFile: "/tmp/error.xml",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining(["--empty-trash"]));
  });

  it("builds discovery and metadata commands", () => {
    expect(buildListCommand(context, {
      detailed: true,
      errorFile: "/tmp/error.xml",
      remotePath: "/Videos",
      reportFile: "/tmp/report.xml",
      trash: true,
    })).toEqual(expect.arrayContaining(["--auth-list2", "--trash"]));

    expect(buildSearchCommand(context, {
      errorFile: "/tmp/error.xml",
      query: "movie",
      remotePath: "/Videos",
      reportFile: "/tmp/report.xml",
      trash: true,
    })).toEqual(expect.arrayContaining([
      "--search",
      "--search-key=movie",
      "--trash",
      "a1b2c3@sync.example.test::home/Videos",
    ]));

    expect(buildPropertiesCommand(context, {
      errorFile: "/tmp/error.xml",
      remotePath: "/Videos/movie.mp4",
      reportFile: "/tmp/report.xml",
    })).toContain("--properties");
    expect(buildDirectorySizeCommand(context, {
      errorFile: "/tmp/error.xml",
      remotePath: "/Videos",
      reportFile: "/tmp/report.xml",
    })).toContain("--get-size");
    expect(buildItemsStatusCommand(context, {
      errorFile: "/tmp/error.xml",
      fileList: "/tmp/files.txt",
      reportFile: "/tmp/report.xml",
    })).toContain("--items-status");
    expect(buildVersionsCommand(context, {
      errorFile: "/tmp/error.xml",
      remotePath: "/Videos/movie.mp4",
      reportFile: "/tmp/report.xml",
    })).toContain("--version-info");
    expect(buildChangesCommand(context, {
      cursor: "123",
      errorFile: "/tmp/error.xml",
      reportFile: "/tmp/report.xml",
    })).toEqual(expect.arrayContaining(["--search", "--file-index64=123", "--ref-id"]));
    expect(buildServerVersionCommand(context, {
      errorFile: "/tmp/error.xml",
      reportFile: "/tmp/report.xml",
    })).toContain("--server-version");
  });
});
