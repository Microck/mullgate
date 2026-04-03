# Nightshift Idea Generator — Mullgate Codebase Analysis

> **Generated:** 2026-04-03  
> **Repository:** Microck/mullgate  
> **Version analyzed:** 1.2.1  
> **Branch:** main

---

## Executive Summary

Mullgate is a well-structured, production-quality TypeScript CLI that turns a Mullvad VPN subscription into authenticated SOCKS5/HTTP/HTTPS proxy endpoints. The codebase demonstrates strong engineering fundamentals: Zod schema validation, atomic file writes, Result-type error handling, dependency injection for testability, and comprehensive multi-platform path resolution.

After a thorough analysis of all 39 source files, 20+ test files, CI/CD workflows, the docs site (Fumadocs/Next.js), and project tooling, I identified **22 concrete improvement ideas** across 8 categories. The highest-impact opportunities center around the `start.ts` command file (859 lines, doing too much), missing integration/E2E tests, credential encryption at rest, and the docs site lacking interactive examples.

The codebase is in strong shape overall. The ideas below represent incremental improvements that would raise an already good project to exceptional.

---

## High-Impact Ideas

### H-01: Decompose `commands/start.ts` into a flow orchestrator + focused sub-modules

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Architecture |
| **Description** | `src/commands/start.ts` is 859 lines and handles config loading, HTTPS asset verification, relay catalog loading, proxy artifact rendering, runtime bundle rendering, validation, Docker launch, diagnostics inference, result persistence, and CLI output formatting. Extract into separate modules: `start-flow.ts` (orchestrator), `start-persistence.ts` (config/report persistence), `start-diagnostics.ts` (diagnostic context inference), and `start-output.ts` (CLI formatting). The command file itself should be a thin Commander registration. |
| **Effort** | Medium (3–5 days) |
| **Files** | `src/commands/start.ts` → split into 4–5 new files under `src/commands/start/` or `src/app/start-flow/` |

### H-02: Add credential encryption at rest for config.json

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Security |
| **Description** | `config.json` currently stores the Mullvad account number, proxy password, and WireGuard private key in plaintext JSON with `0o600` file permissions. Add an opt-in encryption layer that encrypts sensitive fields using a key derived from a user-supplied passphrase (or OS keychain integration via `keytar` or a `pass`-style approach). The `redact.ts` module already handles runtime redaction—extend this pattern to storage. |
| **Effort** | High (5–8 days) |
| **Files** | `src/config/store.ts`, `src/config/schema.ts`, `src/config/redact.ts`, new `src/config/encryption.ts` |

### H-03: Add integration/E2E test layer with Docker Compose lifecycle

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Testing |
| **Description** | The test suite is comprehensive at the unit level (fixtures, mocks, contract tests), but there is no integration test that exercises `mullgate setup --non-interactive → mullgate proxy start → mullgate proxy status → mullgate proxy doctor` end-to-end with a real Docker runtime. Add an E2E test suite (guarded behind a `MULLGATE_E2E=1` env flag) that provisions, starts, verifies exit IPs, and tears down. This would catch the class of bugs where individual components work but the composition fails. |
| **Effort** | High (5–8 days) |
| **Files** | New `test/e2e/` directory with `full-runtime.test.ts`, `multi-route-setup.test.ts`, etc. |

### H-04: Extract a shared Result type library to reduce boilerplate

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Code Quality |
| **Description** | The codebase defines ~25+ ad-hoc `{ ok: true; ... } | { ok: false; ... }` discriminated union types across `docker-runtime.ts`, `fetch-relays.ts`, `provision-wireguard.ts`, `start.ts`, `validate-runtime.ts`, `config.ts`, `exposure-contract.ts`, `render-runtime-proxies.ts`, etc. Each has slightly different error shape conventions. Create a shared `src/result.ts` module with a generic `Result<T, E>` type, common constructors (`ok()`, `fail()`), and a `ResultFormatter` for consistent error reporting. This would reduce the ~800+ lines spent on result type definitions and ensure uniform error handling. |
| **Effort** | Medium (3–5 days) |
| **Files** | New `src/result.ts`, then incrementally refactor `src/mullvad/*.ts`, `src/runtime/*.ts`, `src/commands/*.ts`, `src/config/*.ts` |

### H-05: Add structured logging with configurable verbosity levels

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Developer Experience |
| **Description** | All CLI output currently goes through `writeCliReport()` which writes formatted text to stdout/stderr. There is no structured logging, no verbosity control (`--verbose`, `--quiet`, `--json`), and no machine-readable output format. Add a logger abstraction with levels (debug, info, warn, error), support for `--verbose`/`--quiet` flags on every command, and a `--json` output mode for scripting. This would make `mullgate` much more automatable and debug-friendly. |
| **Effort** | Medium (3–5 days) |
| **Files** | New `src/logger.ts`, `src/cli.ts`, `src/cli-output.ts`, all command files |

