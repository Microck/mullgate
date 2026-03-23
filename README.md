<p align="center">
  <img src="docs/mullgate-hero-logo.png" alt="mullgate" width="220" />
</p>

<p align="center">
  <a href="https://github.com/Microck/mullgate/releases"><img src="https://img.shields.io/github/v/release/Microck/mullgate?display_name=tag&color=000000" alt="release" /></a>
  <a href="https://github.com/Microck/mullgate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/mullgate/ci.yml?branch=main&label=ci&color=000000" alt="ci" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Microck/mullgate?color=000000" alt="license" /></a>
</p>

<p align="center">
  <code>mullgate</code> turns your Mullvad subscription into authenticated SOCKS5, HTTP, and HTTPS proxies for selected apps. it is built for people who want one command surface for setup, app-level routing, named location endpoints, and a self-hosted workflow without sending the whole machine through a VPN.
</p>

<p align="center">
  <a href="docs/usage.md">documentation</a> |
  <a href="#install-and-run">install</a> |
  <a href="#integrated-release-verifier">release verifier</a>
</p>

---

## why

if you want Mullvad-backed proxy access without replacing your computer's normal network path, Mullgate gives you a practical path.

- expose authenticated SOCKS5, HTTP, and HTTPS proxy endpoints from your own Mullvad subscription
- route only the traffic you choose instead of tunneling the whole machine
- use named location endpoints and route-aware diagnostics from one CLI
- keep Linux as the truthful full runtime target while still getting cross-platform config and diagnostic reporting

## quickstart

### install the verified tarball artifact

```bash
pnpm build
pnpm pack --pack-destination release-artifacts
npm install -g --prefix "$HOME/.local" ./release-artifacts/mullgate-0.1.0.tgz
~/.local/bin/mullgate --help
```

### build from a checkout

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

### non-interactive setup

use `.env.example` as the starting point for local setup inputs.

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna
export MULLGATE_DEVICE_NAME=mullgate-local

pnpm exec tsx src/cli.ts setup --non-interactive
pnpm exec tsx src/cli.ts config hosts
pnpm exec tsx src/cli.ts start
pnpm exec tsx src/cli.ts status
pnpm exec tsx src/cli.ts doctor
```

## first-release scope

this repository currently ships a **Linux-first runtime** with **cross-platform config/diagnostic reporting**.

- fully supported: Linux runtime execution from a source checkout or built CLI install with Node.js 22+, pnpm, and Docker Compose.
- supported: guided or non-interactive setup, route-aware host mapping guidance, Docker runtime start, `status`, `doctor`, and config inspection/update commands on Linux.
- supported: platform-aware `config path`, runtime-manifest output, `status`, and `doctor` reporting for Linux, macOS, and Windows.
- limited: macOS and Windows runtime execution under the current Docker-first topology, because Docker Desktop does not provide the Linux host-networking semantics that Mullgate's per-route bind-IP runtime depends on.
- not shipped here: GUI flows or a separate desktop installer surface.

## platform support matrix

| platform | config paths | runtime manifest | `status` / `doctor` | runtime execution |
| --- | --- | --- | --- | --- |
| Linux | Supported | Supported | Supported | **Fully supported** |
| macOS | Supported | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |
| Windows | Supported | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |

notes:

- Linux is the reference runtime target for the current Mullgate topology.
- macOS and Windows are supported for truthful path inspection and diagnostics, but not for claiming Linux-equivalent runtime parity under the current Docker-first design.
- if you need the current multi-route runtime to behave truthfully on macOS or Windows, run it inside a Linux VM or on a separate Linux host.

## install and run

### supported distribution artifact: release tarball

Mullgate’s first-class distribution surface in this repo is the packed tarball produced by `pnpm pack`. the tarball contains the built CLI (`dist/`) plus the README, and `pnpm verify:m003-install-path` proves that installing that tarball into a clean prefix exposes a working `mullgate` command.

produce the tarball locally:

```bash
pnpm build
pnpm pack --pack-destination release-artifacts
```

that writes a file like `release-artifacts/mullgate-0.1.0.tgz`.

install it locally:

```bash
npm install -g --prefix "$HOME/.local" ./release-artifacts/mullgate-0.1.0.tgz
~/.local/bin/mullgate --help
```

if you prefer a different prefix, change `--prefix` and invoke the installed `bin/mullgate` from that prefix.

### source checkout

```bash
pnpm install
pnpm build
pnpm exec tsx src/cli.ts --help
```

this is the most complete path in the repository today and the one used by the current tests and verifiers.

### built CLI from this checkout

```bash
node dist/cli.js --help
```

in a source checkout, replace `mullgate ...` with either the installed tarball binary, `pnpm exec tsx src/cli.ts ...`, or `node dist/cli.js ...`.

### example environment file

use `.env.example` as the starting point for non-interactive setup and live verifier inputs. copy it to `.env` for local work, then replace the example values with real secrets on your machine only.

## integrated release verifier

when you want one Linux-first proof command for the assembled product, use:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_DEVICE_NAME=mullgate-s06-proof
pnpm verify:s06
```

