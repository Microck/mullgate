# Mullgate usage guide

This guide expands on the Linux-first flow in the repository [README](../README.md). It is written against the CLI help contract exposed by:

- `mullgate --help`
- `mullgate setup --help`
- `mullgate start --help`
- `mullgate status --help`
- `mullgate doctor --help`
- `mullgate config --help`

## Install forms

Mullgate now has three truthful invocation forms, in this order of preference:

1. **Installed tarball binary** — the supported distribution artifact verified by `pnpm verify:m003-install-path`
2. **Built CLI from a checkout** — `node dist/cli.js ...`
3. **Contributor/source-checkout path** — `pnpm exec tsx src/cli.ts ...`

This guide still shows source-checkout commands because the repo examples are easiest to reproduce that way. For an installed tarball, replace those `pnpm exec tsx src/cli.ts ...` examples with your installed `mullgate ...` binary.

## Platform support posture

Mullgate now reports platform support truthfully on Linux, macOS, and Windows.

| Platform | `config path` | `status` / `doctor` | Current runtime execution |
| --- | --- | --- | --- |
| Linux | Supported | Supported | **Fully supported** |
| macOS | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |
| Windows | Supported | Supported | **Limited** — Docker Desktop host networking does not match Linux |

Use Linux for the full setup/runtime/probe workflow. On macOS and Windows, treat the CLI and runtime manifest as supported config/diagnostic surfaces, but use a Linux host or Linux VM when you need the shipped multi-route Docker runtime to behave truthfully end to end.

## Non-interactive setup inputs

`mullgate setup --non-interactive` fails instead of prompting when required inputs are missing. You can supply values with flags, environment variables, or a mix of both.

### Required for a normal non-interactive run

| Purpose | Flag | Environment variable |
| --- | --- | --- |
| Mullvad account number | `--account-number <digits>` | `MULLGATE_ACCOUNT_NUMBER` |
| Proxy username | `--username <name>` | `MULLGATE_PROXY_USERNAME` |
| Proxy password | `--password <secret>` | `MULLGATE_PROXY_PASSWORD` |
| One or more routed locations | `--location <alias>` (repeatable) | `MULLGATE_LOCATION` or `MULLGATE_LOCATIONS` |

### Common optional inputs

| Purpose | Flag | Environment variable |
| --- | --- | --- |
| Device label | `--device-name <name>` | `MULLGATE_DEVICE_NAME` |
| Bind host / first route bind IP | `--bind-host <host>` | `MULLGATE_BIND_HOST` |
| Per-route bind IPs | `--route-bind-ip <ip>` (repeatable) | `MULLGATE_ROUTE_BIND_IPS` |
| Exposure mode | `--exposure-mode <mode>` | `MULLGATE_EXPOSURE_MODE` |
| Base domain | `--base-domain <domain>` | `MULLGATE_EXPOSURE_BASE_DOMAIN` |
| SOCKS5 port | `--socks-port <port>` | `MULLGATE_SOCKS_PORT` |
| HTTP port | `--http-port <port>` | `MULLGATE_HTTP_PORT` |
| HTTPS port | `--https-port <port>` | `MULLGATE_HTTPS_PORT` |
| HTTPS certificate path | `--https-cert-path <path>` | `MULLGATE_HTTPS_CERT_PATH` |
| HTTPS key path | `--https-key-path <path>` | `MULLGATE_HTTPS_KEY_PATH` |
| Mullvad provisioning endpoint | `--mullvad-wg-url <url>` | `MULLGATE_MULLVAD_WG_URL` |
| Mullvad relay metadata endpoint | `--mullvad-relays-url <url>` | `MULLGATE_MULLVAD_RELAYS_URL` |

Notes:

- `MULLGATE_LOCATION` is shorthand for route 1.
- `MULLGATE_LOCATIONS` is the ordered, comma-separated form for multi-route setup.
- `MULLGATE_ROUTE_BIND_IPS` is also ordered and comma-separated.
- Non-loopback exposure requires one explicit bind IP per routed location.
- Multi-route non-loopback exposure requires **distinct** bind IPs.

## Setup examples

### Example: local two-route loopback setup

