# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

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
