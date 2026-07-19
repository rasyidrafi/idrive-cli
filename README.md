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
| `idrive-cli ls [REMOTE_PATH] [--json]` | List files and directories |
| `idrive-cli download REMOTE_FILE [DEST]` | Download a file |
| `idrive-cli mkdir REMOTE_PATH` | Create a directory |
| `idrive-cli rm REMOTE_PATH --yes` | Move a path to trash |
| `idrive-cli purge REMOTE_PATH --yes` | Permanently delete a path from trash |
| `idrive-cli quota` | Show storage usage |
| `idrive-cli logout` | Remove the local profile |

Example:

```bash
idrive-cli mkdir /Videos
idrive-cli upload ./movie.mp4 /Videos
idrive-cli ls /Videos
idrive-cli download /Videos/movie.mp4 ./downloads
```

## Security

- The original account password and private encryption key are not saved.
- Encoded transfer credentials are stored with mode `0600`.
- Engine binaries are verified against hashes recorded during setup.
- Downloads use private staging and are published with mode `0600`.
- `rm` and `purge` require `--yes` and refuse the Cloud Drive root.
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
- Default-encryption, non-dedup, and other regional accounts need more testing.

The proprietary transfer engine remains owned and licensed by IDrive and is
not distributed in this npm package.
