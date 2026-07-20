# idrive-cli

Unofficial headless CLI for IDrive Cloud Drive (Sync storage), powered by
`idrive-sdk`.

```bash
npm install -g idrive-cli
idrive-cli setup --deb ./IDriveForLinux.deb --trust-package
idrive-cli login person@example.com
idrive-cli ls /
```

The package continues to re-export the SDK API for compatibility. New
applications should depend directly on `idrive-sdk`.

Version 0.5 moves the implementation into the SDK workspace. Root package
imports remain compatible; undocumented deep imports of former internal
modules are not part of the supported API.

See the repository README for complete command, security, and setup
documentation. Maintainers should follow the repository's
[release runbook](https://github.com/rasyidrafi/idrive-cli/blob/main/docs/releasing.md)
when publishing the coupled SDK and CLI packages.
