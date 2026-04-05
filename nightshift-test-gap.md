# Nightshift: Test Gap Analysis

**Repository:** Microck/mullgate  
**Date:** 2026-04-05  
**Task:** test-gap  
**Category:** analysis

---

## 1. Test Infrastructure

| Aspect | Status |
|--------|--------|
| Test runner | **Vitest 4.1.1** (via `tsx scripts/test.ts` wrapper) |
| Coverage tool | `@vitest/coverage-v8` installed |
| Test command | `pnpm test` / `pnpm test:coverage` |
| Config file | `vitest.config.ts` referenced in tsconfig but **not found on disk** (uses vitest defaults via inline config in `scripts/test.ts`) |
| Spec files location | `test/` directory (mirrors `src/` structure loosely) |
| Helper utilities | `test/helpers/mullgate-fixtures.ts`, `test/helpers/platform-test-utils.ts` |

## 2. Test Coverage Summary

### Source Files (39 total under `src/`)

| Source File | Lines | Has Direct Test? | Test File(s) |
|-------------|-------|-------------------|--------------|
| **config/schema.ts** | 217 | indirect | Tested via `config-store.test.ts` |
| **config/store.ts** | 481 | YES | `test/config-store.test.ts` (735 lines) |
| **config/paths.ts** | 330 | indirect | Tested via `config-store.test.ts` |
| **config/redact.ts** | 86 | indirect | Tested via `config-store.test.ts` |
| **config/exposure-contract.ts** | 864 | **NO** | None — critical validation logic untested in isolation |
| **mullvad/fetch-relays.ts** | 433 | indirect | Partially covered via `mullvad-provisioning.test.ts` |
| **mullvad/provision-wireguard.ts** | 459 | YES | `test/mullvad-provisioning.test.ts` (1420 lines) |
| **mullvad/relay-probe.ts** | 293 | YES | `test/mullvad/relay-probe.test.ts` (101 lines) |
| **domain/location-aliases.ts** | 403 | indirect | Tested via `mullvad-provisioning.test.ts` |
| **domain/region-groups.ts** | 263 | **NO** | None |
| **network/tailscale.ts** | 34 | **NO** | None |
| **runtime/render-runtime-proxies.ts** | 761 | indirect | Tested via integration tests |
| **runtime/render-wireproxy.ts** | 13 | YES | Re-export, covered by proxy tests |
| **runtime/render-runtime-bundle.ts** | 706 | YES | `test/runtime/render-runtime-bundle.test.ts` (628 lines) |
| **runtime/docker-runtime.ts** | 582 | YES | `test/runtime/docker-runtime.test.ts` (386 lines) |
| **runtime/docker-validation-stage.ts** | 34 | **NO** | None |
| **runtime/validate-runtime.ts** | 460 | indirect | Via `mullvad-provisioning.test.ts` |
| **runtime/validate-wireproxy.ts** | 490 | indirect | Via `mullvad-provisioning.test.ts` |
| **platform/support-contract.ts** | 168 | YES | `test/platform/support-contract.test.ts` |
| **m004/feasibility-contract.ts** | 616 | indirect | `test/runtime/m004-feasibility.test.ts` |
| **m004/feasibility-runner.ts** | 1446 | YES | `test/runtime/m004-feasibility.test.ts` |
| **m004/compatibility-contract.ts** | 562 | indirect | `test/runtime/m004-compatibility.test.ts` |
| **m004/compatibility-runner.ts** | 877 | indirect | `test/runtime/m004-compatibility.test.ts` |
| **m004/milestone-contract.ts** | 367 | YES | `test/runtime/m004-decision-bundle.test.ts` |
| **m004/milestone-runner.ts** | 357 | indirect | `test/runtime/m004-decision-bundle.test.ts` |
| **cli-output.ts** | 112 | **NO** | None |
| **cli.ts** | 37 | **NO** | CLI entrypoint |
| **commands/proxy.ts** | 281 | YES | CLI integration tests in `test/cli/` |
| **commands/doctor.ts** | 1216 | YES | `test/cli/doctor-command.test.ts` |
| **commands/relays.ts** | 907 | YES | `test/cli/relays-and-recommend-command.test.ts` |
| **commands/recommend.ts** | 532 | indirect | Same as relays test |
| **commands/config.ts** | large | YES | `test/cli/config-command.test.ts` |
| **commands/start.ts** | 859 | YES | `test/cli/start-command.test.ts` |
| **commands/status.ts** | 545 | YES | `test/cli/status-command.test.ts` |
| **commands/autostart.ts** | — | YES | `test/cli/autostart-command.test.ts` |
| **commands/setup.ts** | — | YES | `test/setup-cli.test.ts` |
| **commands/runtime-diagnostics.ts** | — | thin | Only CLI help verification tests |
| **app/setup-runner.ts** | 1701 | indirect | Via `mullvad-provisioning.test.ts` |

### Coverage Stats
- **Files with direct or strong indirect test coverage**: 31/39 (79%)
- **Files with NO test coverage at all**: 5 source files
- **Files with only thin CLI help verification**: 1 (`runtime-diagnostics.ts`)

---

## 3. Critical Gaps Ranked by Risk

### P0 — Critical (Security/Data Integrity, No Tests)

#### 1. `src/config/exposure-contract.ts` (864 lines)
**Why P0**: Contains ALL network exposure validation logic — `validateExposureSettings()`, `validateAccessSettings()`, `computePublishedPort()`, `deriveLoopbackBindIp()`, `buildExposureContract()`, `normalizeExposureBaseDomain()`, `deriveExposureHostname()`, `deriveRuntimeListenerHost()`. A bug here means either (a) proxies exposed on wrong interfaces, or (b) security validation bypassed.

