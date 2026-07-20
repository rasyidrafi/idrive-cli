# Protocol notes

These notes record the behavior observed in IDrive for Linux 1.8.0. They are
not official API documentation.

## Authentication

The official Cloud Drive daemon obtains hexadecimal Sync credentials from:

```text
GET https://www1.idrive.com/cgi-bin/v1/user-details.cgi
```

It then resolves the EVS server with:

```text
GET https://evs.idrivesync.com/cgi-bin/get_idsync_evs_details_xml_ip.cgi
```

Machine linking uses:

```text
POST https://tomcat.idrive.com/idrivee/appjsp/idriveLink.jsp
```

The CLI never logs request URLs because the first two official endpoints place
credentials in their query strings.

## Transfer engine

The official package embeds two Cloud Drive variants:

```text
idevsutil_sync
idevsutil_dedup_sync
```

Credentials and the encryption key are transformed with the engine's
`--string-encode` operation. Commands are supplied through a mode-`0600`
`--utf8-cmd` file so secrets do not appear in the process argument list.

Observed namespaces:

```text
Upload/create directory: user@server::ibackup/
List/download/quota:     user@server::home/
```

The engine writes operation results as XML fragments to report and error files.

## Confirmed Cloud Drive operations

The following behavior was validated against an authenticated Cloud Drive
(Sync storage) account. These operations do not use IDrive Online Backup
device, snapshot, or event namespaces.

| Capability | Observed engine operation |
| --- | --- |
| Basic and detailed directory listing | `--auth-list`, `--auth-list2` |
| Trash listing and search | listing/search plus `--trash` |
| Native rename or move | `--rename`, `--old-path`, `--new-path` |
| Server-side recursive copy | `--copy-within` with `--files-from` |
| Restore to original location | `--moveto-original` with `--files-from` |
| Empty all trash | `--empty-trash` |
| Name search | `--search`, `--search-key` |
| Path properties | `--properties` |
| Recursive folder size | `--get-size` |
| Batch existence/type status | `--items-status` with `--files-from` |
| File-version metadata | `--version-info` |
| Incremental change feed | `--search`, `--file-index64`, `--ref-id` |
| Server/client version banners | `--server-version`, `--client-version` |
| Transfer bandwidth limit | `--bwlimit=KB_PER_SECOND` |

Native copy preserves the source and accepts directory trees. Rename can also
move an item by changing its full path. Trash restoration places items at their
original paths. The incremental cursor is an opaque decimal integer and must
be retained as a string because observed/protocol values may exceed JavaScript's
safe integer range. If a poll returns no changes, consumers should keep the
cursor they supplied.

Detailed listings and change-feed entries expose useful fields such as version,
checksum, trash state, thumbnail availability, reference identifiers, and old
path. Their presence varies by operation and item type.

Version history has been validated for creation and metadata listing only.
Downloading or restoring a selected historical version, thumbnail retrieval,
sharing controls, and public links remain unimplemented because their Cloud
Drive protocol has not been validated. Flags found in the shared engine that
refer to backup devices, snapshots, or backup events are intentionally excluded.
