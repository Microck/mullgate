---
name: use-mullgate
description: Install, configure, run, verify, and troubleshoot Mullgate as an operator on a real machine. Use when the task is to actually use Mullgate rather than develop the Mullgate codebase, including first-run setup, non-interactive setup, Tailscale or private-network exposure, inline selector access, proxy export, relay discovery, exact-exit recommendation, route verification, and Linux autostart.
---

# Use Mullgate

## Overview

Operate Mullgate as a user-facing proxy gateway. Stay on the operator path: choose the right exposure and access mode, verify the saved/runtime state, and give the user concrete proxy URLs or commands that match the current CLI.

## Grounding

Read these sources before acting:

- `README.md` for the install path and top-level command surface
- `docs/usage.md` for the full operator workflow
- `docs/mullgate-docs/content/docs/guides/setup-and-exposure.mdx` for exposure and access planning
- `docs/mullgate-docs/content/docs/guides/troubleshooting.mdx` for failure diagnosis
- `docs/mullgate-docs/content/docs/reference/commands.mdx` for command relationships

Do not use `docs/maintainers/` for operator tasks.

## Mental Model

Treat Mullgate as two separate choices:

- `setup.exposure.mode`
  - `loopback` - local-only proof on one machine
  - `private-network` - one trusted-network host, usually a LAN or Tailscale IP
  - `public` - internet-reachable listeners
- `setup.access.mode`
  - `published-routes` - default; routes are selected by hostname or per-route port inventory
  - `inline-selector` - opt-in; one shared listener per protocol and the route selector goes in the proxy username

Important rules:

- `private-network` should use the host's trusted-network IP, not `0.0.0.0`. On Tailscale, that usually means the host `100.x` address.
- In `private-network + published-routes`, all routes can share one host IP because route selection moves to per-route ports.
- In `inline-selector`, one shared host works in every exposure mode because route selection moves to the username.
- Proxy passwords are optional. If omitted, Mullgate saves an empty password.
- `public + inline-selector + empty password` is blocked unless the operator explicitly enables `--unsafe-public-empty-password` or `setup.access.allowUnsafePublicEmptyPassword=true`.
- `mullgate proxy export` currently supports `published-routes` only.

## Intent Mapping

Map the user's request to the Mullgate mode first:

- "Set up Mullgate locally" or "prove it works on this machine"
  - Use `loopback`
  - Keep the default `published-routes`
- "Expose Mullgate over Tailscale", "use it from another machine on my VPN", or "private network"
  - Use `private-network`
  - Prefer the host's Tailscale `100.x` IP when available
- "Use one host and choose country/city/server in the proxy URL itself"
  - Use `private-network` unless the user explicitly wants public exposure
  - Switch to `inline-selector`
- "Give me a proxy list/file I can import elsewhere"
  - Keep or switch to `published-routes`
  - Use `mullgate proxy export`
- "Make it public on the internet"
  - Use `public`
  - Push back if they also want an empty password
- "Start automatically after reboot"
  - Use `mullgate proxy autostart enable`
  - Verify with `mullgate proxy autostart status`

## Default Workflows

### Install and verify

1. Run `mullgate --help`.
2. Run `mullgate config path`.
3. Run `mullgate setup` or `mullgate setup --non-interactive`.

### Inspect or change exposure/access

1. Run `mullgate proxy access`.
2. If needed, run `mullgate proxy access --mode ... --access-mode ... --route-bind-ip ...`.
3. Run `mullgate proxy validate --refresh` or `mullgate proxy start`.
4. Run `mullgate proxy status`.
5. Run `mullgate proxy doctor`.

### Relay choice and exact-exit proof

1. Run `mullgate proxy relay list`.
2. Run `mullgate proxy relay probe`.
3. Run `mullgate proxy relay recommend`.
4. If the user wants a pinned exact exit, apply the recommendation.
5. Run `mullgate proxy relay verify --route <route>`.

### Autostart

1. Run `mullgate proxy autostart enable`.
2. Run `mullgate proxy autostart status`.
3. If startup still fails after reboot, inspect `mullgate proxy status` and `mullgate proxy doctor`.

## Tailscale Playbook

When the user asks for requests like "open Canada through Tailscale" or "make Sweden available from another Tailscale machine", prefer this path:

1. Use `private-network`.
2. Prefer `inline-selector` if the user wants one stable host and selector-driven URLs.
3. Use the host's Tailscale IP as the exposed host, for example `100.124.44.113`.
4. Start the runtime and verify the access report.
5. Hand back concrete client URLs.

Example command sequence:

```bash
mullgate proxy access \
  --mode private-network \
  --access-mode inline-selector \
  --route-bind-ip 100.124.44.113

mullgate proxy start
mullgate proxy access
```

Example client URLs:

```text
socks5://ca:@100.124.44.113:1080
http://ca:@100.124.44.113:8080
socks5://ca-tor:@100.124.44.113:1080
socks5://ca-tor-wg-301:@100.124.44.113:1080
```

Use the guaranteed `scheme://selector:@host:port` form. The shorter `scheme://selector@host:port` form is best-effort only.

If the user instead wants a generated proxy inventory file, do not use `inline-selector`. Keep `published-routes` and use:

```bash
mullgate proxy export --guided
```

## Operator Rules

- Prefer the installed `mullgate` command in examples.
- Prefer `mullgate proxy access` over editing JSON by hand.
- Use `mullgate proxy access` to inspect selector examples, hostname guidance, and direct-IP entrypoints.
- After changing exposure mode, access mode, base domain, or bind host, refresh runtime state with `mullgate proxy validate --refresh` or restart with `mullgate proxy start`.
- Use `mullgate proxy export` only in `published-routes` mode.
- Use `mullgate proxy access` rather than guessing which URL syntax a client should use.
- Treat Linux as the only fully supported runtime environment.

## What To Watch For

- Using `0.0.0.0` as if it were a client-reachable host address
- Expecting `private-network` to require one bind IP per route
- Expecting `mullgate proxy export` to work in `inline-selector`
- Public exposure with an empty password
- Runtime state left `unvalidated` after access or exposure changes
- Tailscale clients using the wrong host IP instead of the Mullgate host's `100.x` address

## Output Style

- Prefer short, operator-facing answers with concrete commands.
- If the user asks for a working proxy URL, give the exact URL shape they should use.
- If the user asks for a list or file, switch to the export workflow instead of inventing selector URLs.
- If a request is risky, say why and name the safer alternative.
