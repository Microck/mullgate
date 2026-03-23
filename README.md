<p align="center">
  <img src="docs/mullgate-hero-logo.png" alt="mullgate" width="220" />
</p>

<p align="center">
  <a href="https://github.com/Microck/mullgate/releases"><img src="https://img.shields.io/github/v/release/Microck/mullgate?display_name=tag&color=000000" alt="release" /></a>
  <a href="https://github.com/Microck/mullgate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Microck/mullgate/ci.yml?branch=main&label=ci&color=000000" alt="ci" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Microck/mullgate?color=000000" alt="license" /></a>
</p>

<p align="center">
  <code>mullgate</code> turns your Mullvad subscription into authenticated SOCKS5, HTTP, and HTTPS proxies for selected apps. it is built for people who want one command surface for setup, named exit locations, and app-level routing without sending the whole machine through a VPN.
</p>

<p align="center">
  <a href="docs/usage.md">documentation</a> |
  <a href="#quickstart">install</a> |
  <a href="#platform-support">platform support</a>
</p>

---

## why

if you want Mullvad-backed proxy access without replacing your computer's normal network path, Mullgate gives you a practical path.

- expose authenticated SOCKS5, HTTP, and HTTPS proxy endpoints from your own Mullvad subscription
- route only the traffic you choose instead of tunneling the whole machine
- keep one CLI for setup, named exits, runtime checks, and diagnostics
- stay in control of the host and credentials instead of depending on a hosted relay service

## quickstart

Mullgate currently requires Node.js 22+.

The commands below describe the public install surface that the repo now targets. until the first npm publish lands, use the GitHub release `.tgz` asset or a source checkout from the usage guide.

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
mullgate config hosts
mullgate start
mullgate status
mullgate doctor
```

## platform support

Mullgate is currently a Linux-first runtime with truthful cross-platform install, config, and diagnostics surfaces.

| platform | install | `config path` / `status` / `doctor` | full runtime execution |
| --- | --- | --- | --- |
| Linux | Supported | Supported | **Supported** |
| macOS | Supported | Supported | **Partial** |
| Windows | Supported | Supported | **Partial** |

macOS and Windows can install the CLI and report config/runtime state truthfully, but the current Docker-first multi-route runtime still depends on Linux host-networking behavior. use Linux for the full setup and live runtime path.

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

## examples

set up two named exits and inspect the generated hostname mappings:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna

mullgate setup --non-interactive
mullgate config hosts
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

## install and release notes

- npm is the canonical install surface for the published CLI
- GitHub Releases attach the packed `.tgz` artifact and checksums for users who want a pinned release asset
- `scripts/install.sh` and `scripts/install.ps1` are convenience wrappers around the published npm package
- until the first npm publish lands, install from the GitHub release `.tgz` asset or from a source checkout instead
- `pnpm verify:s06` remains the Linux-first end-to-end proof for the assembled runtime

## documentation

- [usage guide](docs/usage.md)
- [multi-exit architecture spec](docs/multi-exit-architecture-spec.md)
- [`.env.example`](.env.example) - documented setup inputs for local runs
- `pnpm verify:s06` - integrated Linux-first runtime proof
- `pnpm verify:m003-install-path` - packed release/install-path proof

## disclaimer

this project is unofficial and not affiliated with, endorsed by, or connected to Mullvad VPN AB. it is an independent, community-built tool.

## license

[mit license](LICENSE)