### H-06: Decompose `app/setup-runner.ts` (1701 lines)

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Architecture |
| **Description** | `src/app/setup-runner.ts` is the largest file in the codebase at 1701 lines. It handles guided prompting, non-interactive input resolution, WireGuard provisioning with retry logic, relay catalog fetching, location alias resolution, exposure contract validation, route configuration building, runtime artifact rendering, validation, and persistence. Extract into: `setup-prompt.ts` (interactive clack prompts), `setup-provisioning.ts` (WireGuard + relay fetching with retry), `setup-route-builder.ts` (route configuration assembly), `setup-persistence.ts` (config + artifact saving). |
| **Effort** | Medium (3–5 days) |
| **Files** | `src/app/setup-runner.ts` → split into 4–5 focused modules |

### H-07: Add `mullgate proxy stop` command

| Field | Detail |
|---|---|
| **Impact** | 🔴 High |
| **Category** | Developer Experience |
| **Description** | The CLI has `proxy start`, `proxy status`, `proxy doctor`, and `proxy autostart`, but no `proxy stop` command. Users must manually run `docker compose down` in the runtime directory. Adding `mullgate proxy stop` that reads the compose file path from config and runs `docker compose down` would complete the operational lifecycle. |
| **Effort** | Low (1–2 days) |
| **Files** | New `src/commands/stop.ts`, `src/commands/proxy.ts` (register), `src/runtime/docker-runtime.ts` (add `stopDockerRuntime()`) |

---

## Medium-Impact Ideas

### M-01: Add a `mullgate proxy restart` command

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Developer Experience |
| **Description** | After config changes, users must `proxy start` which does `--force-recreate`. A dedicated `proxy restart` that stops + re-renders artifacts + starts would be cleaner and could skip artifact re-rendering when config hasn't changed. |
| **Effort** | Low (1–2 days) |
| **Files** | New `src/commands/restart.ts`, `src/commands/proxy.ts` |

### M-02: Cache relay catalog with TTL and background refresh

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Performance |
| **Description** | The relay catalog (`relays.json`) is fetched once during setup and stored. The `doctor` command warns when it's stale (> 7 days), but there's no automatic refresh. Add a configurable TTL with background refresh on `proxy start` or `proxy status` when the catalog is stale. This ensures relay recommendations use current data without blocking the user. |
| **Effort** | Low (1–2 days) |
| **Files** | `src/app/setup-runner.ts`, `src/commands/doctor.ts`, new `src/mullvad/relay-cache.ts` |

### M-03: Add `--dry-run` flag to `proxy start` for artifact inspection

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Developer Experience |
| **Description** | Currently `proxy start` always launches Docker. A `--dry-run` flag would render all artifacts (wireproxy config, route proxy config, docker-compose.yml, manifest) and validate them without actually starting containers. This is useful for debugging and CI verification. |
| **Effort** | Low (1–2 days) |
| **Files** | `src/commands/start.ts` (add flag handling early in `runStartFlow`) |

### M-04: Deduplicate `WritableTextSink` type across command files

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Code Quality |
| **Description** | The `WritableTextSink` type `{ write(chunk: string): unknown }` is defined independently in `src/commands/start.ts` (line 38), `src/commands/doctor.ts` (line 43), and `src/commands/proxy.ts` (implicitly). Extract to a shared `src/types.ts` or extend `src/cli-output.ts`. |
| **Effort** | Trivial (0.5 days) |
| **Files** | `src/commands/start.ts`, `src/commands/doctor.ts`, `src/cli-output.ts` or new `src/types.ts` |

### M-05: Add config migration utilities for version upgrades

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Developer Experience |
| **Description** | `src/config/store.ts` has `hydrateLegacyConfigInput()` for migrating pre-v2 configs, but the current `UnsupportedConfigVersionError` gives no programmatic migration path. As the project matures to v3+, a formal migration framework (`src/config/migrations/v2-to-v3.ts`) with automatic upgrade would reduce friction. |
| **Effort** | Medium (2–4 days) |
| **Files** | New `src/config/migrations/` directory, `src/config/store.ts` |

### M-06: Add test coverage thresholds to vitest config and CI

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Testing |
| **Description** | The `vitest.config.ts` has coverage reporting configured but no thresholds. Add `coverage.thresholds` (e.g., 80% lines, 75% branches) and add a CI step that fails the build when coverage drops. This prevents regression in test coverage over time. |
| **Effort** | Low (1 day) |
| **Files** | `vitest.config.ts`, `.github/workflows/ci.yml` |

