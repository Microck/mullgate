# Contributing

Thanks for contributing to Mullgate.

## Prerequisites

- Node.js 22
- `pnpm` 10.18.3
- Docker when you need the Linux-first runtime verifiers

You can use either:

- `.node-version` with your version manager
- `corepack enable` to make sure the repo uses the pinned `pnpm` version

## Local setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test -- --run
```

The `Makefile` exposes the same common entrypoints:

```bash
make install
make release-check
```

## Technical architecture

- `src/cli.ts` wires the top-level command tree.
- `src/commands/` owns operator-facing CLI flows such as setup, proxy runtime control, status, doctor, relay inspection, and advanced config editing.
- `src/app/setup-runner.ts` contains the guided/non-interactive setup orchestration that provisions Mullvad credentials, resolves route selections, writes relay cache state, and persists the canonical config.
- `src/config/` defines the schema, canonical storage normalization, redaction rules, and exposure contract that every command reads from.
- `src/runtime/` renders and validates the shared Docker runtime bundle: wireproxy config, route-proxy config, docker-compose manifest, and typed compose status checks.
- `src/mullvad/` is the upstream integration layer for relay catalog fetches, WireGuard provisioning, and exact-exit probing.
- `src/domain/` holds location alias and region-group logic that stays independent from CLI concerns.
- `test/cli/` covers the operator contract. `test/runtime/`, `test/config/`, `test/domain/`, and `test/mullvad-*` cover the lower-level behavior that command flows compose.

## Data flow

1. `mullgate setup` collects input, talks to Mullvad, resolves route aliases, and writes a canonical `config.json` plus relay cache and derived runtime artifacts.
2. `mullgate proxy start` reloads that saved config, rerenders the runtime bundle, validates it, and then launches Docker Compose.
3. `mullgate proxy status` and `mullgate proxy doctor` combine saved config state, rendered artifacts, validation reports, and live Docker Compose state into operator-facing diagnostics.
4. Config mutations such as `mullgate config set` or `mullgate proxy access` update the canonical config first, then ask the operator to refresh derived runtime artifacts when required.

## Maintainer docs

Use these docs when you are changing the docs site, cutting a release, or publishing `mullgate`:

- [Maintainer docs index](docs/maintainers/index.md)
- [Release runbook](docs/maintainers/release-runbook.md)
- [Publishing](docs/maintainers/publishing.md)
- [Maintainer checklist](docs/maintainers/maintainer-checklist.md)
- [Docs site](docs/maintainers/docs-site.md)

## Before opening a pull request

Run the smallest meaningful verification for your change. For most changes that means:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --run
```

If you change packaging, install flow, or release behavior, also run:

```bash
pnpm verify:install-smoke
pnpm verify:m003-install-path -- --check-only
```

## Commit and pull request expectations

- Keep changes scoped and reviewable.
- Use descriptive Conventional Commit messages.
- Update `README.md`, `docs/`, or `CHANGELOG.md` when behavior or release surface changes.
- Do not commit secrets, Mullvad account numbers, or real proxy credentials.

## Reporting problems

- Use GitHub Issues for bugs and feature requests.
- Use `SUPPORT.md` for general support guidance.
- Use `SECURITY.md` for vulnerability reporting.
