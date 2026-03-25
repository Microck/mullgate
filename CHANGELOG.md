# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [1.0.0] - 2026-03-25

### Changed

- Mullgate now renders one shared entry WireGuard tunnel and one shared route-proxy service for all configured routes, so multi-route runtimes scale without provisioning a Mullvad device per route
- README, operator docs, skills, and recorded demos now describe and show the shared-entry multi-exit runtime that was live-verified with a 50-route sweep on one Mullvad account/device

### Fixed

- routed provisioning and export flows no longer hit Mullvad WireGuard key-slot exhaustion just because many routes are configured under the same account
- demo recording now fails fast when a runner crashes instead of silently keeping stale GIF assets

## [0.5.0] - 2026-03-25

### Added

- top-level `mullgate relays list`, `mullgate relays probe`, and `mullgate relays verify` commands for relay inspection, latency ranking, and configured-route exit verification
- top-level `mullgate recommend` for probing broad selector batches, previewing exact relay recommendations, and optionally pinning them into saved config with `--apply`
- richer selector filters across export and recommendation flows with `--owner`, `--run-mode`, and `--min-port-speed`

### Changed

- README, usage docs, and recorded demos now document the relay discovery and recommendation workflow alongside setup, export, and runtime inspection

### Fixed

- relay catalog loading now prefers cached rich catalogs and falls back cleanly to configured or legacy endpoints so setup, export, and recommendation flows stay aligned

## [0.4.0] - 2026-03-24

### Added

- `mullgate autostart` for Linux systemd user-service management, including enable, disable, and status flows that can target installed binaries or packed release assets
- top-level `mullgate export`, `mullgate regions`, and `mullgate hosts` command surfaces so proxy-list and route-discovery flows no longer sit behind `config`
- richer guided proxy export with numbered country, city, and server pick-lists plus preview-aware file generation

### Changed

- config inspection, exposure, and export previews now present the full operator-facing proxy credentials intentionally instead of censoring saved auth fields
- setup, doctor, status, and CLI report rendering now use the refreshed human-friendly output formatting and Mullvad-aligned demo/docs surface
- release documentation now includes a canonical runbook covering npm publishing, GitHub releases, and post-release verification

### Fixed

- `mullgate autostart` now accepts relative release-binary invocations such as `./mullgate autostart enable` even when `mullgate` is not already on `PATH`
- demo recordings now use taller framing so the showcased setup, status, and exposure flows stay readable in README and docs embeds

## [0.3.0] - 2026-03-24

### Added

- guided `mullgate config export --guided` country and region pick-lists so operators can build proxy batches without typing country codes from memory
- selector refinements for proxy export with `--city`, `--server`, and repeated `--provider` filters across both CLI and guided flows
- integration coverage for guided export selection and selector-based proxy file generation

### Changed

- `mullgate config export` can now materialize missing routes that satisfy the requested selector batches before exporting proxy URLs
- export previews and filenames now include richer route metadata such as city and relay hostname details
- README and docs now describe the list-based guided export flow and the richer selector surface

### Fixed

- export/help snapshots and non-TTY guided export coverage now stay aligned with the current selector contract

## [0.2.0] - 2026-03-24

### Added

- `mullgate config export` for generating authenticated proxy lists from saved routes with ordered `--country` and `--region` selector batches
- guided `proxies.txt` creation, `--dry-run` previews, `--stdout` delivery, and `--force` overwrite control for proxy export workflows
- `mullgate config regions` for discovering the curated region groups accepted by `config export --region ...`

### Changed

- README and docs now show the proxy export workflow alongside setup, exposure, and runtime inspection
- command reference and quickstart flow now include export and region discovery as part of the normal operator path
- demo GIF recordings across the README and docs now use taller framing and a Mullvad-inspired palette

### Fixed

- guided proxy export now works correctly with piped stdin and other non-TTY input instead of exiting early without writing output

## [0.1.1] - 2026-03-23

### Added

- convenience install scripts for Linux, macOS, and Windows that install the published npm package
- cross-platform install smoke verification for the packaged `mullgate` CLI

### Changed

- README is now install-first and consumer-focused, with deeper operator detail moved into docs
- release verification now includes cross-platform package install smoke checks before publishing GitHub release assets
- npm publish workflow now validates package metadata before publishing

## [0.1.0] - 2025-07-15

### Added

- Initial release of mullgate CLI
- Interactive connection setup via clack prompts
- SOCKS5 proxy support via Mullvad VPN API
- Zod-validated configuration schema
- Verifier scripts for CI milestone checks
