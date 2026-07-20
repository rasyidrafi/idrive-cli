import { IDriveError, createCloudDriveClient } from "idrive-sdk";

const idrive = createCloudDriveClient();
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());

try {
  await idrive.download("/Documents/report.pdf", "./downloads", {
    signal: controller.signal,
    timeoutMs: 30 * 60_000,
    onProgress(percent) {
      process.stderr.write(`\rDownloading: ${percent}%`);
    },
  });
  process.stderr.write("\n");
} catch (error) {
  if (error instanceof IDriveError) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    process.exitCode = error.code === "cancelled" ? 130 : 1;
  } else {
    throw error;
  }
}