**Key untested functions**:
- `validateExposureSettings()` — validates exposure mode, bind IPs, base domains, route counts
- `validateAccessSettings()` — blocks unsafe public+empty-password combinations
- `normalizeExposureBaseDomain()` — trims/normalizes DNS base domains
- `deriveLoopbackBindIp()` — generates 127.x.y.z addresses from route index
- `computePublishedPort()` — port offset logic for private-network mode

**Recommended**: `test/config/exposure-contract.test.ts`

#### 2. `src/domain/location-aliases.ts` (403 lines) — partial gap
**Why P0**: `normalizeLocationToken()` is the core sanitization function used everywhere for user input. Only tested indirectly. Handles NFKD normalization, diacritics, special chars.

**Recommended**: `test/domain/location-aliases.test.ts`

#### 3. `src/config/redact.ts` (86 lines) — partial gap
**Why P0**: Handles credential redaction (account numbers, private keys, passwords). A missed secret leaks credentials in logs/output. Only tested indirectly.

**Recommended**: `test/config/redact.test.ts`

### P1 — High (External API / Data Transformation, No Tests)

#### 4. `src/mullvad/fetch-relays.ts` — `normalizeRelayPayload()` (433 lines total)
**Why P1**: Parses two different external API formats into a normalized `MullvadRelay[]`. The `normalizeRelayPayload()` function is exported and should have pure unit tests.

**Recommended**: `test/mullvad/fetch-relays.test.ts`

#### 5. `src/domain/region-groups.ts` (263 lines)
**Why P1**: Contains region-to-country-code mappings. `resolveRegionCountryCodes()` resolves user-friendly region names to country code arrays.

**Recommended**: `test/domain/region-groups.test.ts`

#### 6. `src/network/tailscale.ts` (34 lines)
**Why P1**: Detects Tailscale IPv4 address for private-network exposure mode.

**Recommended**: `test/network/tailscale.test.ts`

### P2 — Medium (Runtime/Validation, Partial Coverage)

#### 7. `src/runtime/validate-wireproxy.ts` — `parseWireproxyConfig()` (490 lines)
**Why P2**: Pure parsing functions should have unit tests independent of docker/wireproxy binary availability.

**Recommended**: `test/runtime/validate-wireproxy.test.ts`

#### 8. `src/runtime/render-runtime-proxies.ts` (761 lines)
**Why P2**: The largest runtime artifact renderer. `planRuntimeProxyArtifacts()` is a pure function that should be unit-testable.

**Recommended**: `test/runtime/render-runtime-proxies.test.ts`

#### 9. `src/runtime/docker-validation-stage.ts` (34 lines)
**Why P2**: Creates temporary files for Docker validation. Small utility, but file permission handling deserves a test.

**Recommended**: `test/runtime/docker-validation-stage.test.ts`

### P3 — Low (CLI Output / Entry Points)

#### 10. `src/cli-output.ts` (112 lines)
**Why P3**: ANSI-colored output formatting. Low risk.

#### 11. `src/cli.ts` (37 lines)
**Why P3**: Thin CLI entrypoint. Covered by CLI integration tests.

#### 12. `src/commands/runtime-diagnostics.ts`
**Why P3**: Only CLI help tests exist; the actual diagnostic rendering logic is untested but low-risk.

---

## 4. Highest Priority Functions

| Function | Module | Why |
|----------|--------|-----|
| `validateExposureSettings()` | exposure-contract.ts | Validates bind IPs, exposure modes, route counts — security boundary |
| `validateAccessSettings()` | exposure-contract.ts | Blocks unsafe public empty-password access |
| `normalizeExposureBaseDomain()` | exposure-contract.ts | DNS domain normalization — injection risk |
| `deriveLoopbackBindIp()` | exposure-contract.ts | Generates 127.x.y.z — must not produce invalid IPs |
| `buildExposureContract()` | exposure-contract.ts | Assembles full exposure state with warnings |
| `normalizeLocationToken()` | location-aliases.ts | Core slugifier for ALL user input — Unicode edge cases |
| `resolveLocationAlias()` | location-aliases.ts | Ambiguous alias resolution — user-facing errors |
| `redactSensitiveText()` | redact.ts | Regex for private key material — miss = credential leak |
| `normalizeRelayPayload()` | fetch-relays.ts | Parses external API data — schema mismatch risks |
| `normalizeMullgateConfig()` | store.ts | Config normalization with legacy hydration — complex branching |

---

## 5. Test Infrastructure Recommendations

1. **Add `vitest.config.ts`**: Currently missing from disk but referenced in tsconfig. Add explicit config with coverage settings.
2. **Add coverage thresholds**: The `test:coverage` script exists but has no thresholds. Set minimum coverage for `src/config/`, `src/mullvad/`, `src/domain/`, and `src/runtime/`.
3. **Add pre-commit test run**: The `simple-git-hooks` config runs `pnpm lint && pnpm typecheck` but NOT `pnpm test`. Add `pnpm test -- --run` to the pre-commit hook.
4. **Separate unit vs integration tests**: Many tests are integration-style (spawning CLI subprocesses). Pure unit tests for exported functions would be faster and more reliable.
5. **Test helper improvements**: Extend existing helpers with relay catalog fixtures and exposure config fixtures.

---

*Generated by Nightshift v3 (GLM 5.1)*
