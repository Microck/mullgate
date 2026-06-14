# Deep Research: One tailscaled = N concurrent Mullvad exits

**Date:** 2026-06-14
**Researcher:** deep-researcher agent
**Methodology:** Kagi Search + Kagi Extract + hands-on empirical tests from a Mullvad-connected sandbox + Mullvad API probing + public DNS verification

---

## 1. Executive Verdict

**CONDITIONAL NO** - with one important asterisk and one critical untested hypothesis.

There is **no documented or community-proven path** to achieve "one `tailscaled` instance = N concurrent Mullvad exits" using the Tailscale Mullvad add-on. Every application-layer trick (SOCKS5 chaining through 10.64.0.1, auth-based exit selection, per-connection exit routing) is explicitly blocked by either Mullvad's SOCKS5 ruleset or Tailscale's `autogroup:internet` RFC1918 filter. The Mullvad add-on exposes a **network-layer exit-node abstraction** (one WireGuard tunnel per pinned exit), not the application-layer SOCKS5 fan-out that mullgate's current mode depends on.

**The asterisk**: The prior research's specific failure claim ("per-exit SOCKS5 hostnames are NXDOMAIN via 10.64.0.1 DNS") was **wrong** - it was caused by testing the wrong hostname (missing the `.relays.` subdomain). The correct hostnames resolve fine via both public DNS and Mullvad internal DNS.

**The critical untested hypothesis**: The user never tested whether `10.124.0.x` IPs are reachable **directly** (not via DNS hostname, but via raw IP like `curl --socks5-hostname 10.124.0.20:1080`) through the Tailscale-pinned exit. The `autogroup:internet` filter strongly suggests this is blocked, but Mullvad may advertise more routes than the filter implies (they already advertise `10.64.0.1/32` despite the filter). **This is the single most important test the user can run.** If it works, the problem is solvable with minimal mullgate changes.

