# idrive-sdk

[![npm version](https://img.shields.io/npm/v/idrive-sdk.svg)](https://www.npmjs.com/package/idrive-sdk)
[![source](https://img.shields.io/badge/source-GitHub-181717.svg)](https://github.com/rasyidrafi/idrive-cli/tree/main/packages/sdk)

Unofficial server-side Node.js SDK for IDrive Cloud Drive (Sync storage). It
uses private IDrive endpoints and the transfer engine extracted from the
official IDrive for Linux package. It is not an official IDrive SDK and must
not be bundled into browser code.

## Install

```bash
npm install idrive-sdk
```

Requirements:

- Linux x86_64 and Node.js 22 or newer.
- `dpkg-deb` and `tar` for the one-time engine setup.
- An activated IDrive Cloud Drive account.
- A separately downloaded official `IDriveForLinux.deb` package.

The simplest setup path uses the companion [`idrive-cli`](https://www.npmjs.com/package/idrive-cli).
The SDK and CLI intentionally
share the same secure profile and engine directories:

```bash
npm install --global idrive-cli
idrive-cli setup --deb ./IDriveForLinux.deb --trust-package
idrive-cli login person@example.com
```

## Use

```ts
import { createCloudDriveClient } from "idrive-sdk";

const idrive = createCloudDriveClient();
const entries = await idrive.list("/Documents", { detailed: true });
await idrive.download("/Documents/report.pdf", "./downloads");
```

Applications can isolate their state from the CLI defaults:

```ts
import {
  createCloudDriveClient,
  createEngineInstaller,
} from "idrive-sdk";

const clientOptions = {
  configDirectory: "/srv/app/idrive/config",
  dataDirectory: "/srv/app/idrive/data",
  temporaryDirectory: "/srv/app/idrive/work",
};

const installer = createEngineInstaller(clientOptions);
await installer.installFromDeb("/srv/install/IDriveForLinux.deb");

const idrive = createCloudDriveClient(clientOptions);
```

Calling `installFromDeb` explicitly trusts that separately obtained package.
An isolated client then needs its own login. Passwords and private encryption
keys are used during login but are not stored in plaintext:

```ts
await idrive.login(email, password, {
  privateKeyProvider: async () => privateEncryptionKey,
});
```

Omit `privateKeyProvider` for accounts using default encryption.

## Cancellation, progress, and errors

Long-running operations accept an `AbortSignal`. Transfer operations can also
report the percentages observed from the proprietary engine:

```ts
import { IDriveError } from "idrive-sdk";

const controller = new AbortController();

try {
  await idrive.upload("./archive.zip", "/Backups", {
    signal: controller.signal,
    timeoutMs: 30 * 60_000,
    onProgress: (percent) => process.stderr.write(`\r${percent}%`),
  });
} catch (error) {
  if (error instanceof IDriveError) {
    console.error(error.code, error.operation, error.retryable, error.message);
  } else {
    throw error;
  }
}
```

`createCloudDriveClient()` defaults to `maxConcurrentOperations: 1`, serializing
all proprietary-engine operations for safety. Increase it only after validating
concurrent operations against the target account:

```ts
const idrive = createCloudDriveClient({ maxConcurrentOperations: 4 });
```

## Directory transfers

Directory helpers preserve the relative directory tree:

```ts
await idrive.uploadDirectory("./photos", "/Media/photos");

const downloaded = await idrive.downloadDirectory("/Media/photos", "./restore", {
  transfers: 4,
});
```

`uploadDirectory` uses one engine batch after validating and snapshotting the
local tree. For downloads, `transfers` controls how many batches are prepared,
while `maxConcurrentOperations` is the client-wide execution limit. Both must
be greater than one to run download batches concurrently. Progress callbacks
from concurrent batches are independent and may interleave; they are not an
aggregate directory percentage.

## API overview

The main `CloudDriveClient` operations are:

| Area | Methods |
| --- | --- |
| Session | `login`, `logout`, `status` |
| Files | `list`, `listRecursive`, `stat`, `search`, `properties`, `itemsStatus` |
| Transfer | `upload`, `uploadBatch`, `uploadDirectory`, `download`, `downloadBatch`, `downloadDirectory` |
| Mutation | `createDirectory`, `renameRemote`, `copyRemote`, `remove` |
| Trash | `listTrash`, `restoreTrash`, `purgeTrash`, `emptyTrash` |
| Account | `quota`, `directorySize`, `changes`, `versions` |
| Engine | `serverVersion`, `clientVersion` |

The package also exports interfaces for dependency injection and lower-level
engine setup. Treat exports not documented here as advanced APIs.

## Web applications

Run this SDK only in a trusted backend service or worker:

```text
Browser -> authenticated application API -> IDrive SDK -> transfer engine
```

Never expose IDrive credentials, encoded profile data, encryption keys, or the
transfer engine to browser code. Transfers are file based; IDrive Cloud Drive
does not provide a streaming or byte-range API.

See the [repository documentation](https://github.com/rasyidrafi/idrive-cli#readme)
and [protocol notes](https://github.com/rasyidrafi/idrive-cli/blob/main/docs/protocol-notes.md)
for security details, limitations, and observed private protocol behavior.
