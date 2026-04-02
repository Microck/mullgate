# Inline Selector Reference

This page lists the selector forms Mullgate supports when `--access-mode inline-selector` is enabled.

It does not try to list every live selector value. The exact live set depends on:

- the current Mullvad relay catalog
- any configured provider constraints
- whether a selector resolves to exactly one target

Use `mullgate proxy access --access-mode inline-selector` to inspect the live examples for the current config.

## URL shape

The selector lives in the proxy username.

Guaranteed form:

```text
scheme://selector:@host:port
```

Best-effort form:

```text
scheme://selector@host:port
```

Use the guaranteed form. Some clients handle a missing password poorly, which is why Mullgate documents `selector:@host:port` as the safe syntax.

## Supported selector families

### Country selectors

Supported forms:

- ISO country code
- normalized country slug

Examples:

```text
se
sweden
ca
canada
```

Meaning:

- selects a relay in that country
- Mullgate chooses a preferred relay that matches the selector and any configured constraints

### City selectors

Supported forms:

- `countryCode-cityCode`
- `countryCode-citySlug`
- `countrySlug-citySlug`
- bare `citySlug`, but only when that city slug is globally unambiguous

Examples:

```text
se-got
se-gothenburg
sweden-gothenburg
gothenburg
ca-tor
canada-toronto
toronto
```

Meaning:

- selects a relay in that city
- Mullgate chooses a preferred relay in the matched city after applying any provider constraints

### Exact relay selectors

Supported forms:

- relay hostname
- relay FQDN

Examples:

```text
se-got-wg-101
se-got-wg-101.relays.mullvad.net
ca-tor-wg-301
ca-tor-wg-301.relays.mullvad.net
```

Meaning:

- targets that exact Mullvad relay
- this is the most specific selector form

## Resolution rules

Inline selectors only work when the selector resolves to exactly one target.

That means:

- exact relay hostnames work when the relay exists in the current catalog
- country and city selectors work when they map cleanly after constraints are applied
- ambiguous short aliases are not guaranteed to be available
- a bare city slug like `gothenburg` or `toronto` is only usable if it is unique in the catalog

## Provider constraints

If you configure Mullgate to limit allowed providers, the live selector set narrows with it.

Examples:

- a city selector may stop resolving if all matching relays are filtered out
- an exact relay selector disappears if that relay no longer satisfies the saved provider constraints

## Protocols

Inline-selector uses one shared listener per enabled protocol.

Typical URLs:

```text
socks5://se:@100.124.44.113:1080
http://se-got:@100.124.44.113:8080
https://se-got-wg-101:@100.124.44.113:8443
```

Notes:

- `https://...` only works if HTTPS proxy support is configured with a cert, key, and HTTPS port
- in `private-network`, clients should use the host's real trusted-network IP, such as its Tailscale `100.x` address
- `0.0.0.0` is a bind-any address, not the client target

## Practical examples

Choose a country:

```text
socks5://ca:@100.124.44.113:1080
```

Choose a city:

```text
socks5://ca-tor:@100.124.44.113:1080
```

Choose an exact relay:

```text
socks5://ca-tor-wg-301:@100.124.44.113:1080
```

Use the relay FQDN:

```text
socks5://ca-tor-wg-301.relays.mullvad.net:@100.124.44.113:1080
```

## What this mode does not do

- it does not generate a static per-route proxy list like `published-routes`
- it does not guarantee that every short alias is unique
- it does not bypass the public empty-password safety rule

If you need a generated proxy inventory file, stay on `published-routes` and use `mullgate proxy export`.