what the verifier does:

- creates a temp XDG home so it does not reuse your normal Mullgate state
- runs `mullgate setup --non-interactive` against the real CLI and real Mullvad/Docker/curl prerequisites
- prints/checks `mullgate config hosts`
- starts the Docker runtime and verifies `mullgate status` + `mullgate doctor`
- probes authenticated SOCKS5, HTTP, and HTTPS traffic against `https://am.i.mullvad.net/json`
- confirms the host route to `1.1.1.1` did not change when Mullgate started
- compares the exits for the first two routed hostnames when they resolve locally to distinct bind IPs

verifier notes:

- if `MULLGATE_LOCATIONS` is unset, the verifier defaults to `sweden-gothenburg,austria-vienna`.
- the verifier needs one free Mullvad WireGuard device slot per routed location. the default two-route proof therefore needs two free slots on the account before setup can succeed.
- if `MULLGATE_HTTPS_CERT_PATH` and `MULLGATE_HTTPS_KEY_PATH` are unset, the verifier generates a temporary self-signed cert/key via `openssl` so HTTPS proxy proof stays real without persisting raw key material in the saved failure bundle.
- on failure, the verifier preserves the temp XDG home and prints the paths to the saved config, `runtime-manifest.json`, `last-start.json`, and captured CLI/probe outputs.
- if the proof fails on hostname resolution, fix that with `mullgate config hosts` (or real DNS when using a base domain), then rerun `pnpm verify:s06`.

## command surface

| command | purpose |
| --- | --- |
| `mullgate setup` | guided or non-interactive Mullvad-backed setup that persists canonical config and derived runtime artifacts |
| `mullgate start` | re-render artifacts, validate them, and launch the Docker runtime bundle |
| `mullgate status` | inspect saved runtime state, runtime artifacts, live Docker Compose state, and exposure entrypoints |
| `mullgate doctor` | run deterministic diagnostics for config, runtime, bind, DNS, and last-start failures |
| `mullgate config path` | print active config/state/cache/runtime paths plus platform support posture |
| `mullgate config hosts` | print hostname to bind-IP mappings and the copy/paste hosts block |
| `mullgate config exposure` | inspect or update loopback, private-network, and public exposure posture |
| `mullgate config validate` | validate rendered wireproxy config and refresh runtime validation metadata |

## quick operator notes

- Mullgate is a **proxy tool**, not a full-device VPN client.
- hostname-selected routing depends on each hostname resolving to the correct route bind IP.
- the current runtime is Linux-first; macOS and Windows are truthful config/diagnostic surfaces, not Linux-equivalent runtime targets.
- HTTPS, HTTP, and SOCKS5 are all part of the supported proxy surface.

## troubleshooting

when something looks wrong, check these in order:

1. `mullgate status`
2. `mullgate doctor`
3. `mullgate config hosts`
4. `mullgate config exposure`
5. `runtime-manifest.json`
6. `last-start.json`

on a runtime launch failure, `last-start.json` and `status`/`doctor` are the fastest way to see the failing phase, route, bind IP, service name, compose file, and validation source without printing raw credentials.

## building from source

if you are working on Mullgate itself:

```bash
git clone https://github.com/Microck/mullgate.git
cd mullgate
pnpm install
pnpm build
node dist/cli.js --help
```

## documentation

- [usage guide](docs/usage.md)
- `.env.example` — documented setup/verifier environment template
- `pnpm verify:s06` — integrated Linux-first runtime proof
- `pnpm verify:m003-repo-baseline` — public repo baseline proof
- `pnpm verify:m003-install-path` — tarball/install-path proof

## disclaimer

this project is unofficial and not affiliated with, endorsed by, or connected to Mullvad VPN AB. it is an independent, community-built tool.

## license

[mit license](LICENSE)
