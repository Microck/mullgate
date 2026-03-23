# Publishing Mullgate

This document is the maintainer runbook for releases.

## Prerequisites

- Node.js 22
- `pnpm` 10.18.3
- npm access to the `mullgate` package
- GitHub push access for tags and releases

## Local release check

Run this before tagging:

```bash
make release-check
```

That covers:

- lint
- typecheck
- full test suite
- packaged install smoke verification
- packed release install-path verification

## Version and changelog

Before releasing:

- bump `package.json`
- move release notes from `Unreleased` into a versioned `CHANGELOG.md` section
- make sure the README install surface still matches reality

## npm publish

The package can be published locally with:

```bash
pnpm publish --no-git-checks --access public --provenance=false
```

Local publishing currently uses `--provenance=false` so maintainers are not blocked on GitHub Actions OIDC wiring.
The GitHub Actions publish workflow keeps provenance enabled through OIDC when `NPM_TOKEN` and `NPM_PUBLISH_ENABLED=true` are configured.

## GitHub release assets

The tagged release workflow is intended to:

- verify build, typecheck, and tests
- verify the packed install path
- verify packaged install smoke on Linux, macOS, and Windows
- build standalone Bun-compiled binaries for:
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`
  - `x86_64-pc-windows-msvc`
- attach raw binaries, platform archives, `mullgate-vX.Y.Z-checksums.txt`, `release-notes.md`, and `release-notes.json`

## Optional fully automated npm publish

`.github/workflows/npm-publish.yml` only publishes automatically when the repository has:

- `NPM_TOKEN`
- `NPM_PUBLISH_ENABLED=true`

Without those, npm publish remains a maintainer-operated step.
