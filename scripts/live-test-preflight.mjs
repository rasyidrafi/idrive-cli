import { stat } from "node:fs/promises";
import process from "node:process";

if (process.env.IDRIVE_LIVE_TEST !== "1") {
  throw new Error("Set IDRIVE_LIVE_TEST=1 to authorize remote mutations");
}

if (!process.env.IDRIVE_LIVE_EXPECT_EMAIL) {
  throw new Error("Set IDRIVE_LIVE_EXPECT_EMAIL to the exact account being tested");
}

if (!process.env.IDRIVE_LIVE_MP4) {
  throw new Error("Set IDRIVE_LIVE_MP4 to a local MP4 fixture");
}

const fixture = await stat(process.env.IDRIVE_LIVE_MP4);
if (!fixture.isFile()) {
  throw new Error(`IDRIVE_LIVE_MP4 is not a file: ${process.env.IDRIVE_LIVE_MP4}`);
}