If the direct-IP test fails (expected), the only viable path remains **N `tailscaled` instances, each pinned to a different Mullvad exit** (as the existing `TAILSCALE.md` proposal describes). This is confirmed by an independent suggestion in [tailscale/tailscale#11554](https://github.com/tailscale/tailscale/issues/11554): "actually, it might be possible to start a new tailscale daemon in userspace networking mode, enable the Mullvad exit node you want, and then use that as a SOCKS proxy instead of the mullvad IP."

---

## 2. The Linchpin: The 10.124.0.x Mapping and Reachability

This deserves special focus because it is the crux of the entire investigation, and the prior research contained a factual error here.

### 2.1 The prior NXDOMAIN test was using the wrong hostname

The user's test:
```
nslookup se-got-wg-socks5-001.mullvad.net 10.64.0.1  -> NXDOMAIN
```

The **correct** hostname (per Mullvad's public API and help docs) includes the `.relays.` subdomain:
```
se-got-wg-socks5-001.relays.mullvad.net
```

**Empirical verification (this research, 2026-06-14):**

| Query | Resolver | Result |
|---|---|---|
| `se-got-wg-socks5-001.mullvad.net` (user's form) | 1.1.1.1 public | **empty (NXDOMAIN)** - confirms user's failure |
| `se-got-wg-socks5-001.relays.mullvad.net` (correct) | 1.1.1.1 public | **10.124.0.20** |
| `se-got-wg-socks5-001.relays.mullvad.net` (correct) | 10.64.0.1 Mullvad internal | **10.124.0.20** |
| `al-tia-wg-socks5-001.relays.mullvad.net` | 1.1.1.1 and 8.8.8.8 | **10.124.1.240** (DNSSEC-signed) |

The hostnames resolve identically via public DNS (Cloudflare, Google) and Mullvad's internal DNS (10.64.0.1). The records are DNSSEC-signed (RRSIG A present). **mullgate does not need to be on the tunnel to build the hostname -> 10.124.0.x mapping table.**

### 2.2 The 10.124.0.x mapping is publicly documented and systematically obtainable

**Mullvad's official help page** ([mullvad.net/en/help/socks5-proxy](https://mullvad.net/en/help/socks5-proxy)) explicitly documents the layout:

> "The SOCKS5 proxy on 10.124.0.x to 10.124.1.x with port 1080 which **is reachable from other WireGuard servers**. These IPs are unique for each WireGuard server. For instance, 10.124.0.4 belongs to **nl-ams-wg-001** and 10.124.0.2 belongs to **se-mma-wg-001**."

Key facts confirmed:
- Range: `10.124.0.0/22` (10.124.0.0 - 10.124.1.255)
- Port: 1080 on all per-exit SOCKS5
- These ARE reachable from other WireGuard servers (the multihop mechanism)
- The IPs are NOT sequential by location (verified: 10.124.0.3 = au-adl, 10.124.0.7 = de-ber, 10.124.0.20 = se-got, 10.124.1.240 = al-tia)

**The mapping is built by querying public DNS for each relay's `socks_name`.** Multiple GitHub projects already do this:
- [maximko/mullvad-socks-list](https://github.com/maximko/mullvad-socks-list) - resolves via pydig
- [derlocke-ng/mullvad-socks5](https://github.com/derlocke-ng/mullvad-socks5) - resolves via 10.64.0.1 from inside tunnel
- [AxelCipher20/mullvad-proxies](https://github.com/AxelCipher20/mullvad-proxies) - extracts from API
- [netqo/mullvad-socks5-probe](https://github.com/netqo/mullvad-socks5-probe) - concurrent health probe

### 2.3 Does the Mullvad public API expose the internal IP?

**No.** Verified by probing `https://api.mullvad.net/www/relays/wireguard/` (554 relays):

```
ALL API FIELDS:
active, city_code, city_name, country_code, country_name, daita, fqdn,
hostname, ipv4_addr_in, ipv6_addr_in, multihop_port, network_port_speed,
owned, provider, pubkey, socks_name, socks_port, status_messages, stboot, type
```

- `socks_name`: the per-exit SOCKS5 hostname (e.g. `al-tia-wg-socks5-001.relays.mullvad.net`) - **present, this is what mullgate uses today**
- `socks_port`: 1080 - **present**
- `ipv4_addr_in`: the **PUBLIC** WireGuard endpoint IP (e.g. `103.124.165.2`), NOT the internal 10.124.x
- No field contains `10.124.x` or any internal address

**Conclusion**: The API gives you the `socks_name` directly. mullgate then resolves `socks_name` via **public DNS** (1.1.1.1) to get the 10.124.0.x IP. No tunnel access required for mapping. This is a one-line DNS query per relay.

### 2.4 THE critical untested question: is 10.124.0.x reachable via Tailscale-pinned exit?

This is where the research cannot give a 100% certain answer without hands-on testing on a real tailnet with the add-on. Here is the full reasoning:

**Evidence that it should be BLOCKED:**

Tailscale's `autogroup:internet` (the ACL group that defines what traffic an exit node carries) is defined as (from [tailscale/tailscale#5412](https://github.com/tailscale/tailscale/issues/5412)):

```
add 0.0.0.0/0
add 2000::/3

remove 10.0.0.0/8
remove 172.16.0.0/12
remove 192.168.0.0/16
remove fc00::/7
remove 100.64.0.0/10
remove fd7a:115c:a1e0::/48
remove 169.254.0.0/16
remove fe80::/10
```

The `remove 10.0.0.0/8` line means all RFC1918 10.x addresses are **excluded** from exit-node routing by default. Since `10.124.0.0/22` is inside `10.0.0.0/8`, it would NOT be routed through the exit node.

This is reinforced by [tailscale/tailscale#11554](https://github.com/tailscale/tailscale/issues/11554) (the exact problem): the reporter explicitly wants Mullvad exit nodes to advertise `10.124.0.0/22` so it becomes reachable - confirming it is NOT reachable by default. The issue is open and unresolved.

**Evidence that it MIGHT work anyway:**

The user's own test proved `10.64.0.1` (which is ALSO in `10.0.0.0/8`) IS reachable via a Tailscale-pinned Mullvad exit. This means Mullvad exit nodes inject a more-specific route for at least `10.64.0.1/32` that overrides the `remove 10.0.0.0/8` filter. The most likely explanation is that Tailscale installs this route so the Mullvad DNS resolver (10.64.0.1:53) is reachable for DNS resolution through the exit.

The open question: **does Mullvad/Tailscale inject routes for the entire `10.124.0.0/22` range as well, or only for `10.64.0.1/32`?** Issue #11554 implies only `10.64.0.1/32`, but the user has not empirically tested `10.124.0.x` reachability directly.

**The test the user must run** (see Section 5 for full commands):
```bash
# With a Mullvad exit node pinned via Tailscale:
curl -v --connect-timeout 10 --socks5-hostname 10.124.0.20:1080 https://am.i.mullvad.net/json
# Expected if blocked: connection timeout / no route
# Expected if reachable: JSON with se-got-wg-socks5-001 exit IP
```

**Confidence**: Medium-high that it is BLOCKED, but the cost of testing is ~10 seconds and the payoff is enormous. DO NOT skip this test.

---

## 3. Per-Angle Findings

### Angle 1: The 10.124.0.x range (direct IP reachability)

- **Direct answer**: Reachable by IP from inside a real Mullvad WireGuard tunnel (empirically confirmed from this sandbox). NOT reachable via Tailscale-pinned exit by default (autogroup:internet filter), UNTESTED directly by the user.
- **Documentation**: Mullvad help page explicitly documents 10.124.0.0/22 as the per-exit SOCKS5 range. The layout is NOT published as a table - it must be discovered via DNS resolution.
- **Hardcoded IP table**: Fully feasible. mullgate can fetch `api.mullvad.net/www/relays/wireguard/`, extract `socks_name`, resolve via public DNS (1.1.1.1), cache hostname -> 10.124.0.x. This is a one-time-per-refresh operation.
- **Confidence**: High on the mapping mechanism. Medium-high on Tailscale blocking direct reachability.

Sources: [Mullvad SOCKS5 help](https://mullvad.net/en/help/socks5-proxy), [tailscale#11554](https://github.com/tailscale/tailscale/issues/11554), [tailscale#5412](https://github.com/tailscale/tailscale/issues/5412)

### Angle 2: Mullvad WireGuard-only SOCKS5 ports and exit selection

- **Ports exposed**: Only **1080** (SOCKS5) and **53** (DNS) are open on `10.64.0.1`. Verified by port scan from this sandbox: ports 80, 443, 1081, 1082, 8080, 8443, 40000, 41080 all closed/filtered.
- **Exit selection by port**: No. Only 1080 is exposed.
- **Exit selection by username**: **No.** Empirically tested: the 10.64.0.1 SOCKS5 proxy returns `0xff` ("no acceptable methods accepted") when username/password auth (method 0x02) is offered. It only accepts no-auth (method 0x00).
- **Exit selection by SNI / destination hint**: No documented mechanism. Mullvad's SOCKS5 is a plain forwarder with a ruleset that blocks RFC1918 destinations (see Angle 5).
- **Confidence**: High (empirically tested).

### Angle 3: Mullvad API as a mapping source

- **socks_name / socks_port fields**: **Present and populated** for all 554 relays. mullgate already uses these.
- **Internal IP field**: **Not present.** The API returns `ipv4_addr_in` (the PUBLIC WireGuard endpoint), not the internal 10.124.x address.
- **Constructing the mapping without DNS**: Not possible from the API alone. You must resolve `socks_name` via DNS (public or internal) to get the 10.124.x IP. This is a trivial operation.
- **Confidence**: High (API schema fully verified).

### Angle 4: Tailscale-specific tricks

- **App routing / app connectors**: App connectors route **domain-specific traffic to a tailnet peer**, not to a specific Mullvad exit. The peer would still need to select a Mullvad exit. Does not solve the problem. ([Tailscale app connectors](https://tailscale.com/blog/app-connectors-explained))
- **Subnet routers advertising 10.124.0.0/22**: A subnet router advertises routes it can reach. Your node cannot reach 10.124.0.x (it's inside Mullvad's network, not yours). Even if you advertised it, you'd have no way to deliver the traffic. Does not work.
- **4via6 / snusiu**: 4via6 maps IPv4 subnets into IPv6 for tailnet routing. It does not change exit-node selection or bypass the autogroup:internet filter. Not applicable.
- **Multiple exit-node priority / failover**: Tailscale supports [suggested exit nodes](https://tailscale.com/docs/features/exit-nodes/auto-exit-nodes) and [mandatory exit nodes](https://tailscale.com/docs/features/exit-nodes/mandatory-exit-nodes), but these select ONE exit at a time. No per-traffic-class exit selection exists. ([tailscale#3648](https://github.com/tailscale/tailscale/issues/3648) is an open FR for policy routing through multiple exit nodes.)
- **Tailscale serve / funnel**: These expose local services to the tailnet/internet. They do not change exit-node selection. Not applicable.
- **Confidence**: High.

### Angle 4b: What does `--exit-node-allow-lan-access` do?

- **Direct answer**: It preserves the **client's local LAN routes** when using an exit node. It does NOT change the exit-node-side RFC1918 filtering.
- From [Tailscale exit nodes docs](https://tailscale.com/kb/1103/exit-nodes): "By default, the device connecting to an exit node won't have access to its local network. If you want to allow the device access to its local network when routing traffic through an exit node, enable exit node local network access."
- It does NOT expose 10.124.0.x. The autogroup:internet `remove 10.0.0.0/8` is independent of this flag.
- **Confidence**: High.

### Angle 4c: Mullvad add-on node properties

- Mullvad exits appear as peers with hostnames like `fr-par-wg-001.mullvad.ts.net` (confirmed in Tailscale docs and the tailnet-lock signing instructions).
- **Advertised routes**: Per issue #11554, they advertise `0.0.0.0/0` (exit node) and `10.64.0.1/32` (so the SOCKS5/DNS proxy is reachable). They do NOT advertise `10.124.0.0/22`.
- **Tags/capabilities**: They carry the `mullvad` node attribute. No special per-exit capabilities.
- **Direct WireGuard peer connections outside the exit-node abstraction**: Not possible. The Mullvad peers use Tailscale-managed WireGuard keys. You cannot extract them for direct use.
- **Confidence**: High on routes (issue #11554 + user's 10.64.0.1 success). Medium on the exact route set (no `tailscale status` output available from a real add-on tailnet in this research).

### Angle 5: Multi-connection SOCKS5 over a single tunnel

- **N concurrent connections to 10.64.0.1 with different usernames**: **Blocked.** The SOCKS5 proxy does not accept username/password auth (returns `0xff`). Verified empirically.
- **Authentication-based routing**: Not supported.
- **HTTP CONNECT vs SOCKS5**: Only SOCKS5 is exposed on 10.64.0.1:1080. No HTTP proxy port. The SOCKS5 proxy **explicitly refuses RFC1918 destinations** (SOCKS5 reply code=2 "connection not allowed by ruleset"). Verified empirically:
  - Connect to `10.124.0.20:1080` via 10.64.0.1 -> code=2 (BLOCKED)
  - Connect to `10.64.0.1:80` via 10.64.0.1 -> code=2 (BLOCKED)
  - Connect to `se-got-wg-socks5-001.relays.mullvad.net:1080` via 10.64.0.1 -> code=2 (BLOCKED even by hostname)
  - Connect to `1.1.1.1:80` via 10.64.0.1 -> code=0 (OK)
- **Conclusion**: Mullvad's 10.64.0.1 SOCKS5 is a forward-only proxy to the PUBLIC internet. It deliberately cannot reach Mullvad's internal infrastructure. Chaining is dead.
- **Confidence**: High (empirically tested).

### Angle 6: Bridge Mode / Multihop

- Mullvad's multihop (entry via server A, exit via server B) works by connecting to server A's WireGuard, then using server B's per-exit SOCKS5 (10.124.0.x). This is documented at [mullvad.net/help/different-entryexit-node-using-wireguard-and-socks5-proxy](https://mullvad.net/en/help/different-entryexit-node-using-wireguard-and-socks5-proxy).
- **Does the Tailscale add-on expose bridge mode?** No. The add-on exposes flat exit nodes, one WireGuard tunnel per pinned exit. There is no bridge/multihop configuration surface.
- **Could you enter via Tailscale->Mullvad-exit-A and bridge to exit-B?** Only if you could reach exit-B's 10.124.0.x from exit-A's tunnel. From inside a real Mullvad tunnel, YES (that's how multihop works). From the Tailscale-pinned path, NO (10.124.0.x is filtered, see Angle 1). This is the same blocker.
- **Confidence**: High.

### Angle 7: Tailscale as transport only (tailbox approach)

- [tailbox-server](https://github.com/tdwgm/tailbox-server) / [tailbox-client](https://github.com/tdwgm/tailbox-client) runs a **self-hosted** Mullvad WireGuard tunnel (via YOUR direct Mullvad subscription) inside a container, exposed as a Tailscale peer. The client uses `socat EXEC:tailscale nc <peer> 1080` for rootless, per-connection forwarding.
- **This does NOT use the Tailscale Mullvad add-on.** It uses a separate direct Mullvad subscription.
- **Can it be combined with the add-on to reduce cost?** No. The add-on and direct Mullvad are separate auth paths. The add-on does not give you Mullvad WireGuard credentials; Tailscale manages them on your behalf.
- **However**: tailbox's architecture is actually a strong alternative to the add-on for mullgate's use case. If the user has (or gets) a direct Mullvad subscription (€5/month, same as the add-on's $5/month for 5 devices), mullgate's current mode already delivers N exits from one tunnel. The add-on offers no multi-exit advantage.
- **Note on `tailscale nc`**: It connects to a **tailnet peer**, not through an exit node. It cannot do per-connection exit selection. The tailbox design works because the SERVER side runs its own Mullvad tunnel and SOCKS5; `tailscale nc` just reaches that server.
- **Confidence**: High.

### Angle 8: The 25-exit container cap

- **Base add-on**: 5 licenses, each allowing 5 devices = **25 devices** that can use Mullvad exits. ([Tailscale Mullvad docs](https://tailscale.com/docs/features/exit-nodes/mullvad-exit-nodes))
- **Is it hard?** It is the **base** cap. You can purchase additional licenses: "you can purchase additional licenses during the initial checkout flow or afterward through the Billing page." There is no documented absolute ceiling.
- **Pricing**: $5/month per 5 devices (i.e., $1/device/month). Source: [Tailscale pricing](https://tailscale.com/pricing), [Reddit confirmation](https://www.reddit.com/r/mullvadvpn/comments/1bgmtri/tailscale_mullvad_march_2024/).
- **Ephemeral nodes**: Tailscale supports ephemeral nodes, BUT "Tailscale allocates Mullvad licenses to devices **as they connect to the tailnet**, not as they connect to Mullvad servers." So ephemeral nodes consume a license slot while connected. You cannot rotate through more concurrent exits than your license count allows. (Confirmed in Tailscale docs.)
- **License pool sharing**: The tailnet policy file can assign `mullvad` attribute to more devices than licenses allow, with first-come-first-served allocation. This does not increase the concurrent cap.
- **Higher tier**: Just buy more licenses. Linear cost scaling.
- **Cost comparison for N concurrent exits**:
  - Add-on (N tailscaled): **$N/month** (e.g., 10 exits = $10/month, 25 exits = $25/month)
  - Direct Mullvad (mullgate current): **€5/month flat (~$5.45)** for unlimited exits from one tunnel
- **Confidence**: High.

### Angle 9: Direct Mullvad alongside the add-on

- A direct Mullvad subscription allows up to 5 WireGuard devices. mullgate uses ONE device for N exits (the entire value proposition).
- **Can the operator run mullgate normally (direct) AND use the add-on?** Yes, but they are paying for both (~$10.45/month total). The add-on provides Tailscale integration (remote access); direct Mullvad provides multi-exit.
- **Does the add-on give direct Mullvad credentials?** No. Tailscale manages the Mullvad account. There is an open FR ([tailscale#9301](https://github.com/tailscale/tailscale/issues/9301), PR [#18350](https://github.com/tailscale/tailscale/pull/18350)) to allow using an existing Mullvad account with the add-on, but it is not merged.
- **Complementary use**: The add-on could serve as the "remote access" layer (Tailscale mesh) while direct Mullvad serves as the "multi-exit" layer (mullgate's current mode). This is actually the cleanest architecture if cost is acceptable.
- **Confidence**: High.

### Angle 10: Community workarounds

- **Exhaustive search** of Tailscale forum, Reddit (r/Tailscale, r/mullvadvpn), GitHub issues, HackerNews, Mullvad forum, blog posts: **No community workaround exists** for "one tailscaled = N concurrent Mullvad exits."
- Every discussion that touches this either:
  1. Accepts one-exit-per-tailscaled (the de facto answer), or
  2. Uses a self-hosted exit node with direct Mullvad (tailbox pattern), or
  3. Files a feature request against Tailscale (issues #11554, #3648, #5412, #14507).
- The closest creative suggestion found is in [tailscale#11554](https://github.com/tailscale/tailscale/issues/11554): "start a new tailscale daemon in userspace networking mode, enable the Mullvad exit node you want, and then use that as a SOCKS proxy" - which is exactly the N-containers approach.
- **Confidence**: High (negative result after thorough search).

### Angle 11: Mullvad API endpoint for internal IP layout

- **No such endpoint exists.** The public API (`api.mullvad.net/www/relays/wireguard/` and `api.mullvad.net/public/relays/wireguard/v2`) does not expose internal IPs.
- **No GitHub project has reverse-engineered a static table.** The IPs are not stable enough to hardcode without refresh (relays are added/removed). All projects resolve via DNS.
- **DNS IS the mapping source.** Public DNS (1.1.1.1, 8.8.8.8) returns the 10.124.0.x addresses for `*.relays.mullvad.net` names. This is the canonical, supported way to discover the mapping.
- **Confidence**: High.

### Angle 12: Wildcard / creative ideas

- **Capture WireGuard handshake / extract routing table**: Not feasible. The Mullvad exit's internal routing is not exposed to the Tailscale client. You see only the encrypted tunnel.
- **DNS-over-HTTPS to Mullvad-internal resolver**: 10.64.0.1 speaks plain DNS on port 53, not DoH. There is no documented DoH endpoint on the internal network. And even if DNS resolves, reachability is still blocked by the autogroup:internet filter.
- **Mullvad control-plane HTTP API on 10.64.x beyond SOCKS5**: Port scan of 10.64.0.1 found only ports 53 (DNS) and 1080 (SOCKS5) open. No HTTP control plane.
- **`tailscale debug` to inspect Mullvad peer advertisements**: `tailscale debug netmap` (or `tailscale debug watched-network-map`) would show the advertised routes of Mullvad peers. This is a worthwhile diagnostic the user can run to confirm whether `10.124.0.0/22` is advertised (expected: no). See Section 5 for the command.
- **Userspace tailscaled per exit**: This is the N-containers approach, and it is viable. Tailscale supports `TS_USERSPACE=1` for rootless, userspace-networking daemons. Multiple can run side-by-side with separate state dirs and socket paths. This is lighter than full containers but still N processes.
- **Tailscale exit-node "understood" as a SOCKS5 source**: `tailscale serve` can expose a local SOCKS5, but it does not change which Mullvad exit is used. Not applicable.
- **Confidence**: High (each idea evaluated against evidence).

---

## 4. Ranked List of Concrete Paths

Ranked from most to least promising for achieving "N concurrent Mullvad exits via the Tailscale add-on."

### Path 1 (IF IT WORKS): Direct 10.124.0.x via Tailscale exit - TEST FIRST

- **Mechanism**: Resolve `socks_name` via public DNS to get 10.124.0.x, then connect directly to `10.124.0.x:1080` through the single Tailscale-pinned Mullvad exit. Identical to mullgate's current mode, just with the Tailscale exit replacing the direct WireGuard tunnel.
- **Required mullgate changes**: **Tiny.** Add a DNS-resolution step (public DNS) to map `socks_name` -> 10.124.0.x. Everything else (3proxy chaining, host listeners, routing) is reused unchanged. The Tailscale exit is configured outside mullgate (operator pins it once).
- **Probability of working**: **Low-Medium.** The autogroup:internet filter and issue #11554 strongly suggest 10.124.0.x is blocked. But the user's 10.64.0.1 success proves Mullvad injects SOME routes that override the filter, so it is not impossible.
- **Risks**: None to test. If it works, this is the ideal solution.
- **Test command**: See Section 5, Test #1.

### Path 2: N tailscaled instances (the TAILSCALE.md proposal)

- **Mechanism**: One `tailscaled` container per route, each pinned to a different Mullvad exit node. mullgate's host-side listener layer forwards per-route traffic to the matching container. This is the existing proposal in `TAILSCALE.md`.
- **Required mullgate changes**: **Large.** New exit-source mode, new docker-compose renderer for per-exit `tailscaled` topology, tailscale auth-key handling, new doctor checks. Scope is comparable to the m004 milestone (per the proposal doc).
- **Probability of working**: **High.** This is the canonical, proven architecture. An independent commenter in tailscale#11554 arrived at the same idea.
- **Risks**: Resource cost (N `tailscaled` processes/containers), license cost ($1/device/month), DERP fallback latency, container privilege (`NET_ADMIN`), cleanup safety.
- **Test command**: See Section 5, Test #2 (feasibility proof before full integration).

### Path 3: Direct Mullvad subscription + Tailscale for remote access (hybrid)

- **Mechanism**: Run mullgate's current mode unchanged (direct Mullvad WireGuard, one device, N SOCKS5 exits). Use Tailscale separately for remote access to the mullgate host. The add-on is not used for multi-exit; it is optional.
- **Required mullgate changes**: **Zero.** mullgate works as-is.
- **Probability of working**: **Certain.** This is mullgate's shipping architecture.
- **Cost**: Direct Mullvad (€5/month) + optionally Tailscale add-on ($5/month) if remote access via Mullvad exits is desired.
- **Risks**: Operator pays for two services. Defeats the "use only the add-on" goal.
- **When to choose**: If Path 1 fails and Path 2's cost/complexity is not justified.

### Path 4: N userspace tailscaled (lighter variant of Path 2)

- **Mechanism**: Instead of N full Docker containers, run N `tailscaled` daemons in userspace-networking mode (`TS_USERSPACE=1`), each with a separate state directory and socket path, each pinned to a different Mullvad exit. Use `tailscale nc` or a local forwarder to expose each as a SOCKS5 listener.
- **Required mullgate changes**: **Medium.** Process supervision for N userspace daemons (lighter than container orchestration). The tailbox-client `socat EXEC:tailscale nc` pattern is reusable.
- **Probability of working**: **High.** Userspace mode is supported and is how tailbox-client runs rootless.
- **Risks**: Less isolation than containers; manual state-dir/socket management; per-process WireGuard via userspace netstack has some overhead.
- **Test command**: See Section 5, Test #3.

### Path 5: App connector per domain -> self-hosted Mullvad exit node (tailbox pattern)

- **Mechanism**: Run one or more self-hosted exit nodes (tailbox-server) behind direct Mullvad, each pinned to a different Mullvad location. Use Tailscale app connectors to route specific domains through specific exit nodes. mullgate's hostname routing maps to app-connector domains.
- **Required mullgate changes**: **Large and indirect.** This is really the direct-Mullvad architecture (Path 3) with a Tailscale-routing frontend. mullgate would need to drive app-connector configuration.
- **Probability of working**: **Medium.** App connectors are domain-based, not connection-based; mullgate's per-route model may not map cleanly. Also still requires direct Mullvad.
- **Risks**: Complexity, app-connector limitations, still needs direct Mullvad.
- **When to choose**: Probably never for this use case; Path 3 is simpler.

---

## 5. Open Questions Requiring Hands-On Testing

These cannot be resolved by research alone. The user has a real tailnet with the add-on and can answer each in seconds.

### Test #1 (CRITICAL): Is 10.124.0.x directly reachable via Tailscale-pinned exit?

With a Mullvad exit node pinned via Tailscale:
```bash
# 1a. Resolve the mapping (should work - public DNS)
dig +short se-got-wg-socks5-001.relays.mullvad.net @1.1.1.1
# Expected: 10.124.0.20

# 1b. The actual reachability test
curl -v --connect-timeout 10 --socks5-hostname 10.124.0.20:1080 https://am.i.mullvad.net/json
# If this returns JSON with se-got-wg-socks5-001 -> PATH 1 WORKS, problem solved
# If this times out / connection refused -> 10.124.0.x is filtered (expected), move to Path 2

# 1c. Try a few different exits to be sure
for ip in 10.124.0.116 10.124.0.53 10.124.1.240; do
  echo "--- $ip ---"
  curl -s --connect-timeout 8 --socks5-hostname $ip:1080 https://am.i.mullvad.net/json | python3 -m json.tool 2>/dev/null | head -5
done
# 10.124.0.116 = fr-par-wg-socks5-001
# 10.124.0.53  = de-fra-wg-socks5-001
# 10.124.1.240 = al-tia-wg-socks5-001
```

### Test #2: Inspect what routes the Mullvad exit peer actually advertises

```bash
# See the full netmap including Mullvad peers and their advertised routes
tailscale debug netmap 2>/dev/null | grep -A5 "mullvad.ts.net" | head -40
# OR
tailscale status --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
for k, p in d.get('Peer', {}).items():
    if 'mullvad' in p.get('DNSName', '').lower():
        print(f\"{p['DNSName']}: exit={p.get('ExitNodeOption')} primary_routes={p.get('PrimaryRoutes')} allowed={p.get('AllowedIPs')}\")
"
# Look specifically for 10.124.0.0/22 or 10.64.0.1/32 in advertised routes
```

### Test #3: Confirm 10.64.0.1 reachability and check if the route was injected for DNS

```bash
# Confirm 10.64.0.1 works (user already did this, reconfirm)
curl -s --socks5-hostname 10.64.0.1:1080 https://am.i.mullvad.net/json | python3 -m json.tool

# Check the routing table for 10.x routes while exit is pinned
ip route get 10.64.0.1
ip route get 10.124.0.20
# If 10.64.0.1 routes via tailscale0 but 10.124.0.20 routes via enp0s6/eth0 -> confirms the filter
# If BOTH route via tailscale0 -> PATH 1 likely works, retry Test #1
```

### Test #4: Feasibility of N userspace tailscaled (Path 4 proof)

```bash
# Start two userspace tailscaled instances, each pinned to a different exit
mkdir -p /tmp/ts1 /tmp/ts2
TS_USERSPACE=1 tailscaled --tun=userspace-networking --socket=/tmp/ts1/tailscaled.sock --state=/tmp/ts1/state --statedir=/tmp/ts1 &
sleep 2
tailscale --socket=/tmp/ts1/tailscaled.sock up --authkey=<ephemeral-key> --exit-node=fr-par-wg-001.mullvad.ts.net

# Repeat for second instance with a different exit
TS_USERSPACE=1 tailscaled --tun=userspace-networking --socket=/tmp/ts2/tailscaled.sock --state=/tmp/ts2/state --statedir=/tmp/ts2 &
sleep 2
tailscale --socket=/tmp/ts2/tailscaled.sock up --authkey=<ephemeral-key> --exit-node=se-got-wg-001.mullvad.ts.net

# Verify distinct exits
tailscale --socket=/tmp/ts1/tailscaled.sock nc 10.64.0.1 1080  # then SOCKS5 to am.i.mullvad.net -> should show Paris
tailscale --socket=/tmp/ts2/tailscaled.sock nc 10.64.0.1 1080  # -> should show Gothenburg
```

---

## 6. Summary of What Changed vs Prior Research

| Prior claim | Status | Correction |
|---|---|---|
| "10.64.0.1 IS reachable through Tailscale-pinned exit" | **CONFIRMED** | Correct. |
| "Per-exit SOCKS5 hostnames are NXDOMAIN via 10.64.0.1 DNS" | **WRONG** | The user tested `se-got-wg-socks5-001.mullvad.net` (missing `.relys.`). The correct `se-got-wg-socks5-001.relays.mullvad.net` resolves to `10.124.0.20` via both 10.64.0.1 and public DNS. |
| "Tailscale's exit-node abstraction does not expose Mullvad's per-exit SOCKS5 layer" | **LIKELY CORRECT but untested at IP layer** | The autogroup:internet filter removes 10.0.0.0/8. But the user never tested direct IP reachability (`curl --socks5-hostname 10.124.0.x:1080`). Must verify before concluding. |
| "RFC1918 is blocked by Tailscale exit" | **PARTIALLY WRONG** | 10.64.0.1 (RFC1918) IS reachable. The filter has exceptions for Mullvad-advertised routes. The question is whether 10.124.0.0/22 is among them. |

---

## 7. Sources

### Primary (official docs)
- Mullvad SOCKS5 proxy help: https://mullvad.net/en/help/socks5-proxy
- Mullvad multihop with SOCKS5: https://mullvad.net/en/help/different-entryexit-node-using-wireguard-and-socks5-proxy
- Tailscale Mullvad exit nodes: https://tailscale.com/docs/features/exit-nodes/mullvad-exit-nodes
- Tailscale exit nodes (route all traffic): https://tailscale.com/kb/1103/exit-nodes
- Tailscale app connectors: https://tailscale.com/blog/app-connectors-explained
- Tailscale ephemeral nodes: https://tailscale.com/docs/features/ephemeral-nodes
- Tailscale CLI reference: https://tailscale.com/docs/reference/tailscale-cli
- Mullvad public relays API: https://api.mullvad.net/www/relays/wireguard/

### GitHub issues (the smoking guns)
- tailscale/tailscale#11554 - FR: Mullvad exit-node does not advertise 10.124.0.0/22: https://github.com/tailscale/tailscale/issues/11554
- tailscale/tailscale#5412 - FR: Allow clients to access RFC1918 via exit nodes (autogroup:internet definition): https://github.com/tailscale/tailscale/issues/5412
- tailscale/tailscale#14507 - FR: LAN filtering in default route should be optional: https://github.com/tailscale/tailscale/issues/14507
- tailscale/tailscale#3648 - FR: policy routing through multiple exit nodes: https://github.com/tailscale/tailscale/issues/3648
- tailscale/tailscale#8178 - Exit Nodes don't route all traffic (Tailscale team response on intent): https://github.com/tailscale/tailscale/issues/8178
- tailscale/tailscale#9301 - FR: Ability to use existing Mullvad account (PR #18350): https://github.com/tailscale/tailscale/issues/9301

### Community / implementations
- maximko/mullvad-socks-list (resolves socks_name to internal IPs): https://github.com/maximko/mullvad-socks-list
- derlocke-ng/mullvad-socks5 (automated scanner, resolves via 10.64.0.1): https://github.com/derlocke-ng/mullvad-socks5
- AxelCipher20/mullvad-proxies (extracts socks_name/socks_port from API): https://github.com/AxelCipher20/mullvad-proxies
- netqo/mullvad-socks5-probe (concurrent SOCKS5 health probe): https://github.com/netqo/mullvad-socks5-probe
- tdwgm/tailbox-client (rootless Tailscale + Mullvad via socat + tailscale nc): https://github.com/tdwgm/tailbox-client
- tdwgm/tailbox-server (self-hosted Mullvad exit behind Tailscale): https://github.com/tdwgm/tailbox-server
- k4yt3x blog (per-request random Mullvad SOCKS5 via PAC): https://k4yt3x.com/using-a-random-mullvad-socks5-proxy-for-each-browser-request/
- ItalyPaleAle/tailsocks (SOCKS5 via Tailscale exit node): https://github.com/ItalyPaleAle/tailsocks

### Analysis / deep dives
- Stone Charioteer - Tailscale exit node internals: https://tech.stonecharioteer.com/posts/2026/tailscale-exit-nodes/
- TheOrangeOne - Tailscale + Mullvad: https://theorangeone.net/posts/tailscale-mullvad/
- HackerNews - Mullvad exposes socks proxies over WireGuard: https://news.ycombinator.com/item?id=30816995

### Empirical tests (this research)
- Mullvad public API schema probe (554 relays, all fields)
- Public DNS resolution of `*.relays.mullvad.net` (Cloudflare + Google)
- Mullvad internal DNS (10.64.0.1) resolution
- Direct SOCKS5 connection to 10.124.0.20 from Mullvad-connected host
- SOCKS5 chaining attempt through 10.64.0.1 to 10.124.0.20 (blocked, code=2)
- SOCKS5 auth-method negotiation on 10.64.0.1 (no auth accepted, 0xff)
- Port scan of 10.64.0.1 (only 53 and 1080 open)
