# Mullgate

Mullgate is a Linux-first, CLI-first Mullvad proxy bootstrapper. It guides setup, persists a canonical config under XDG paths, renders a Docker runtime bundle, and gives you route-aware inspection surfaces with `status`, `doctor`, and `config` commands.

## First-release scope

This repository currently ships a **Linux + Docker** operator flow.

- Supported: running from a source checkout with Node.js 22+, pnpm, and Docker Compose.
- Supported: guided or non-interactive setup, route-aware host mapping guidance, Docker runtime start, `status`, `doctor`, and config inspection/update commands.
- Not shipped here: GUI flows, Windows/macOS operator docs, or a separate installer surface.

## Prerequisites

Install these before following the quick start:

- Linux
- Node.js 22+
- pnpm
- Docker with the `docker compose` plugin available on `PATH`
- curl
- A live Mullvad account number
- A proxy username/password you want Mullgate to require on the published SOCKS5/HTTP/HTTPS listeners

## Command form used in this repo

From a checkout, invoke the CLI with:

```bash
pnpm exec tsx src/cli.ts --help
```

The help text and docs call the command `mullgate` because that is the CLI name exposed by the program. In a source checkout, replace `mullgate ...` with `pnpm exec tsx src/cli.ts ...`.

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Export the required setup inputs

The example below provisions **two routes** so you can inspect multi-route host mapping behavior immediately:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna
export MULLGATE_DEVICE_NAME=mullgate-linux
```

Optional setup inputs are covered in [docs/usage.md](docs/usage.md), including exposure mode, bind IPs, ports, HTTPS certificates, and custom Mullvad endpoints.

### 3. Run setup

```bash
pnpm exec tsx src/cli.ts setup --non-interactive
```

What this does:

- validates the provided setup inputs
- provisions Mullvad WireGuard state for each routed location
- saves the canonical config JSON
- writes derived runtime artifacts under the Mullgate state directory
- records enough metadata for later `status`, `doctor`, and verifier runs

### 4. Inspect route host mappings before testing local hostnames

```bash
pnpm exec tsx src/cli.ts config hosts
```

Important:

- In the default `loopback` exposure mode, Mullgate gives each route a distinct loopback bind IP.
- Hostname-based route selection only works if your machine can resolve each configured hostname to its matching bind IP.
- For local testing, copy the emitted `copy/paste hosts block` into `/etc/hosts` before you expect hostnames like `sweden-gothenburg` and `austria-vienna` to resolve on this machine.
- If you skip that step, you can still use the direct bind IP entrypoints shown by `config hosts`, `config exposure`, `status`, and `doctor`.

### 5. Start the Docker runtime

```bash
pnpm exec tsx src/cli.ts start
```

`mullgate start` re-renders the runtime bundle from the saved config, validates it, and launches the Docker Compose stack. It does **not** change the host machine's default route; Mullgate routes traffic by the listener bind IPs it publishes.

### 6. Inspect the running state

```bash
pnpm exec tsx src/cli.ts status
pnpm exec tsx src/cli.ts doctor
```

Use the commands together:

- `status` summarizes saved config, runtime artifacts, live `docker compose ps` state, exposure entrypoints, and the last recorded start result.
- `doctor` runs route-aware diagnostics for config validity, exposure posture, hostname resolution, runtime health, and the saved `last-start.json` failure/success report.

## XDG paths and saved artifacts

By default Mullgate uses these Linux XDG locations:

| Surface | Default path |
| --- | --- |
| Canonical config | `~/.config/mullgate/config.json` |
| Runtime state dir | `~/.local/state/mullgate/runtime/` |
| Relay cache | `~/.cache/mullgate/relays.json` |
| Docker compose bundle | `~/.local/state/mullgate/runtime/docker-compose.yml` |
| Runtime manifest | `~/.local/state/mullgate/runtime/runtime-manifest.json` |
| Last start report | `~/.local/state/mullgate/runtime/last-start.json` |

If you override `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, or `XDG_CACHE_HOME`, Mullgate resolves its paths under those directories instead. You can always print the active paths with:

```bash
pnpm exec tsx src/cli.ts config path
```

## Hostname access vs direct-IP access

Mullgate exposes the same authenticated proxy protocols through two addressing styles:

- **Hostname entrypoints**: useful when you want route names such as `sweden-gothenburg.proxy.example.com` or `austria-vienna`. These require DNS or `/etc/hosts` entries that resolve each hostname to its matching bind IP.
- **Direct bind-IP entrypoints**: useful when you do not want DNS or when local hostname resolution is not configured yet.

Why the mapping matters:

- Mullgate's multi-route runtime dispatches by **destination bind IP**.
- SOCKS5, HTTP, and optional HTTPS listeners stay truthful only when each route keeps a distinct bind IP.
- For hostname-based proof on a local machine, `mullgate config hosts` must be applied locally first so each hostname lands on the correct bind IP.

## Exposure workflow

Use `mullgate config exposure` when you need to change how routes are published after setup:

```bash
pnpm exec tsx src/cli.ts config exposure --help
pnpm exec tsx src/cli.ts config exposure
```

Typical sequence:

1. inspect the current posture with `config exposure`
2. update mode / base domain / bind IPs with `config exposure --mode ...`
3. rerun `mullgate config validate --refresh` or `mullgate start`
4. use `status` and `doctor` to confirm the saved/runtime state agrees with the intended exposure contract

`docs/usage.md` has concrete examples for loopback, private-network, and direct-IP/public access.

## Troubleshooting surfaces

When something looks wrong, check these in order:

1. `pnpm exec tsx src/cli.ts status`
2. `pnpm exec tsx src/cli.ts doctor`
3. `pnpm exec tsx src/cli.ts config hosts`
4. `pnpm exec tsx src/cli.ts config exposure`
5. `runtime-manifest.json` for the rendered listener/route inventory
6. `last-start.json` for the last runtime launch result and failure context

On a runtime launch failure, `last-start.json` and `status`/`doctor` are the fastest way to see the failing phase, route, bind IP, service name, compose file, and validation source without printing raw credentials.

## Next reading

- [docs/usage.md](docs/usage.md) — non-interactive setup variables, exposure editing, validation, hostname caveats, and troubleshooting details.
