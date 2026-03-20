# Deep Research: Mullvad VPN as Standalone Proxy

## Topic
Using Mullvad VPN subscription as a standalone SOCKS5/HTTP proxy with country selection for specific workflows (browser proxying, etc.)

## Research Queue

| # | Point | Status | Confidence |
|---|-------|--------|------------|
| 1 | Mullvad native SOCKS5 proxy offerings | COMPLETE | HIGH |
| 2 | WireGuard config extraction for proxy use | COMPLETE | HIGH |
| 3 | Shadowsocks/SOCKS5 implementations | COMPLETE | HIGH |
| 4 | Community solutions (Reddit/GitHub) | COMPLETE | HIGH |
| 5 | Country/location selection mechanisms | COMPLETE | HIGH |
| 6 | Browser-specific implementation | COMPLETE | HIGH |
| 7 | Known limitations and issues | COMPLETE | HIGH |
| 8 | Standalone solution (no VPN app) | COMPLETE | HIGH |
| 9 | Tailscale compatibility | COMPLETE | HIGH |

## Started
2026-03-19

## Completed
2026-03-19

## Key Finding
**wireproxy** is the ideal solution - a userspace WireGuard client that exposes SOCKS5 proxy without affecting network routing. Fully compatible with Tailscale.