This is the easiest way to prove the CLI/runtime flow on one Linux machine:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna
export MULLGATE_DEVICE_NAME=mullgate-loopback

pnpm exec tsx src/cli.ts setup --non-interactive
pnpm exec tsx src/cli.ts config hosts
```

What to expect:

- route 1 gets `127.0.0.1`
- route 2 gets `127.0.0.2`
- the configured hostnames default to the route aliases in loopback mode
- hostname access on the local machine works only after you install the emitted hosts block

### Example: private-network hostnames with a base domain

Use this when clients should reach the proxies from your LAN/VPN/overlay network and you want real hostnames per route:

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_LOCATIONS=sweden-gothenburg,austria-vienna
export MULLGATE_ROUTE_BIND_IPS=192.168.10.10,192.168.10.11
export MULLGATE_EXPOSURE_MODE=private-network
export MULLGATE_EXPOSURE_BASE_DOMAIN=proxy.example.com

pnpm exec tsx src/cli.ts setup --non-interactive
pnpm exec tsx src/cli.ts config exposure
```

What to expect:

- route hostnames become `sweden-gothenburg.proxy.example.com` and `austria-vienna.proxy.example.com`
- `config exposure` prints the DNS A records operators must publish
- each hostname must resolve to its own bind IP before hostname-based routing proof can work remotely

### Example: direct-IP exposure with no base domain

If you do not set a base domain in `private-network` or `public` mode, Mullgate falls back to the bind IPs as the hostnames clients should use:

```bash
pnpm exec tsx src/cli.ts config exposure \
  --mode private-network \
  --clear-base-domain \
  --route-bind-ip 192.168.10.10 \
  --route-bind-ip 192.168.10.11
```

In that posture:

- there are no DNS records to publish
- direct bind-IP entrypoints are the intended access path
- `config hosts` is still useful for local-only hostname testing, but it is no longer required for remote clients

## Direct-IP access vs hostname/domain access

Mullgate exposes the same per-route listeners in two parallel forms:

- **hostname entrypoints** — route-aware names such as `sweden-gothenburg`, `austria-vienna`, or `sweden-gothenburg.proxy.example.com`
- **direct-IP entrypoints** — the bind IP for each route, such as `127.0.0.1`, `127.0.0.2`, or `192.168.10.10`

### When hostname access works

Hostname-based access works only when the client resolves each configured hostname to the bind IP Mullgate assigned to that route.

That can come from:

- local `/etc/hosts` entries produced by `mullgate config hosts`
- published DNS records when you use `--base-domain`
- some other trusted name-resolution system that preserves the same hostname → bind IP mapping

### Why the mapping matters for multi-route proof

Mullgate's routing layer dispatches by **destination bind IP**, not by a late application-level hint. That means:

- every remote route needs its own bind IP
- hostname proof only works when name resolution lands on the correct IP first
- if two hostnames resolve to the same bind IP, they collapse to the same route
- if a hostname resolves somewhere else, `mullgate doctor` reports hostname drift and points you back to `mullgate config hosts`

### Example curl forms

SOCKS5 with a hostname-mapped local route:

```bash
curl \
  --proxy socks5h://sweden-gothenburg:1080 \
  --proxy-user "$MULLGATE_PROXY_USERNAME:$MULLGATE_PROXY_PASSWORD" \
  https://am.i.mullvad.net/json
```

HTTP using a direct bind IP:

```bash
curl \
  --proxy http://127.0.0.2:8080 \
  --proxy-user "$MULLGATE_PROXY_USERNAME:$MULLGATE_PROXY_PASSWORD" \
  https://am.i.mullvad.net/json
```

If HTTPS proxy support is configured with a cert, key, and HTTPS port, the same route inventory appears in `config exposure`, `start`, `status`, and `runtime-manifest.json`.

## Editing exposure after setup

Use `mullgate config exposure` instead of editing JSON by hand.

### Inspect the current posture

```bash
pnpm exec tsx src/cli.ts config exposure
```

The report includes:

