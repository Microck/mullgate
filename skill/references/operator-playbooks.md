# Operator Playbooks

Use these concise playbooks for common real-machine Mullgate requests.

## Tailscale Or Private-Network Exposure

Goal: make Mullgate reachable from another trusted-network machine.

Rules:

- Use `private-network`.
- Use the host's real trusted-network IP, such as its Tailscale `100.x` address.
- Do not tell clients to use `0.0.0.0`. That is a bind-any address, not a client target.

Typical command:

```bash
mullgate proxy access \
  --mode private-network \
  --route-bind-ip 100.124.44.113

mullgate proxy start
mullgate proxy access
```

## One Stable Host With Country, City, Or Server In The Proxy URL

Goal: keep one host and choose the exit inline in the proxy username.

Use:

- `private-network`
- `inline-selector`

Typical command:

```bash
mullgate proxy access \
  --mode private-network \
  --access-mode inline-selector \
  --route-bind-ip 100.124.44.113

mullgate proxy start
mullgate proxy access
```

Typical client URLs:

```text
socks5://ca:@100.124.44.113:1080
socks5://ca-tor:@100.124.44.113:1080
socks5://ca-tor-wg-301:@100.124.44.113:1080
http://ca:@100.124.44.113:8080
```

Rules:

- Use the guaranteed form `scheme://selector:@host:port`.
- `selector@host:port` is best-effort only.
- For supported selector families, consult the inline selector reference docs.

## Export A Proxy Inventory File

Goal: produce a list or file of route URLs for clients.

Use `published-routes`, not `inline-selector`.

Typical flow:

```bash
mullgate proxy export --regions
mullgate proxy export --guided
```

If the user asks for exact batch selection:

```bash
mullgate proxy export \
  --country se --city got --count 1 \
  --region europe --provider m247 --count 2 \
  --output proxies.txt
```

## Find Or Pin A Better Exact Exit

Goal: move from broad location intent to a justified exact relay.

Typical flow:

```bash
mullgate proxy relay list --country Sweden --owner mullvad --run-mode ram --min-port-speed 9000
mullgate proxy relay probe --country Sweden --count 2
mullgate proxy relay recommend --country Sweden --count 1
mullgate proxy relay recommend --country Sweden --count 1 --apply
mullgate proxy relay verify --route sweden-gothenburg
```

## Autostart On Linux

Goal: restore the proxy runtime after login or reboot.

Typical flow:

```bash
mullgate proxy autostart enable
mullgate proxy autostart status
```

If startup still fails after reboot:

```bash
mullgate proxy status
mullgate proxy doctor
```

## Safe Recovery Loop

After exposure or access changes:

```bash
mullgate proxy validate --refresh
# or
mullgate proxy start
```

Then verify:

```bash
mullgate proxy status
mullgate proxy doctor
```
