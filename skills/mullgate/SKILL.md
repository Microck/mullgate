---
name: mullgate
description: Work on the Mullgate repository when implementing or reviewing CLI commands, config or routing logic, relay discovery or recommendation flows, operator docs, demo recordings, or release tasks. Use for changes that must keep the command help, README, usage docs, demos, and release surface truthful and aligned.
---

# Mullgate

## Overview

Implement Mullgate changes without breaking its truthful operator contract. Keep CLI behavior, help text, README/docs, fixture-backed demos, and release metadata aligned with the actual shipped behavior.

## Baseline

- Use `pnpm` for every package-manager operation.
- Treat `README.md`, `docs/usage.md`, and `docs/mullgate-docs/content/docs/reference/commands.mdx` as user-facing contract summaries.
- Treat the help snapshots and CLI tests under `test/cli/` as the executable command-surface contract.
- Prefer deterministic, fixture-backed tests and demos over live-network-only flows.

## Workflow

1. Read the relevant command modules under `src/commands/` and the tests that cover them before changing behavior.
2. Update the docs when the command surface, output wording, install story, or operator workflow changes.
3. Update the demo scripts and assets when the showcased operator flow changes materially.
4. Update release metadata when the change is intended to ship.

## Command-surface changes

When adding or changing commands, flags, or operator-visible output:

- Update `README.md`.
- Update `docs/usage.md`.
- Update the matching docs-site pages under `docs/mullgate-docs/content/docs/`.
- Update the relevant help and snapshot tests in `test/cli/`.

Prefer concise contract summaries in docs. Do not turn the README into a second man page.

## Demo changes

When a docs or README flow depends on demo GIFs:

- Edit the relevant `scripts/demo-*.ts` files.
- Update `scripts/record-demos.ts` if a new demo must be recorded.
- Update `scripts/verify-demos.ts` so docs references and mirrored assets are verified.
- Run:

```bash
pnpm demo:record
pnpm demo:verify
```

Keep demo flows fixture-backed. Do not require a live Mullvad account, real Docker runtime, or secret material when an existing fixture path can cover the behavior.

## Validation

Run the smallest truthful verification that matches the change:

- TypeScript or CLI behavior: `pnpm typecheck` and `pnpm test -- --run`
- Demo or docs asset changes: `pnpm demo:verify`
- Release-facing or packaging changes: `make release-check` and `npm pack --dry-run`
- Install-path changes: `pnpm verify:install-smoke` and `pnpm verify:m003-install-path -- --check-only`

## Release tasks

For release work, follow `docs/maintainers/release-runbook.md` and `docs/maintainers/publishing.md`.

Important repo-specific rules:

- Merge the approved work into `main` before tagging.
- Move release notes from `## [Unreleased]` into a new `## [X.Y.Z]` section in `CHANGELOG.md`.
- Bump `package.json` before tagging.
- Push `vX.Y.Z` to trigger `.github/workflows/release-package.yml`.
- The default install surface is npm, not GitHub releases alone.
- npm automation only publishes when `NPM_TOKEN` and `NPM_PUBLISH_ENABLED=true` are configured.
- If npm automation is disabled or unavailable, publish manually with:

```bash
pnpm publish --no-git-checks --access public --provenance=false
```

## Mullgate-specific gotchas

- Preserve truthful Linux-first runtime messaging for macOS and Windows instead of hiding the platform limits.
- Keep README, docs, and skills truthful about the current shared-entry multi-exit runtime. Do not reintroduce route-per-WireGuard-key language.
- Keep `recommend --apply` pinned to exact relay hostnames rather than broad selectors.
- Keep `relays verify` focused on configured routes rather than arbitrary relay-catalog candidates.
- When documenting verification, distinguish the built-in two-route `verify:s06` proof contract from larger maintainer scale sweeps that reuse a preserved temp home.
- Keep docs, demos, and help output aligned with the actual command flow rather than aspirational behavior.

## Reference map

- `README.md` - landing-page contract
- `docs/usage.md` - deeper operator guidance
- `docs/maintainers/release-runbook.md` - canonical release flow
- `docs/maintainers/publishing.md` - npm-publish behavior and fallback
- `docs/mullgate-docs/content/docs/` - docs-site source pages
- `scripts/demo-*.ts` - deterministic terminal demos
- `test/cli/*.test.ts` - CLI help, output, and workflow contract
