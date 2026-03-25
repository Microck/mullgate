---
name: use-mullgate
description: Install, configure, run, verify, and troubleshoot Mullgate as an operator on a real machine. Use when the task is to actually use Mullgate rather than develop the Mullgate codebase, including first-run setup, non-interactive setup, exposure planning, hostname and bind-IP configuration, proxy export, relay discovery, exact-exit recommendation, route verification, runtime checks, or Linux autostart.
---

# Use Mullgate

## Overview

Operate Mullgate as a user-facing proxy tool. Use the existing Mullgate docs to choose the right setup path, exposure mode, verification sequence, and troubleshooting flow without drifting into repo-maintainer or release workflows.

## Grounding

Read these sources before acting:

- `README.md` for the landing-page install and command surface
- `docs/usage.md` for the full operator workflow
- `docs/mullgate-docs/content/docs/guides/setup-and-exposure.mdx` for bind-IP and hostname planning
- `docs/mullgate-docs/content/docs/guides/troubleshooting.mdx` for failure diagnosis
- `docs/mullgate-docs/content/docs/reference/commands.mdx` for command relationships

Do not use `docs/maintainers/` for operator tasks. Those pages are for release, publishing, docs-site work, and demo maintenance.

## Workflow Decision Tree

Choose the path that matches the user’s goal:

- Install or verify the CLI:
  - Prefer the checked-in installer path from `README.md`
  - Verify with `mullgate --help` and `mullgate path`
- First-time local proof:
  - Prefer Linux
  - Prefer `loopback` exposure with two routes
  - Run `mullgate setup`, then `mullgate hosts`
- Automated or repeatable setup:
  - Use `mullgate setup --non-interactive`
  - Start from `.env.example`
- LAN, VPN, or overlay exposure:
  - Use `private-network`
  - Require one distinct bind IP per route
  - Use a base domain only when real route hostnames are needed
- Public exposure:
  - Use only when internet-reachable listeners are explicitly intended
  - Treat it as a higher-risk posture and verify it carefully
- Relay choice and exact-exit proof:
  - Use `mullgate relays list`, `mullgate relays probe`, `mullgate recommend`, and `mullgate relays verify`
- Runtime diagnosis:
  - Start with `mullgate exposure`, `mullgate hosts`, `mullgate status`, and `mullgate doctor`

## Mental Model

- Mullgate is not a full-device VPN client. It is a local proxy gateway with explicit per-route entrypoints.
- Mullgate provisions one shared Mullvad WireGuard entry device and fans out to per-route Mullvad SOCKS5 exits, so route count does not imply one Mullvad slot per route.
- Route selection stays truthful only when hostnames resolve to the route’s assigned bind IP.
- In non-loopback multi-route setups, distinct routes require distinct bind IPs.
- `status`, `doctor`, `hosts`, and `exposure` are part of the product surface, not optional extras.

## Operating Rules

- Prefer the installed `mullgate` command in examples and commands.
- Treat Linux as the only fully supported live runtime environment.
- On macOS and Windows, keep install, config, `path`, `status`, and `doctor` truthful, but do not claim the shipped Docker runtime is fully equivalent to Linux.
- Use `mullgate setup` for guided setup unless the user explicitly wants automation.
- Use `mullgate setup --non-interactive` only when all required inputs are available through flags or environment variables.
- Do not describe Mullgate as consuming one Mullvad WireGuard device per route. The current runtime uses one shared entry device and many logical exits.
- Keep hostname-based routing truthful: each non-loopback route needs its own bind IP, and each hostname must resolve to that route’s bind IP.
- Prefer `mullgate exposure` and `mullgate hosts` over hand-written explanations when deciding whether a hostname or bind plan is correct.
- Use `mullgate validate --refresh` or `mullgate start` after exposure changes when derived runtime state may be stale.
- Keep `mullgate recommend --apply` tied to exact relay hostnames, not broad selectors.

## Practical Command Sequences

Use these sequences as the default operator flow:

### Install and verify

1. Install Mullgate.
2. Run `mullgate --help`.
3. Run `mullgate path`.

### First working setup

1. Run `mullgate setup` or `mullgate setup --non-interactive`.
2. Run `mullgate hosts` for local hostname mapping.
3. Run `mullgate exposure` to inspect mode, hostnames, and bind IPs.
4. Run `mullgate start`.
5. Run `mullgate status`.
6. Run `mullgate doctor`.

### Client export and exit tuning

1. Run `mullgate regions`.
2. Run `mullgate export --guided` or a deterministic `mullgate export ...` selector sequence.
3. Run `mullgate relays list` to inspect candidates.
4. Run `mullgate relays probe` to compare likely exits.
5. Run `mullgate recommend` to preview, then `--apply` if requested.
6. Run `mullgate relays verify --route <route>` to prove the configured exit.

### Troubleshooting

1. Run `mullgate exposure`.
2. Run `mullgate hosts`.
3. Run `mullgate validate --refresh` if config changed.
4. Run `mullgate status`.
5. Run `mullgate doctor`.
6. Run a real probe through the intended proxy entrypoint.

## What To Watch For

- Missing required non-interactive inputs
- Shared bind IPs across multiple non-loopback routes
- Hostnames resolving to the wrong bind IP
- DNS that does not match `mullgate exposure`
- Runtime state that was not refreshed after config edits
- HTTPS enabled without both cert and key material
- Users expecting macOS or Windows Docker runtime behavior to match Linux

## Output Style

- Prefer operator-facing answers over repo-maintainer explanations.
- Give concrete commands in the order the user should run them.
- When diagnosing a problem, name the likely failure layer first: install, config, exposure, hostname resolution, runtime state, or exit verification.
- If the user asks whether a setup is valid, anchor the answer to Mullgate’s actual exposure and routing rules rather than generic proxy advice.
