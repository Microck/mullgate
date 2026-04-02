---
name: use-mullgate
description: Install, configure, expose, verify, and troubleshoot Mullgate as an operator on a real machine. Use when the request is to actually use Mullgate rather than develop the Mullgate codebase, including first-run setup, non-interactive setup, Tailscale or private-network exposure, inline-selector access, proxy export, relay discovery or recommendation, exact-exit verification, and Linux autostart.
---

# Use Mullgate

Operate Mullgate as an operator, not as a code contributor. Prefer official docs and the live CLI help, then give the user exact commands or proxy URLs that match the current saved posture.

## Grounding

Read these before acting:

- `references/official-docs.md` for the official public docs map
- `references/operator-playbooks.md` for concrete task playbooks

Treat these as the authority order:

1. official public docs at `https://mullgate.micr.dev`
2. live CLI help such as `mullgate setup --help` or `mullgate proxy access --help`
3. local repo docs such as `README.md` and `docs/usage.md`

Do not use `docs/maintainers/` for normal operator tasks.

## Mental Model

Treat Mullgate as two separate choices:

- exposure mode
  - `loopback` - local-only proof on one machine
  - `private-network` - one trusted-network host, usually a LAN or Tailscale IP
  - `public` - internet-reachable listeners
- access mode
  - `published-routes` - default; routes are selected by hostname or per-route port inventory
  - `inline-selector` - opt-in; one shared listener per protocol and the route selector goes in the proxy username

## Core Rules

- In `private-network`, use the host's real trusted-network IP, not `0.0.0.0`. On Tailscale, that usually means the host `100.x` address.
- In `private-network + published-routes`, all routes can share one trusted-network host IP because route selection moves to per-route ports.
- In `inline-selector`, one shared host works in every exposure mode because route selection moves to the username.
- Use the guaranteed inline-selector URL form `scheme://selector:@host:port`. The shorter `scheme://selector@host:port` form is best-effort only.
- `mullgate proxy export` currently supports `published-routes` only.
- `public + inline-selector + empty password` is blocked unless the operator explicitly enables `--unsafe-public-empty-password`.
- Linux is the only fully supported runtime target.

## Intent Mapping

Map the request before choosing commands:

- "Set up Mullgate locally" or "prove it works on this machine"
  - use `loopback`
  - keep `published-routes`
- "Expose Mullgate over Tailscale", "use it from another machine on my VPN", or "private network"
  - use `private-network`
  - prefer the host's Tailscale `100.x` IP
- "Use one host and choose country, city, or server in the proxy URL itself"
  - use `private-network` unless the user explicitly wants public exposure
  - switch to `inline-selector`
- "Give me a proxy list or file I can import elsewhere"
  - keep or switch to `published-routes`
  - use `mullgate proxy export`
- "Start automatically after reboot"
  - use `mullgate proxy autostart enable`
  - verify with `mullgate proxy autostart status`

## Default Workflow

1. Inspect current posture with `mullgate proxy access`.
2. Change exposure or access with `mullgate proxy access --mode ... --access-mode ... --route-bind-ip ...` when needed.
3. Refresh derived state with `mullgate proxy validate --refresh` or restart with `mullgate proxy start`.
4. Check live/runtime truth with `mullgate proxy status`.
5. Diagnose failures with `mullgate proxy doctor`.

## Playbooks

Use `references/operator-playbooks.md` when the user asks for:

- Tailscale or private-network exposure
- inline country, city, or exact relay selection in the proxy username
- generated proxy inventory export
- relay listing, probing, recommendation, or exact-exit verification
- Linux autostart after login or reboot

## Output Style

- Prefer short, operator-facing answers with exact commands.
- If the user asks for a working proxy URL, give the exact URL shape they should use.
- If the user asks for a list or file, switch to the export workflow instead of inventing selector URLs.
- If a request is risky, say why and name the safer alternative.
