# idrive-cloud

An experimental, headless Node.js CLI for IDrive Cloud Drive (the Sync/Cloud
Drive product). It does not target IDrive Online Backup or IDrive e2.

IDrive does not publish a supported Cloud Drive API. This project uses the
private endpoints and proprietary transfer engine shipped in the official
IDrive Linux desktop package. Expect protocol changes and verify IDrive's terms
before using it in production.

## Current commands

```text
idrive-cloud setup --deb IDriveForLinux.deb --trust-package
idrive-cloud login EMAIL
idrive-cloud status
idrive-cloud upload FILE [REMOTE_DIRECTORY]
idrive-cloud ls [REMOTE_PATH] [--json]
idrive-cloud download REMOTE_FILE [DESTINATION]
idrive-cloud mkdir REMOTE_PATH
idrive-cloud rm REMOTE_PATH --yes
idrive-cloud purge REMOTE_PATH --yes
idrive-cloud quota
idrive-cloud logout
```

The CLI intentionally implements direct file operations only. It does not run
a filesystem watcher, Redis, Electron, Nautilus integrations, or continuous
desktop synchronization.

## Requirements

- Linux x86_64
- Node.js 22 or newer
- `dpkg-deb` and `tar` for `setup`
- An official `IDriveForLinux.deb`
- An IDrive account with Cloud Drive already activated

The setup command reads the official package as an archive. It does not install
the `.deb` and does not run the package's installer scripts. Only
`idevsutil_sync` and `idevsutil_dedup_sync` are copied to the CLI data directory.
`--trust-package` is required because IDrive does not provide a checksum through
this CLI. Setup prints and records the source SHA-256, and every later command
verifies the extracted engine binaries against the recorded manifest.

## Build

```bash
cd /home/aio/rasyid/idrive-cli
npm install
npm run check
npm run build
npm link
```

Then extract the engine:

```bash
idrive-cloud setup --deb /home/aio/IDriveForLinux.deb --trust-package
idrive-cloud status
```

By default, files are stored under:

```text
~/.config/idrive-cloud/config.json
~/.local/share/idrive-cloud/releases/
~/.local/share/idrive-cloud/engine.json
```

Use `IDRIVE_CLOUD_CONFIG_DIR` and `IDRIVE_CLOUD_DATA_DIR` to override these
locations.

## Login security

Interactive login hides typed secrets:

```bash
idrive-cloud login person@example.com
```

For automation, pass the password over standard input or an environment
variable:

```bash
printf '%s' "$IDRIVE_PASSWORD" | idrive-cloud login person@example.com --password-stdin
```

Private-encryption accounts can provide `IDRIVE_PRIVATE_KEY`. The original
IDrive account password and private key are not saved. The engine-generated
encoded transfer credentials are stored in a mode-`0600` profile. Treat that
profile as sensitive because encoded transfer credentials may still grant
account access.

Accounts created through Google, Apple, or another SSO provider must first set
an IDrive account password in the IDrive web account. IDrive's private Cloud
Drive endpoint does not provide an OAuth/SSO browser flow for this CLI.

For private-encryption accounts, login verifies the supplied key with a quota
request before saving credentials or linking the server as a device.

Login links the current server as an IDrive Sync device because the official
client does the same. Pass `--no-link` if the machine is already linked. Local
`logout` removes the profile but does not unlink the device remotely.

## File operations

Upload preserves the local base name. Its second argument is a remote
directory, not a replacement file name:

```bash
idrive-cloud mkdir /Videos
idrive-cloud upload ./movie.mp4 /Videos
idrive-cloud ls /Videos
```

Download currently follows the transfer engine's restore layout and may create
the remote directory hierarchy below the destination:

```bash
idrive-cloud download /Videos/movie.mp4 ./downloads
```

Downloads first land in a CLI-owned mode-`0700` staging directory because the
IDrive engine ignores its chmod option. The CLI rejects restored symlinks,
validates containment, then atomically publishes a mode-`0600` regular file.
New destination subdirectories use `0700`; existing directory modes are kept.

`rm` moves a scoped path to Cloud Drive trash. `purge` permanently deletes the
same scoped path from trash. Both require `--yes`, and both refuse the Cloud
Drive root.

## Development and tests

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The package extraction integration test is opt-in:

```bash
IDRIVE_TEST_DEB=/home/aio/IDriveForLinux.deb npm run test:integration
```

The production-account suite requires explicit mutation authorization, the
exact expected account, and an MP4 fixture:

```bash
IDRIVE_LIVE_TEST=1 \
IDRIVE_LIVE_EXPECT_EMAIL=person@example.com \
IDRIVE_LIVE_MP4=/path/to/sample.mp4 \
npm run test:live
```

It creates a uniquely prefixed tree, tests quota, nested directories, uploads,
spaces, long basenames, MP4 checksums, listing, downloads, overwrite behavior,
missing files, secure modes, scoped removal, and permanent trash cleanup. The
suite aborts before mutations if the persisted profile email does not match.

Unit tests do not require an account. Live authentication and file-transfer
validation require an IDrive account and are intentionally not run by the test
suite. Private-encryption login and every current transport command have been
validated against IDrive for Linux 1.8.0. The live download test confirmed that
the engine ignores its chmod option, so the CLI explicitly enforces mode `0600`
on downloaded files and `0700` on restored subdirectories.

Production testing also found that IDrive can temporarily return `Unable to
retrieve the quota. Try again.` immediately after uploads. The CLI retries this
specific response three times and then surfaces it without masking other EVS
errors. File operations remain available while quota refresh is delayed.

## Known limitations

- The private IDrive endpoints can change without notice.
- Only the x86_64 engine archive has been validated.
- Cloud Drive must already be activated; this CLI does not configure a new
  encryption account.
- Accounts using other regions, default encryption, or non-dedup storage still
  require authenticated compatibility validation.
- There is no video streaming, HTTP API, sync daemon, or web application in
  this repository.
- The proprietary engine remains owned and licensed by IDrive and is not
  redistributed by this project.