### M-07: Extract `sanitizeText()` no-op or make it meaningful

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Security |
| **Description** | In `src/mullvad/provision-wireguard.ts` (line 457–459), `sanitizeText()` is a no-op identity function that passes through text unchanged. It's used when creating provisioning failure messages that include API response text. Either implement actual sanitization (strip control characters, truncate, remove potential ANSI injection) or remove the function and add a comment explaining why sanitization isn't needed. |
| **Effort** | Trivial (0.5 days) |
| **Files** | `src/mullvad/provision-wireguard.ts` |

### M-08: Add `mullgate config diff` to compare current vs. saved config

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Developer Experience |
| **Description** | When users run `mullgate setup` again or modify via `proxy access`, there's no way to preview what will change. Add `mullgate config diff` that shows a redacted comparison of proposed vs. current config before persisting. |
| **Effort** | Medium (2–3 days) |
| **Files** | New `src/commands/config-diff.ts`, `src/commands/config.ts` |

### M-09: Improve error messages with actionable remediation hints

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | UX |
| **Description** | Error messages currently show phase/source/reason but rarely include actionable next steps. For example, a Docker Compose launch failure shows `docker compose up --detach --force-recreate failed` but doesn't suggest checking `docker logs` or disk space. Add per-error-type remediation hints (similar to how `doctor` already provides remediation strings). |
| **Effort** | Medium (2–3 days) |
| **Files** | `src/commands/start.ts`, `src/runtime/docker-runtime.ts`, `src/mullvad/provision-wireguard.ts` |

### M-10: Add DNS-over-HTTPS resolution option for relay lookups

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Security |
| **Description** | `fetch-relays.ts` and `provision-wireguard.ts` use `globalThis.fetch` directly against Mullvad API endpoints. In environments where DNS is monitored or spoofed, add an option to use DNS-over-HTTPS for initial endpoint resolution, or at minimum validate TLS certificates strictly. Consider adding a `--insecure-skip-tls-verify` flag (defaulting to strict) for air-gapped testing. |
| **Effort** | Low (1–2 days) |
| **Files** | `src/mullvad/fetch-relays.ts`, `src/mullvad/provision-wireguard.ts` |

### M-11: Add shell completions generation

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | Developer Experience |
| **Description** | Commander.js supports shell completion generation out of the box. Add `mullgate completions <shell>` subcommand that outputs bash/zsh/fish completions for all commands, flags, and option values (exposure modes, access modes). This significantly improves the interactive CLI experience. |
| **Effort** | Low (1–2 days) |
| **Files** | `src/cli.ts`, new `src/commands/completions.ts` |

---

## Low-Impact Ideas

### L-01: Add JSDoc documentation to exported types and functions

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Documentation |
| **Description** | Most exported types and functions lack JSDoc comments. For example, `normalizeMullgateConfig()` in `store.ts` is a critical 25-line function with no doc comment explaining its side effects (version checking, legacy hydration, route normalization). Adding JSDoc to all exported symbols would improve IDE hover documentation and auto-generated API docs. |
| **Effort** | Medium (3–5 days) |
| **Files** | All files under `src/` |

### L-02: Add `CONTRIBUTING.md` technical architecture section

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Documentation |
| **Description** | `CONTRIBUTING.md` exists but doesn't include a technical architecture overview, module map, or data flow diagram. The `README.md` has a Mermaid diagram, but contributors need a more detailed breakdown of the `src/` directory structure, the relationship between `config/`, `commands/`, `runtime/`, `mullvad/`, `domain/`, and `app/` modules, and how the result-type pattern works. |
| **Effort** | Low (1–2 days) |
| **Files** | `CONTRIBUTING.md` |

### L-03: Add `tsconfig.build.json` source map support

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Developer Experience |
| **Description** | `tsconfig.build.json` (referenced in build script) likely doesn't generate source maps. Adding `"sourceMap": true` would improve debugging of the compiled `dist/` output when users report stack traces from installed binaries. |
| **Effort** | Trivial (0.5 days) |
| **Files** | `tsconfig.build.json` |

### L-04: Add `mullgate version` command

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Developer Experience |
| **Description** | There's no `mullgate version` command. Users must run `mullgate --version` (via Commander's built-in). A dedicated `version` subcommand could also show the config schema version, Node.js version, Docker availability, and platform — useful for bug reports. |
| **Effort** | Trivial (0.5 days) |
| **Files** | `src/cli.ts`, new `src/commands/version.ts` |

