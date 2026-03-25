<p align="center">
  <img src=".github/assets/mullgate-logo.png" alt="mullgate" width="720">
</p>


<p align="center">
  <a href="https://github.com/Microck/mullgate/releases"><img src="https://img.shields.io/github/v/release/Microck/mullgate?display_name=tag&style=flat-square&label=release&color=000000" alt="release badge"></a>
  <a href="https://github.com/Microck/mullgate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/mullgate/ci.yml?branch=main&style=flat-square&label=ci&color=000000" alt="ci badge"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-mit-000000?style=flat-square" alt="license badge"></a>
</p>

---

`mullgate` turns your Mullvad subscription into authenticated SOCKS5, HTTP, and HTTPS proxies for selected apps. it is built for people who want one command surface for setup, named exit locations, relay discovery, exposure control, and app-level routing without sending the whole machine through a VPN.

the main setup path is `mullgate setup`. on a real terminal it opens a guided flow that collects your Mullvad account number, proxy credentials, route aliases, bind posture, and optional HTTPS settings, then persists canonical config plus the derived runtime artifacts needed for `start`, `status`, and `doctor`. if you prefer automation, the same surface also supports a fully non-interactive env-driven setup path.

[documentation](https://mullgate.micr.dev) | [npm](https://www.npmjs.com/package/mullgate) | [github](https://github.com/Microck/mullgate)

![setup demo](images/demos/setup-guided.gif)

once your routes are saved, `mullgate` can also generate ready-to-paste client inventories and help you choose better exact exits. use `mullgate regions` to inspect the built-in region groups, run `mullgate export --guided` for a setup-style `proxies.txt` flow with country and region pick-lists, inspect relay candidates with `mullgate relays list` or `mullgate relays probe`, then preview or apply exact pinned recommendations with `mullgate recommend`.

## why

if you want Mullvad-backed proxy access without replacing your computer's normal network path, `mullgate` gives you a practical path.

- expose authenticated SOCKS5, HTTP, and HTTPS proxy endpoints from your own Mullvad subscription
- route only the traffic you choose instead of tunneling the whole machine
- keep one CLI for setup, relay selection, named exits, runtime checks, and diagnostics
- stay in control of the host and credentials instead of depending on a hosted relay service

## how mullgate differs from mullvad's socks5 proxy

mullvad's socks5 proxy is a socks5 endpoint inside the mullvad vpn tunnel. you connect to mullvad first, then manually point an app or browser at that proxy.

mullgate is a local operator layer built around a mullvad subscription. it provisions named exits, exposes authenticated socks5, http, and https proxy entrypoints on your machine, and gives you one cli surface for setup, exposure control, runtime checks, and failure diagnostics.

the goal is not "replace mullvad's proxy page with another set of manual steps." the goal is to give self-hosters a managed proxy gateway that uses mullvad exits without forcing the whole machine through the vpn.

the hard part is that mullvad only gives each account 5 wireguard devices. once you want multiple real routed exits, that limit becomes an architectural constraint, which is why mullgate is more than a thin wrapper around mullvad's socks5 proxy.

## architecture

### runtime flow

```mermaid
flowchart LR
    A[Client app or remote client] --> B[Route-specific hostname or bind IP]
    B --> C[Mullgate listener]
    C --> D[Mullgate routing layer]
    D --> E[Selected relay or configured exact exit]
    E --> F[Mullvad-backed observed exit]
    F --> G[Destination]
```

### hostname truth model

```mermaid
flowchart TD
    A[Configured route] --> B[Assigned bind IP]
    A --> C[Published hostname]
    C --> D[DNS or hosts resolution]
    D --> B
    B --> E[Route-specific listener]
    E --> F[Correct route selection]

    X[Two hostnames on one bind IP] --> Y[Not two truthful routes]
```

## quickstart

`mullgate` currently requires Node.js 22+.

install from npm for the normal path, or use a GitHub release standalone binary/archive when you want a pinned platform artifact.

### Linux or macOS

```bash
curl -fsSL https://raw.githubusercontent.com/Microck/mullgate/main/scripts/install.sh | sh
mullgate --help
```

### Windows

```powershell
irm https://raw.githubusercontent.com/Microck/mullgate/main/scripts/install.ps1 | iex
mullgate --help
```

### using a package manager

```bash
npm install -g mullgate
pnpm add -g mullgate
bun add -g mullgate
```

### first run

for an interactive setup flow:

```bash
mullgate setup
```

for non-interactive setup, start from [`.env.example`](.env.example) and then run:

```bash
mullgate setup --non-interactive
mullgate hosts
mullgate regions
mullgate export --guided
mullgate start
mullgate status
mullgate doctor
```

## platform support

`mullgate` is currently a Linux-first runtime with truthful cross-platform install, config, and diagnostics surfaces.

| platform | install | `path` / `status` / `doctor` | full runtime execution |
| --- | --- | --- | --- |
| Linux | Supported | Supported | **Supported** |
| macOS | Supported | Supported | **Partial** |
| Windows | Supported | Supported | **Partial** |

macOS and Windows can install the CLI and report config/runtime state truthfully, but the current Docker-first multi-route runtime still depends on Linux host-networking behavior. use Linux for the full setup and live runtime path.

## command surface

| command | key flags | purpose |
| --- | --- | --- |
| `mullgate setup` | `--non-interactive` | guided or automated Mullvad-backed setup that persists canonical config and derived runtime artifacts |
| `mullgate start` | none | re-render artifacts, validate them, and launch the Docker runtime bundle |
| `mullgate status` | none | inspect saved runtime state, runtime artifacts, live Docker Compose state, and exposure entrypoints |
| `mullgate doctor` | none | run deterministic diagnostics for config, runtime, bind, DNS, and last-start failures |
| `mullgate autostart` | `enable`, `disable`, `status` | manage a Linux `systemd --user` unit that starts the proxy runtime at login |
| `mullgate path` | none | print active config/state/cache/runtime paths plus platform support posture |
| `mullgate hosts` | none | print hostname to bind-IP mappings and the copy/paste hosts block |
| `mullgate export` | `--guided`, `--dry-run`, `--stdout` | generate authenticated proxy URL inventories with ordered country or region batches plus selective relay filters |
| `mullgate relays` | `list`, `probe`, `verify` | inspect matching relays, rank candidates, and verify configured route exits through the published proxy protocols |
| `mullgate recommend` | `--apply`, selector flags | probe matching relays, preview exact routes, and optionally pin recommended relay hostnames into saved config |
| `mullgate regions` | none | print the curated region groups accepted by `export --region ...` |
| `mullgate exposure` | `--mode`, `--base-domain` | inspect or update loopback, private-network, and public exposure posture |
| `mullgate validate` | `--refresh` | validate rendered wireproxy config and refresh runtime validation metadata |

## examples

set up two named exits and inspect the generated hostname mappings:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna

mullgate setup --non-interactive
mullgate hosts
```

start the runtime and inspect its current posture:

```bash
mullgate start
mullgate status
mullgate doctor
```

use one of the exposed routes from another client or shell:

```bash
curl \
  --proxy socks5h://sweden-gothenburg:1080 \
  --proxy-user "$MULLGATE_PROXY_USERNAME:$MULLGATE_PROXY_PASSWORD" \
  https://am.i.mullvad.net/json
```

generate a shareable proxy list from the saved route inventory:

```bash
mullgate regions
mullgate export --guided
mullgate export --country se --city got --count 1 --region europe --provider m247 --owner mullvad --run-mode ram --min-port-speed 9000 --count 2 --output proxies.txt
mullgate export --dry-run --protocol http --country us --server us-nyc-wg-001 --owner rented
```

inspect candidate relays, preview the fastest exact match, then verify a configured exit:

```bash
mullgate relays list --country Sweden --owner mullvad --run-mode ram --min-port-speed 9000
mullgate relays probe --country Sweden --count 2
mullgate recommend --country Sweden --count 1
mullgate recommend --country Sweden --count 1 --apply
mullgate relays verify --route sweden-gothenburg
```

enable login-time startup on Linux when you want the proxy runtime to come back automatically:

```bash
mullgate autostart enable
mullgate autostart status
```

## documentation

- [documentation site](https://mullgate.micr.dev)
- [quickstart](https://mullgate.micr.dev/docs/getting-started/quickstart)
- [usage guide](https://mullgate.micr.dev/docs/guides/usage)
- [setup and exposure](https://mullgate.micr.dev/docs/guides/setup-and-exposure)
- [command reference](https://mullgate.micr.dev/docs/reference/commands)
- [troubleshooting](https://mullgate.micr.dev/docs/guides/troubleshooting)
- [`.env.example`](.env.example) - documented setup inputs for local runs

## disclaimer

this project is unofficial and not affiliated with, endorsed by, or connected to Mullvad VPN AB. it is an independent, community-built tool.

## license

[mit license](LICENSE)
