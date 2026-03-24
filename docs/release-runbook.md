# Release Runbook

Use this when cutting a new `mullgate` release.

## Goal

Ship one version across the npm package, install scripts, GitHub tag, GitHub release assets, and maintainer docs.

## Preflight

1. Merge the approved work into `main`.
2. Make sure `main` is green before tagging.
3. Pick the release version `X.Y.Z`.
4. Confirm `CHANGELOG.md` has a complete user-facing entry ready to publish. The release workflow extracts notes from the `## [X.Y.Z]` section, so that heading must exist before the tag is pushed.
5. Decide how npm will be published:
   - automated via `.github/workflows/npm-publish.yml`
   - manual local `pnpm publish`
6. If automation will publish to npm, confirm these GitHub Actions secrets exist:
   - `NPM_TOKEN`
   - `NPM_PUBLISH_ENABLED=true`

## Update release metadata

1. Bump the release version in `package.json`.
2. If the release intentionally includes dependency upgrades, update them before tagging, review the `pnpm-lock.yaml` diff, and keep the package graph green.
3. Move the release notes from `## [Unreleased]` into a new `## [X.Y.Z]` section in `CHANGELOG.md`.
4. Update `README.md` and docs pages if the install surface, command surface, or maintainer workflow changed.
5. Check for any other hardcoded version references that still need the new release number.
6. Commit the release metadata update on `main`.

## Local verification before tagging

Run the same checks the release and npm publish pipelines depend on:

```bash
make release-check
npm pack --dry-run
```

`make release-check` covers:

- lint
- typecheck
- full test suite
- packaged install smoke verification
- packed release install-path verification

If any command fails, fix it before tagging.

## Publish the release

1. Push `main`.
2. Create and push the release tag, for example:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

3. If npm automation is disabled or unavailable, publish the package manually from the tagged release commit:

```bash
pnpm publish --no-git-checks --access public --provenance=false
```

Local publishing uses `--provenance=false` because the repo's provenance-enabled publish path is the GitHub Actions OIDC flow.

## What the tag triggers

`.github/workflows/release-package.yml` runs on `v*` tags and:

- verifies lint, build, typecheck, and tests
- verifies the packed install path
- verifies packaged install smoke on Linux, macOS, and Windows
- builds standalone Bun-compiled binaries for:
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`
  - `x86_64-pc-windows-msvc`
- uploads raw binaries and platform archives
- generates `mullgate-vX.Y.Z-checksums.txt`
- extracts release notes from `CHANGELOG.md`
- creates or refreshes the GitHub release

`.github/workflows/npm-publish.yml` runs after a successful `Release` workflow and publishes `package.json` to npm when `NPM_TOKEN` and `NPM_PUBLISH_ENABLED=true` are configured as repository secrets.

## Post-tag checks

Verify all public release surfaces after the workflows finish:

1. GitHub Release
   - `gh release view vX.Y.Z`
   - confirm the release notes match the new `CHANGELOG.md` section
   - confirm the release includes all platform archives, raw binaries, and `mullgate-vX.Y.Z-checksums.txt`
2. Workflow health
   - `gh run list --workflow Release --limit 5`
   - `gh run list --workflow 'Publish to npm' --limit 5`
3. npm
   - `npm view mullgate version`
   - confirm it matches `X.Y.Z`
4. Install surface
   - confirm `npm install -g mullgate@X.Y.Z` resolves the expected version
   - if the install scripts are part of the release story you are checking, verify they can install the just-published package
5. Docs
   - confirm the README and docs still describe the shipped install, runtime, and release surface truthfully

## Package channel notes

### GitHub Releases

This is the canonical release channel for standalone binaries and archives.

### npm

This is the canonical release channel for `npm install -g mullgate`, `pnpm add -g mullgate`, `bun add -g mullgate`, and the checked-in installer scripts.

`scripts/install.sh` and `scripts/install.ps1` both install `mullgate` from npm by default and only use `MULLGATE_VERSION` when a maintainer or operator pins a specific version explicitly. If npm publish lags behind the git tag, the default installer path will not deliver the new release yet.

## Recovery paths

### Rebuild an existing tag

If a release needs to be rebuilt for an existing tag:

1. Run the `Release` workflow manually.
2. Pass `release_tag` with the existing tag, for example `v0.2.0`.

This rebuilds artifacts, refreshes the GitHub release, and reruns the tagged verification path without minting a new version.

### Re-run npm publish

If the GitHub release assets are correct but npm did not publish:

1. confirm `NPM_TOKEN` and `NPM_PUBLISH_ENABLED=true`
2. run the `Publish to npm` workflow manually with the existing tag
3. if automation is still unavailable, publish locally with:

```bash
pnpm publish --no-git-checks --access public --provenance=false
```

4. verify `npm view mullgate version`

## Quick checks

- `gh release view vX.Y.Z`
- `gh run list --workflow Release --limit 5`
- `gh run list --workflow 'Publish to npm' --limit 5`
- `npm view mullgate version`
