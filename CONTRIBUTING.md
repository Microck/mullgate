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