- mode (`loopback`, `private-network`, or `public`)
- base domain and whether LAN access is expected
- per-route hostname and bind IP inventory
- DNS guidance when a base domain is set
- hostname and direct-IP listener URLs with credentials redacted
- whether the current runtime state needs a restart/refresh

### Update the posture

Example: switch from loopback to private-network hostnames:

```bash
pnpm exec tsx src/cli.ts config exposure \
  --mode private-network \
  --base-domain proxy.example.com \
  --route-bind-ip 192.168.10.10 \
  --route-bind-ip 192.168.10.11
```

Example: switch to direct-IP public exposure:

```bash
pnpm exec tsx src/cli.ts config exposure \
  --mode public \
  --clear-base-domain \
  --route-bind-ip 203.0.113.10 \
  --route-bind-ip 203.0.113.11
```

After an exposure edit, Mullgate marks the runtime state as `unvalidated`. Do one of these before trusting the saved/runtime surfaces again:

```bash
pnpm exec tsx src/cli.ts config validate --refresh
# or
pnpm exec tsx src/cli.ts start
```

## Validation and runtime lifecycle

### `mullgate config validate`

Use this when you want to refresh or verify derived runtime artifacts without starting Docker immediately.

```bash
pnpm exec tsx src/cli.ts config validate --help
pnpm exec tsx src/cli.ts config validate --refresh
```

It validates the rendered wireproxy config and persists validation metadata under the runtime directory.

### `mullgate start`

```bash
pnpm exec tsx src/cli.ts start
```

This command:

1. loads the canonical config
2. verifies HTTPS asset presence when HTTPS is enabled
3. loads the saved relay cache
4. re-renders per-route wireproxy configs and the runtime bundle
5. validates the rendered config
6. launches `docker compose up --detach`
7. saves a secret-safe `last-start.json` report

### `mullgate status`

```bash
pnpm exec tsx src/cli.ts status
```

Use it to compare:

- saved runtime phase vs live Docker Compose state
- route/service inventory vs published entrypoints
- runtime manifest presence
- last-start diagnostics

### `mullgate doctor`

```bash
pnpm exec tsx src/cli.ts doctor
```

Use it when you need deterministic diagnostics for:

- config presence / parse failures
- validation artifact drift
- relay cache freshness
- exposure posture mismatches
- bind IP mistakes
- hostname resolution drift
- stopped or degraded route containers
- the last recorded runtime start failure

## Inspectable files and what they mean

The fastest way to find the active XDG paths is:

```bash
pnpm exec tsx src/cli.ts config path
```

That report now also prints:

- the resolved platform id and whether it came from the real host or `MULLGATE_PLATFORM`
- the current platform support level (`full` on Linux, `partial` on macOS/Windows)
- the runtime story and host-networking limitations for the current platform
- platform guidance and warnings that match the wording used by `status`, `doctor`, and `runtime-manifest.json`

Important files:

| File | Meaning |
| --- | --- |
| `config.json` | Canonical Mullgate config with routed locations, exposure settings, and persisted runtime status |
| `wireproxy.conf` | Primary rendered wireproxy config path recorded in the canonical config |
| `wireproxy-configtest.json` | Persisted config validation report |
| `docker-compose.yml` | Rendered runtime bundle entrypoint for `mullgate start` |
| `runtime-manifest.json` | Truthful route/endpoint manifest, including redacted published URLs and backend topology |
| `last-start.json` | Secret-safe success/failure report for the most recent `mullgate start` attempt |

## Integrated release verifier

Use the integrated Linux-first proof command when you want one end-to-end check for the assembled setup/runtime flow instead of running setup, start, status, doctor, and curl probes manually.

### Required environment variables

| Purpose | Environment variable |
| --- | --- |
| Mullvad account number | `MULLGATE_ACCOUNT_NUMBER` |
| Proxy username | `MULLGATE_PROXY_USERNAME` |
| Proxy password | `MULLGATE_PROXY_PASSWORD` |
| Deterministic Mullvad device name | `MULLGATE_DEVICE_NAME` |

### Optional verifier and setup inputs

