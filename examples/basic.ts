import { createCloudDriveClient } from "idrive-sdk";

const idrive = createCloudDriveClient();
const status = await idrive.status();

if (!status.loggedIn) {
  throw new Error("Run idrive-cli login before using the SDK");
}

for (const entry of await idrive.list("/", { detailed: true })) {
  process.stdout.write(`${entry.type}\t${entry.name}\n`);
}
