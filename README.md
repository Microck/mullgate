<p align="center">
  <img src="docs/mullgate-logo.svg" alt="Mullgate" width="160" />
</p>

---

`mullgate` turns your Mullvad subscription into authenticated SOCKS5, HTTP, and HTTPS proxies for selected apps. it is built for people who want app-level routing, named location endpoints, and a self-hosted CLI workflow without sending the whole machine through a VPN.

[documentation](docs/usage.md) | [source install](#install-and-run) | [release verifier](#integrated-release-verifier)

## why

if you want Mullvad-backed proxy access without replacing your computer's normal network path, Mullgate gives you a practical path.

- expose authenticated SOCKS5, HTTP, and HTTPS proxy endpoints from your own Mullvad subscription
- route only the traffic you choose instead of tunneling the whole machine
- use named location endpoints and route-aware diagnostics from one CLI
- keep Linux as the truthful full runtime target while still getting cross-platform config and diagnostic reporting

## first-release scope

this repository currently ships a **Linux-first runtime** with **cross-platform config/diagnostic reporting**.

- fully supported: Linux runtime execution from a source checkout or built CLI install with Node.js 22+, pnpm, and Docker Compose.
- supported: guided or non-interactive setup, route-aware host mapping guidance, Docker runtime start, `status`, `doctor`, and config inspection/update commands on Linux.
- supported: platform-aware `config path`, runtime-manifest output, `status`, and `doctor` reporting for Linux, macOS, and Windows.
- limited: macOS and Windows runtime execution under the current Docker-first topology, because Docker Desktop does not provide the Linux host-networking semantics that Mullgate's per-route bind-IP runtime depends on.
- not shipped here: GUI flows or a separate desktop installer surface.

## prerequisites

install these before following the **full runtime quick start**:

- Linux
- Node.js 22+
- pnpm
- Docker with the `docker compose` plugin available on `PATH`
- curl
- a live Mullvad account number
- a proxy username/password you want Mullgate to require on the published SOCKS5/HTTP/HTTPS listeners
- enough free Mullvad WireGuard device slots for the routed locations you will verify (the default two-route proof needs two free slots)
- `openssl` if you want `pnpm verify:s06` to generate its own temporary HTTPS certificate/key pair

cross-platform note:

- `config path`, `status`, `doctor`, and the runtime manifest now report truthful platform support on Linux, macOS, and Windows.
- the current Docker-first runtime remains Linux-first. on macOS and Windows, treat the CLI and manifest surfaces as supported diagnostics/config tooling, but use a Linux host or Linux VM when you need the shipped multi-route runtime to behave truthfully end to end.

## platform support matrix

| Platform | Config paths | Runtime manifest | `status` / `doctor` | Runtime execution |
| --- | --- | --- | --- | --- |
| Linux | Supported | Supported | Supported | **Fully supported** |
| macOS | Supported | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |
| Windows | Supported | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |

Interpretation:

- Linux is the reference runtime target for the current Mullgate topology.
- macOS and Windows are supported for truthful path inspection and diagnostics, but not for claiming Linux-equivalent runtime parity under the current Docker-first design.
- If you need the current multi-route runtime to behave truthfully on macOS or Windows, run it inside a Linux VM or on a separate Linux host.

## Install and run

### Supported distribution artifact: release tarball

Mullgate’s first-class distribution surface in this repo is the packed tarball produced by `pnpm pack`. The tarball contains the built CLI (`dist/`) plus the README, and M003’s install-path verifier proves that installing that tarball into a clean prefix exposes a working `mullgate` command.

To produce the tarball locally:

```bash
pnpm build
pnpm pack --pack-destination release-artifacts
```

That writes a file like `release-artifacts/mullgate-0.1.0.tgz`.

### Option 1: install the packed tarball locally

```bash
pnpm build
pnpm pack --pack-destination release-artifacts
npm install -g --prefix "$HOME/.local" ./release-artifacts/mullgate-0.1.0.tgz
~/.local/bin/mullgate --help
```

This is the current supported installed-user path for the repo. If you prefer a different prefix, change `--prefix` and invoke the installed `bin/mullgate` from that prefix.

### Option 2: source checkout (current contributor path)

```bash
pnpm install
pnpm build
pnpm exec tsx src/cli.ts --help
```

This is the most complete path in the repository today and the one used by the current tests/verifiers.

### Option 3: built CLI from this checkout

After `pnpm build`, you can invoke the compiled CLI directly:

```bash
node dist/cli.js --help
```

The help text and docs call the command `mullgate` because that is the CLI name exposed by the program. In a source checkout, replace `mullgate ...` with either the installed tarball binary, `pnpm exec tsx src/cli.ts ...`, or `node dist/cli.js ...`.

### Example environment file

Use `.env.example` as the starting point for non-interactive setup and live verifier inputs. Copy it to `.env` for local work, then replace the example values with real secrets on your machine only.

## Quick start

### 1. Install dependencies and build the CLI

```bash
pnpm install
pnpm build
```

### 2. Export the required setup inputs

Use `.env.example` as the authoritative list of documented setup/verifier variables. You can either export them manually or copy `.env.example` to `.env` and load it in your shell.

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

## Integrated release verifier

When you want one Linux-first proof command for the assembled product, use:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_DEVICE_NAME=mullgate-s06-proof
pnpm verify:s06
```

What the verifier does:

- creates a temp XDG home so it does not reuse your normal Mullgate state
- runs `mullgate setup --non-interactive` against the real CLI and real Mullvad/Docker/curl prerequisites
- prints/checks `mullgate config hosts`
- starts the Docker runtime and verifies `mullgate status` + `mullgate doctor`
- probes authenticated SOCKS5, HTTP, and HTTPS traffic against `https://am.i.mullvad.net/json`
- confirms the host route to `1.1.1.1` did not change when Mullgate started
- compares the exits for the first two routed hostnames when they resolve locally to distinct bind IPs

Verifier notes:

- If `MULLGATE_LOCATIONS` is unset, the verifier defaults to `sweden-gothenburg,austria-vienna`.
- The verifier needs one free Mullvad WireGuard device slot per routed location. The default two-route proof therefore needs two free slots on the account before setup can succeed.
- If `MULLGATE_HTTPS_CERT_PATH` and `MULLGATE_HTTPS_KEY_PATH` are unset, the verifier generates a temporary self-signed cert/key via `openssl` so HTTPS proxy proof stays real without persisting raw key material in the saved failure bundle.
- On failure, the verifier preserves the temp XDG home and prints the paths to the saved config, `runtime-manifest.json`, `last-start.json`, and captured CLI/probe outputs.
- If the proof fails on hostname resolution, fix that with `mullgate config hosts` (or real DNS when using a base domain), then rerun `pnpm verify:s06`.

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

## next reading

- [docs/usage.md](docs/usage.md) — non-interactive setup variables, exposure editing, validation, hostname caveats, and troubleshooting details.

ure context

On a runtime launch failure, `last-start.json` and `status`/`doctor` are the fastest way to see the failing phase, route, bind IP, service name, compose file, and validation source without printing raw credentials.

## Next reading

- [docs/usage.md](docs/usage.md) — non-interactive setup variables, exposure editing, validation, hostname caveats, and troubleshooting details.
