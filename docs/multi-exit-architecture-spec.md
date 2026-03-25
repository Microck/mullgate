# Shared-Entry Multi-Exit Architecture

## Status

Implemented in the current Linux runtime.

This file started as the proposal for Mullgate's multi-exit redesign. It now documents the shipped architecture and the live proof that closed the original Mullvad device-slot concern.

## Summary

Mullgate no longer provisions one Mullvad WireGuard device per route.

The current runtime provisions:

- one shared Mullvad WireGuard entry device
- one shared entry tunnel that reaches Mullvad from inside the runtime
- one logical Mullvad SOCKS5 exit selection per configured route
- one authenticated local SOCKS5 listener per route
- one authenticated local HTTP listener per route
- one authenticated local HTTPS listener per route when TLS assets are configured

Route selection still happens by destination bind IP, so hostname-selected routing stays truthful across SOCKS5, HTTP, and HTTPS as long as each hostname resolves to the bind IP assigned to that route.

## Why this matters

The original route-per-key model hit a hard Mullvad limit quickly:

- 1 location = 1 Mullvad WireGuard device
- 2 locations = 2 Mullvad WireGuard devices
- 10 locations = 10 Mullvad WireGuard devices

That model could not support many simultaneous country-specific exits on one Mullvad account.

The shipped shared-entry model fixes that by consuming one Mullvad device slot total for the runtime entry path, then fanning traffic out to exact Mullvad SOCKS5 exits per route from inside that tunnel.

This does not bypass Mullvad limits through unsupported tricks. Mullgate still provisions one real Mullvad device. The savings come from the topology, not from faking keys.

## What shipped

The current Linux-first runtime is built around these pieces:

- canonical routed config in `routing.locations[]`
- one shared WireGuard entry tunnel
- one route-proxy layer that chains each route through its exact Mullvad SOCKS5 hostname
- one HAProxy layer for route-specific HTTPS listeners
- routing by destination bind IP so hostname-selected behavior remains truthful
- `status`, `doctor`, `runtime-manifest.json`, and validation reports that describe the shared-entry topology directly

In practical terms:

- adding routes no longer requires minting another Mullvad WireGuard key for each route
- route count is now constrained by bind-IP planning, runtime capacity, and upstream behavior rather than by one Mullvad device per route
- host default routing still stays unchanged

## Live proof

The shared-entry runtime has been proven with live Mullvad traffic, not just fixture tests.

Verified results:

- the integrated S06 release proof passed with one shared Mullvad device and multiple routed exits
- a preserved proof home was expanded to 50 total routes while reusing the same saved shared device
- the 50-route runtime started successfully with the normal three-container topology:
  - `entry-tunnel`
  - `route-proxy`
  - `routing-layer`
- a live sweep through `https://am.i.mullvad.net/json` proved:
  - 50 of 50 SOCKS5 routes passed
  - 50 of 50 HTTP routes passed
  - 49 of 50 HTTPS routes passed on the first sweep, with one transient HTTP/2 framing error
  - 50 of 50 HTTPS routes passed on the rerun
- the full matrix exposed 50 distinct exit IPs from one shared Mullvad device

## What remains true

- Linux is still the only fully supported live runtime platform.
- Non-loopback multi-route exposure still requires one distinct bind IP per route.
- Hostname-selected routing is only truthful when each hostname resolves to its assigned bind IP.
- The built-in `pnpm verify:s06` contract still probes the first two saved routes so the default end-to-end proof stays fast and inspectable.
- Fresh `pnpm verify:s06` runs need one free Mullvad device slot total. Reruns with `--reuse-temp-home <path>` can reuse the already-provisioned shared device.

## Mental model

Use this model when reasoning about Mullgate today:

1. `setup` persists routes, auth, bind IPs, and exact exit metadata.
2. `start` renders a shared-entry runtime, not one WireGuard backend per route.
3. Each route keeps its own local entrypoints and bind IP.
4. Each route chooses its own exact Mullvad SOCKS5 exit inside the shared entry tunnel.
5. `status`, `doctor`, and `runtime-manifest.json` report that topology truthfully.

## Documentation impact

Any Mullgate documentation or guidance that says "one Mullvad WireGuard device per route" is stale.

The truthful claim is:

> Mullgate uses one shared Mullvad WireGuard entry device and can fan out to many routed Mullvad exits from that single device.

## See also

- [README](../README.md)
- [Usage guide](usage.md)
- [Docs-site current runtime page](mullgate-docs/content/docs/architecture/current-runtime.mdx)
