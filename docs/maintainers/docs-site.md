# Docs site

This page is for maintainers working on the `docs/mullgate-docs` app.

It is not part of the public Mullgate operator docs.

## Purpose

`docs/mullgate-docs` is the Next.js and Fumadocs application that publishes the public Mullgate documentation site.

The public site should stay operator-facing:

- install Mullgate
- set up Mullgate
- use Mullgate
- troubleshoot Mullgate
- read architecture background when needed

Do not put maintainer release, publishing, or docs-app setup workflows into the public docs navigation.

## Local workflow

From the repo root:

```bash
cd docs/mullgate-docs
pnpm install
pnpm dev
```

Open the local URL printed by Next.js.

## Checks

Run these from `docs/mullgate-docs` after changing the docs app:

```bash
pnpm lint
pnpm types:check
pnpm build
```

If the changes also update repo-level markdown or scripts, run the root checks too:

```bash
pnpm lint
pnpm typecheck
```

## Key paths

- `content/docs/` - public docs pages and navigation metadata
- `app/` - Next.js routes and layout entrypoints
- `lib/` - shared docs source and layout helpers
- `public/images/demos/` - mirrored demo assets used by the site

## Content boundary

Keep these docs outside the public site:

- release runbooks
- npm publishing procedures
- maintainer checklists
- demo regeneration workflows

Put that material under `docs/maintainers/` instead.
