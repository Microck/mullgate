# Nightshift: Security Foot-Gun Finder — mullgate

**Repository:** Microck/mullgate  
**Date:** 2026-04-04  
**Category:** analysis / security-footgun  
**Severity Scale:** P0 Critical, P1 High, P2 Medium, P3 Low

---

## Summary

mullgate turns Mullvad VPN into authenticated SOCKS5/HTTP/HTTPS proxies. The codebase demonstrates strong security practices overall — secrets are redacted before logging, config files use 0600 permissions, WireGuard private keys are managed through a `toJSON()` method that redacts them. However, several foot-gun risks were identified that could lead to credential exposure or unsafe configuration in edge cases.

---

## Findings

### P1: `allowUnsafePublicEmptyPassword` bypasses auth on public-facing proxies
**File:** `src/config/exposure-contract.ts` (L138-155)  
**Risk:** A user setting `exposure.mode = 'public'` with `allowUnsafePublicEmptyPassword = true` creates open proxies accessible to anyone. While documented, the opt-in flag is a single boolean — no additional confirmation or rate-limit is enforced at the config level.

**Recommendation:** Consider requiring an explicit `I_UNDERSTAND_THE_RISKS` string value instead of a boolean, or log a loud warning on startup when public + empty password is active.

### P2: In-memory rate limiting with no cleanup
**File:** `app/api/questions/route.ts` (anonq reference, but mullgate's `src/runtime/docker-runtime.ts` spawns Docker processes with no rate limiting on compose operations)

**Note:** mullgate itself does not expose an HTTP API to external users — it generates Docker Compose files and spawns `docker compose up`. The attack surface is local. Rate limiting is not applicable here.

### P2: `collectKnownSecrets()` relies on config completeness for redaction
**File:** `src/config/redact.ts` (L62-68)  
**Risk:** The `redactSensitiveText()` function only redacts secrets listed in `collectKnownSecrets()` — specifically `accountNumber`, `password`, and `privateKey`. If any new secret field is added to the config schema without updating `collectKnownSecrets()`, it will leak into logs and diagnostics output.

**Recommendation:** Add a comment or test assertion near `collectKnownSecrets()` that lists all sensitive fields from the schema, making it easy to verify completeness when the schema changes.

### P2: `writeFileAtomic` temp file predictable naming
**File:** `src/config/store.ts` (L423-426)  
**Risk:** Temporary files use the pattern `.{basename}.{pid}.{timestamp}.tmp`. The `process.pid` and `Date.now()` are somewhat predictable. On shared systems, a symlink attack could theoretically replace the config file. However, the directory is created with 0700 permissions (L417-418), mitigating this on multi-user systems.

**Recommendation:** Consider using `crypto.randomBytes()` for temp file names for defense in depth.

### P3: Provisioned WireGuard private key held in memory
**File:** `src/mullvad/provision-wireguard.ts` (L76-78, L255)  
**Detail:** The `ProvisionedWireguardDevice` type holds the private key as a string property. While `toJSON()` correctly redacts it to `'[redacted]'`, the key remains in memory as a plain string and could be exposed through heap dumps, error serialization, or debugger inspection.

**Recommendation:** This is a known Node.js limitation. Document the risk and ensure no `JSON.stringify()` is called on the device object except through `toJSON()`.

### P3: Docker command args not shell-escaped
**File:** `src/runtime/docker-runtime.ts` (L1, spawn calls)  
**Detail:** Docker commands are spawned via `child_process.spawn()` with separate args array, which avoids shell injection. This is correct. No issue found — confirmed safe pattern.

### P3: WireGuard provisioning API uses form-encoded body with account number
**File:** `src/mullvad/provision-wireguard.ts` (L156-158)  
**Detail:** The Mullvad account number is sent in a `POST` body via `URLSearchParams`. The account number is validated with a regex (`/^\d{6,16}$/`) before sending (L124). The endpoint uses HTTPS. No credential leakage risk.

---

## Positive Security Patterns Observed

1. **Config file permissions:** All config files written with `0o600` mode (L237-252 in milestone-runner, L563-585 in compatibility-runner, store.ts)
2. **Secret redaction:** Comprehensive redaction system in `redact.ts` covering passwords, account numbers, and private keys
3. **toJSON() protection:** `ProvisionedWireguardDevice.toJSON()` redacts private key
4. **Atomic file writes:** `writeFileAtomic()` in store.ts uses write-to-temp + rename pattern
5. **Zod validation:** All API responses and config inputs validated with Zod schemas
6. **spawn() over exec():** Shell commands use `spawn()` with array args, preventing injection
7. **HTTPS-only API calls:** Mullvad API uses `https://api.mullvad.net/wg`

---

## Overall Assessment

**Risk Level:** Low-Medium. The codebase is security-conscious with multiple defense layers. The main foot-gun risk is the `allowUnsafePublicEmptyPassword` flag, which could expose open proxies if misconfigured. The redaction system is well-designed but fragile — it depends on `collectKnownSecrets()` being kept in sync with the schema.
