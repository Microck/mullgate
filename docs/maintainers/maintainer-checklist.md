# Maintainer Checklist

Use this page as the short-form companion to [Release runbook](release-runbook.md).

## Before release

- pick `X.Y.Z`
- confirm `package.json` version is correct
- move release notes from `Unreleased` into a versioned changelog section
- verify the README and docs still match the shipped install and command surface
- decide whether npm publish is GitHub Actions-driven or local
- if automation will publish to npm, confirm `NPM_TOKEN` and `NPM_PUBLISH_ENABLED=true` exist as repository secrets
- run the full local release check plus npm package dry-run

```bash
make release-check
npm pack --dry-run
```

## Before tag push

- confirm `main` contains the intended release commit
- push `main`
- create `vX.Y.Z`
- push `vX.Y.Z`

## npm publish

- if GitHub automation is enabled, watch the `Release` and `Publish to npm` workflows
- if npm automation is disabled or failed, publish locally:

```bash
pnpm publish --no-git-checks --access public --provenance=false
```

## After release

- verify the git tag has a GitHub release
- verify the release includes archives, raw binaries, checksums, and extracted notes
- verify the npm package is available
- verify the install scripts still point operators at a working npm install path
- verify documentation still reflects the shipped install and runtime surface
