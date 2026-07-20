# idrive-cli

[![npm version](https://img.shields.io/npm/v/idrive-cli.svg)](https://www.npmjs.com/package/idrive-cli)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717.svg)](https://github.com/rasyidrafi/idrive-cli)

Unofficial headless CLI for IDrive Cloud Drive (Sync storage). It does not
support IDrive Online Backup or IDrive e2.

IDrive does not provide a public Cloud Drive API. This project uses private
endpoints and the transfer engine from the official Linux package.

## Install

Requirements:

- Linux x86_64
- Node.js 22+
- `dpkg-deb` and `tar`
- An activated IDrive Cloud Drive account
- Official `IDriveForLinux.deb`

```bash
npm install -g idrive-cli@latest
idrive-cli setup --deb ./IDriveForLinux.deb --trust-package
idrive-cli login person@example.com
idrive-cli status
```

The setup command extracts only the headless transfer engine. It does not
install the IDrive desktop application.

## Commands

| Command | Purpose |
| --- | --- |
| `idrive-cli setup --deb FILE --trust-package` | Extract the transfer engine |
| `idrive-cli login EMAIL` | Authenticate and link the server |
| `idrive-cli status` | Show engine and login status |
| `idrive-cli upload FILE [REMOTE_DIR]` | Upload a file |
| `idrive-cli ls [REMOTE_PATH] [--detailed] [--trash]` | List active or trashed files and directories |
| `idrive-cli download REMOTE_FILE [DEST]` | Download a file |
| `idrive-cli mkdir REMOTE_PATH` | Create a directory |
| `idrive-cli rename SOURCE DEST` | Rename or move a file or directory (`mv` alias) |
| `idrive-cli copy SOURCE... DEST_DIR` | Server-side copy files or directory trees (`cp` alias) |
| `idrive-cli rm REMOTE_PATH --yes` | Move a path to trash |
| `idrive-cli purge REMOTE_PATH --yes` | Permanently delete a path from trash |
| `idrive-cli trash-ls [REMOTE_PATH]` | List trash with detailed metadata |
| `idrive-cli trash-restore REMOTE_PATH...` | Restore trash items to their original locations |
| `idrive-cli trash-empty --yes` | Permanently delete all trash items |
| `idrive-cli search QUERY [--path PATH] [--trash]` | Search active or trashed items by name |
| `idrive-cli properties REMOTE_PATH` | Show timestamps, size, and file count where available |
| `idrive-cli du REMOTE_DIR` | Show recursive directory size and file count |
| `idrive-cli items-status REMOTE_PATH...` | Check whether files or directories exist |
| `idrive-cli versions REMOTE_FILE` | List available file-version metadata |
| `idrive-cli changes [--cursor DECIMAL]` | Read the incremental Cloud Drive change feed |
| `idrive-cli server-version` | Show the connected Cloud Drive server version |
| `idrive-cli client-version` | Show the installed transfer-engine version |
| `idrive-cli quota` | Show storage usage |
| `idrive-cli stat REMOTE_PATH [--json]` | Show metadata for one path |
| `idrive-cli ls REMOTE_PATH --recursive` | Recursively list a directory tree |
| `idrive-cli upload-dir LOCAL_DIR [REMOTE_DIR]` | Upload a directory tree in batches |
| `idrive-cli download-dir REMOTE_DIR [DEST]` | Download a directory tree in batches |
| `idrive-cli doctor [--online]` | Validate local state and optionally quota access |
| `idrive-cli cleanup` | Remove stale private transfer workspaces |
| `idrive-cli logout` | Remove the local profile |

Example:

```bash
idrive-cli mkdir /Videos
idrive-cli upload ./movie.mp4 /Videos
idrive-cli ls /Videos
idrive-cli download /Videos/movie.mp4 ./downloads
```

Global options include:

- `--dry-run` previews mutations without confirmation; read-only discovery may
  still require a configured account.
- `--json` emits versioned success/error envelopes for automation.
- `--quiet` suppresses human-readable output except errors.
- `--progress` reports observed engine percentages on stderr.
- `--bwlimit-kbps N` limits upload and download throughput in KB/s.
- `--retries N` controls retries for safe read operations (default `3`).
- `--timeout-seconds N` overrides the engine operation timeout.
- `--temp-dir PATH` places private workspaces below `PATH/idrive-cli` without
  changing the parent directory's permissions.
- `--transfers N` controls concurrent download batches (`1` to `16`). Uploads
  remain one engine batch so all local snapshots finish before remote mutation.

Progress and errors are never written to JSON stdout. Uploads use one engine
batch after all local snapshots pass validation. Recursive downloads can split
files across concurrent private staging batches when `--transfers` is greater
than one; concurrent proprietary-engine execution should be enabled gradually
and validated against the account. The selected remote directory is
materialized below the destination.

## Security

- The original account password and private encryption key are not saved.
- Encoded transfer credentials are stored with mode `0600`.
- Engine binaries are verified against hashes recorded during setup.
- Engine hashes are rechecked before every invocation.
- Package archives reject links, special files, traversal, and oversized input.
- Downloads use private staging and are published with mode `0600`.
- `rm`, `purge`, and `trash-empty` require `--yes` for execution. Path-based
  deletion always refuses the Cloud Drive root; dry-run previews do not require
  confirmation.
- SSO-only accounts must create an IDrive account password before login.

## Local Data

```text
~/.config/idrive-cli/config.json
~/.local/share/idrive-cli/
```

Override these locations with `IDRIVE_CLI_CONFIG_DIR` and
`IDRIVE_CLI_DATA_DIR`.

## Development

```bash
git clone https://github.com/rasyidrafi/idrive-cli.git
cd idrive-cli
npm ci
npm run check
npm run build
```

Optional integration tests:

```bash
IDRIVE_TEST_DEB=./IDriveForLinux.deb npm run test:integration

IDRIVE_LIVE_TEST=1 \
IDRIVE_LIVE_EXPECT_EMAIL=person@example.com \
IDRIVE_LIVE_MP4=./sample.mp4 \
npm run test:live
```

The live suite uses a unique remote directory and removes it after testing.

## Limitations

- Private IDrive endpoints may change without notice.
- Only Linux x86_64 is supported.
- Cloud Drive must already be activated.
- No continuous sync daemon, streaming server, or HTTP API is included.
- Transfers are file based; there is no streaming or byte-range interface.
- Version history is currently metadata-only; selecting or downloading an old
  version has not been validated against Cloud Drive.
- Paths whose segments end in whitespace are rejected because the proprietary
  engine trims `--files-from` lines and cannot address them reliably.
- A batch may complete remotely before a local interruption is reported.
- Default-encryption, non-dedup, and other regional accounts need more testing.

The proprietary transfer engine remains owned and licensed by IDrive and is
not distributed in this npm package.
