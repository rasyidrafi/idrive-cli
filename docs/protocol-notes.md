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
