# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

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
