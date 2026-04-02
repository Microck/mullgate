# Official Docs Reference

Use the public docs site as the preferred source of truth for operator-facing tasks.

## Core Docs

- `https://mullgate.micr.dev`
  - Main documentation site.
- `https://mullgate.micr.dev/docs/getting-started/quickstart`
  - Fast orientation and the recommended first reading path.
- `https://mullgate.micr.dev/docs/guides/usage`
  - Full operator workflow.
- `https://mullgate.micr.dev/docs/guides/setup-and-exposure`
  - Exposure modes, bind hosts, and access-mode planning.
- `https://mullgate.micr.dev/docs/guides/inline-selector-selectors`
  - Supported selector families and guaranteed inline-selector syntax.
- `https://mullgate.micr.dev/docs/guides/troubleshooting`
  - CLI-first diagnosis path and common failure patterns.
- `https://mullgate.micr.dev/docs/reference/commands`
  - Command relationships and the main CLI surfaces.
- `https://mullgate.micr.dev/docs/reference/configuration`
  - Canonical config model and environment variables.
- `https://mullgate.micr.dev/docs/reference/platform-support`
  - Truthful platform support posture.
- `https://mullgate.micr.dev/docs/faq`
  - Short answers for Tailscale, private-network, selectors, and runtime expectations.

## Architecture

- `https://mullgate.micr.dev/docs/architecture/overview`
  - High-level product model.
- `https://mullgate.micr.dev/docs/architecture/current-runtime`
  - Current shared-entry, multi-exit runtime architecture.

## Repo Fallbacks

Use these when you are working from a local checkout or when the public docs do not cover an operator question precisely enough:

- `README.md`
- `docs/usage.md`

## Live CLI Help

For exact flags, current wording, and current defaults, use live CLI help:

- `mullgate --help`
- `mullgate setup --help`
- `mullgate proxy access --help`
- `mullgate proxy relay --help`
- `mullgate proxy autostart --help`