| Purpose | Environment variable / flag |
| --- | --- |
| Routed locations (default `sweden-gothenburg,austria-vienna`) | `MULLGATE_LOCATIONS` |
| Direct-route check target (default `1.1.1.1`) | `MULLGATE_VERIFY_ROUTE_CHECK_IP` / `--route-check-ip` |
| Exit-check URL (default `https://am.i.mullvad.net/json`) | `MULLGATE_VERIFY_TARGET_URL` / `--target-url` |
| HTTPS port (default `8443` when the verifier generates TLS assets) | `MULLGATE_HTTPS_PORT` |
| Existing HTTPS cert/key paths | `MULLGATE_HTTPS_CERT_PATH`, `MULLGATE_HTTPS_KEY_PATH` |
| Preserve the temp XDG home even on success | `--keep-temp-home` |

### Command

```bash
export MULLGATE_ACCOUNT_NUMBER=123456789012
export MULLGATE_PROXY_USERNAME=alice
export MULLGATE_PROXY_PASSWORD='replace-me'
export MULLGATE_DEVICE_NAME=mullgate-s06-proof
pnpm verify:s06
```

### What the verifier proves

- non-interactive `mullgate setup` against the real CLI
- `mullgate config hosts` output and saved hostname → bind IP mappings
- `mullgate start`, `mullgate status`, and `mullgate doctor`
- authenticated SOCKS5, HTTP, and HTTPS traffic through the published listeners
- direct host-route invariance before/after `mullgate start`
- distinct exits for the first two routed hostnames when they resolve locally to distinct bind IPs

### Route-slot prerequisite

The verifier needs one free Mullvad WireGuard device slot per routed location because setup provisions real per-route WireGuard state. If you keep the default two-route verifier contract, the account must have two free slots before `pnpm verify:s06` can pass.

### HTTPS proof note

If you do not provide `MULLGATE_HTTPS_CERT_PATH` and `MULLGATE_HTTPS_KEY_PATH`, the verifier generates a temporary self-signed cert/key with `openssl`. That keeps the HTTPS proof real without asking you to persist raw TLS key material in the saved failure bundle.

### Hostname-resolution failures

The verifier intentionally does **not** hide hostname drift.

If it fails on hostname resolution:

1. run `pnpm exec tsx src/cli.ts config hosts`
2. install the emitted hosts block locally, or publish/update DNS when using a base domain
3. rerun `pnpm exec tsx src/cli.ts doctor`
4. rerun `pnpm verify:s06`

On failure, the verifier preserves its temp XDG home and prints the paths to the saved config, `runtime-manifest.json`, `last-start.json`, and captured CLI/probe outputs so a later agent can localize the break quickly.

## Troubleshooting playbook

### `setup` fails

Check the reported:

- `phase`
- `source`
- optional `code`
- failing route context when multi-route setup is in play
- artifact/config path

Common causes:

- missing required non-interactive inputs
- invalid bind IP counts in non-loopback exposure
- duplicate bind IPs across multiple remote routes
- HTTPS configured without both cert and key
- Mullvad provisioning or relay metadata fetch failures

### `start` fails

Run these next:

```bash
pnpm exec tsx src/cli.ts status
pnpm exec tsx src/cli.ts doctor
```

Then inspect:

- `last-start.json`
- `runtime-manifest.json`
- the compose file path reported in `status`/`doctor`

Look for:

- compose detection failures (`docker compose` missing)
- validation failures before launch
- route-specific service failures
- hostname drift after exposure changes

### Hostnames do not resolve to the right route

Symptoms:

- `doctor` fails the `hostname-resolution` check
- the hostname resolves to the wrong bind IP
- two routes appear to collapse to the same exit

What to do:

1. run `pnpm exec tsx src/cli.ts config hosts`
2. install the emitted hosts block locally, or publish/update DNS so every hostname resolves to its saved bind IP
3. rerun `pnpm exec tsx src/cli.ts doctor`

### Runtime state looks stale after an exposure or config edit

If `status` or `config exposure` shows `runtime status: unvalidated` or `restart needed: yes`, rerun one of:

```bash
pnpm exec tsx src/cli.ts config validate --refresh
pnpm exec tsx src/cli.ts start
```

That is the supported way to bring saved config, derived artifacts, and the Docker runtime back into sync.
