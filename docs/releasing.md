# Releasing

The SDK and CLI have independent versions, but the CLI release is coupled to
the SDK version declared in `packages/cli/package.json`.

## Before a release

1. Update the SDK version when its public API or implementation changes.
2. Set the CLI dependency to `^<current SDK version>` and update the CLI version
   when the CLI package changes.
3. Prepare user-visible GitHub release notes.
4. Run the complete local gate:

   ```bash
   npm ci
   npm run release:check
   npm run test:coverage
   ```

`release:consistency` rejects mismatched SDK dependency metadata. Clean package
builds and `pack:check` verify the SDK exports, declarations, CLI binary, and
compatibility imports from the exact npm tarballs.

## First SDK publish

`idrive-sdk` must exist on npm before its GitHub trusted publisher
can be configured. Bootstrap only its first release using the maintainer's
normal npm authentication and 2FA flow:

```bash
npm whoami
npm run release:check
mkdir -p release-artifacts
npm pack --workspace idrive-sdk --pack-destination release-artifacts
npm publish release-artifacts/idrive-sdk-0.1.0.tgz --access public
npm view idrive-sdk@0.1.0 version
```

Inspect the exact tarball before publishing it. Immediately after the package
exists, configure its npm trusted publisher for
`.github/workflows/release.yml`. All later SDK releases must use the GitHub OIDC
workflow. The existing `idrive-cli` package can be configured for trusted
publishing before releasing version `0.5.0`.

After the manual `0.1.0` publish, create its GitHub release from the one-time
tag `sdk-bootstrap-v0.1.0`. This tag is intentionally excluded from the release
workflow, so creating it cannot attempt to publish `0.1.0` a second time:

```bash
git tag sdk-bootstrap-v0.1.0
git push origin sdk-bootstrap-v0.1.0
# Create the SDK GitHub release from sdk-bootstrap-v0.1.0.
```

Reserve `sdk-v<version>` for OIDC-published SDK releases after `0.1.0`.

## Publish order

Always publish `idrive-sdk` first. After npm returns that exact SDK
version from the registry, publish `idrive-cli`. The release workflow enforces
this check for non-dry-run CLI releases.

GitHub Actions supports two release paths:

- Run the **Release** workflow manually. It defaults to a dry run and uploads
  the generated tarball for inspection.
- Push `sdk-v<version>` or `cli-v<version>` to publish through the protected
  workflow. A tag must exactly match the version in that package's
  `package.json`.

Configure the GitHub `npm` environment with required reviewers. Configure each
npm package for trusted publishing from `.github/workflows/release.yml`; the
workflow uses GitHub OIDC and does not require a long-lived npm token.

After the SDK bootstrap, use one release order: push the package tag, wait for
npm publication, then create the GitHub release from that existing tag. For a
coordinated future release, complete the SDK sequence before starting the CLI
sequence:

```bash
git tag sdk-v0.1.1
git push origin sdk-v0.1.1
npm view idrive-sdk@0.1.1 version
# Create the SDK GitHub release from sdk-v0.1.1.

git tag cli-v0.5.1
git push origin cli-v0.5.1
npm view idrive-cli@0.5.1 version
# Create the CLI GitHub release from cli-v0.5.1.
```

Do not reuse or move a published tag. If a release is wrong, deprecate it and
publish a new patch version.