### L-05: Add a `mullgate proxy logs` convenience command

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Developer Experience |
| **Description** | Add `mullgate proxy logs` that tails `docker compose logs --follow` for the runtime containers. This saves users from having to find and navigate to the runtime bundle directory manually. |
| **Effort** | Low (1 day) |
| **Files** | New `src/commands/logs.ts`, `src/commands/proxy.ts`, `src/runtime/docker-runtime.ts` |

### L-06: Add GitHub Actions caching for pnpm store

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | Performance |
| **Description** | The CI workflow uses `actions/setup-node` with `cache: pnpm` but doesn't use `actions/cache` for the pnpm store itself on non-Node steps. Adding explicit pnpm store caching could reduce CI time by 10–20 seconds per run. |
| **Effort** | Trivial (0.5 days) |
| **Files** | `.github/workflows/ci.yml` |

### L-07: Add interactive table output for `proxy relay list`

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | UX |
| **Description** | `proxy relay list` currently outputs plain text. Use a library like `cli-table3` or the built-in column formatting to display relay results in an aligned table with columns for hostname, country, city, provider, active, and port speed. |
| **Effort** | Low (1–2 days) |
| **Files** | `src/commands/relays.ts` |

### L-08: Add progress indicators for long-running operations

| Field | Detail |
|---|---|
| **Impact** | 🟢 Low |
| **Category** | UX |
| **Description** | Setup, provisioning, and relay probing can take several seconds. While `@clack/prompts` provides spinners for interactive mode, non-interactive mode has no progress feedback. Add a cross-platform progress reporter that shows spinning dots or percentage progress even in non-TTY environments (via stderr dots or JSON progress events). |
| **Effort** | Low (1–2 days) |
| **Files** | `src/app/setup-runner.ts`, `src/mullvad/relay-probe.ts`, `src/mullvad/provision-wireguard.ts` |

---

## Docs Site Improvements

### D-01: Add interactive terminal emulator to docs site

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | UX (Docs) |
| **Description** | The docs site (Fumadocs/Next.js) currently uses GIF demos for terminal output. Add an interactive terminal emulator (e.g., `xterm.js` or a static mock terminal component) that lets users click through the setup flow and see expected output. This would be more engaging and easier to update than recording GIFs. |
| **Effort** | High (5–7 days) |
| **Files** | `docs/mullgate-docs/components/`, new terminal emulator component |

### D-02: Add search index for the docs site

| Field | Detail |
|---|---|
| **Impact** | 🟡 Medium |
| **Category** | UX (Docs) |
| **Description** | The docs site has an `app/api/search/route.ts` but verify that the search is functional with the Fumadocs search integration. If not, configure the Fumadocs search provider for the MDX content. |
| **Effort** | Low (1 day) |
| **Files** | `docs/mullgate-docs/source.config.ts`, `docs/mullgate-docs/app/api/search/route.ts` |

---

## Top 5 Recommended Next Steps

1. **Add `mullgate proxy stop` command (H-07)** — Quick win that completes the operational lifecycle. Users currently have to manually run `docker compose down`. Low effort, high user impact.

2. **Decompose `start.ts` and `setup-runner.ts` (H-01, H-06)** — These two files are the core of the application and together exceed 2,500 lines. Breaking them into focused sub-modules will make the codebase significantly easier to maintain, test, and extend.

3. **Extract shared Result type library (H-04)** — The ad-hoc result types scattered across the codebase represent ~800 lines of repetitive definitions with inconsistent error shapes. A shared `Result<T, E>` pattern would reduce boilerplate and enforce consistency.

4. **Add integration/E2E tests (H-03)** — The unit test suite is strong, but the missing piece is end-to-end verification that the full CLI lifecycle works with Docker. This would catch composition bugs and provide confidence for releases.

5. **Add structured logging with `--verbose`/`--json` flags (H-05)** — This is the most impactful developer experience improvement. It makes mullgate debuggable in production, scriptable in automation, and easier to support when users file issues.

---

## Analysis Methodology

- **Files examined:** All 39 source files, 20+ test files, 4 CI workflows, docs site configuration, Makefile, biome.json, vitest.config.ts, tsconfig files, .env.example, SECURITY.md, CONTRIBUTING.md, README.md
- **Lines of code analyzed:** ~8,500+ (source), ~3,000+ (tests)
- **Categories assessed:** Architecture, Performance, Developer Experience, Documentation, Testing, Security, Code Quality, UX
- **Tools used:** Static analysis via file reading and pattern matching

---

*Report generated by Nightshift v3 — Idea Generator Agent*
