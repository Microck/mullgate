# Planning: Mullvad Proxy System

## Goal

Create a standalone SOCKS5 proxy system using Mullvad VPN that:
1. Does NOT interfere with Tailscale connection
2. Allows easy country/location selection
3. Can be used to launch browsers with specific proxy
4. Runs in Docker for complete isolation

---

## Requirements

### Must Have
- [ ] SOCKS5 proxy accessible on localhost
- [ ] No conflicts with existing Tailscale connection
- [ ] Ability to select country/location
- [ ] Docker-based for isolation

### Should Have
- [ ] Multiple countries available simultaneously (different ports)
- [ ] Easy switching between countries
- [ ] Auto-restart on failure
- [ ] Simple browser launch commands

### Nice to Have
- [ ] Health check endpoint
- [ ] Logging for debugging
- [ ] Quick country-switch script

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       HOST MACHINE                       │
│                                                          │
│  ┌─────────────────┐     ┌─────────────────────────┐    │
│  │   Tailscale     │     │   Docker Network        │    │
│  │   (unaffected)  │     │                         │    │
│  └─────────────────┘     │  ┌───────────────────┐  │    │
│                          │  │ mullvad-sweden    │  │    │
│                          │  │ wireproxy:1080    │──┼────┼──► 127.0.0.1:1080
│                          │  └───────────────────┘  │    │
│                          │                         │    │
│                          │  ┌───────────────────┐  │    │
│                          │  │ mullvad-nl        │  │    │
│                          │  │ wireproxy:1080    │──┼────┼──► 127.0.0.1:1081
│                          │  └───────────────────┘  │    │
│                          │                         │    │
│                          │  ┌───────────────────┐  │    │
│                          │  │ mullvad-usa       │  │    │
│                          │  │ wireproxy:1080    │──┼────┼──► 127.0.0.1:1082
│                          │  └───────────────────┘  │    │
│                          └─────────────────────────┘    │
│                                                          │
│  Browser ──► 127.0.0.1:1080 ──► Sweden exit            │
│  Browser ──► 127.0.0.1:1081 ──► Netherlands exit        │
│  Browser ──► 127.0.0.1:1082 ──► USA exit                │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Phase 1: Basic Setup

1. **Create directory structure**

```
mullvad-proxy/
├── docker-compose.yml
├── configs/
│   └── (WireGuard configs will go here)
├── scripts/
│   ├── launch-browser.sh
│   └── switch-country.sh
├── findings.md
└── planning.md
```

2. **Get Mullvad WireGuard configs**
   - Log into Mullvad account
   - Download configs for desired countries
   - Place in `configs/` directory

3. **Create docker-compose.yml**
   - Define service for each country
   - Map to different localhost ports

4. **Test basic connectivity**
   - `docker compose up -d`
   - `curl --socks5-hostname 127.0.0.1:1080 https://am.i.mullvad.net`

### Phase 2: Browser Integration

1. **Create browser launch script**
   - Accept country/port as argument
   - Launch browser with proxy configured

2. **Test browser functionality**
   - Verify IP shows correct country
   - Check for DNS leaks

### Phase 3: Polish

1. **Add helper scripts**
   - Quick country switch
   - Status check
   - Log viewer

2. **Documentation**
   - Usage guide
   - Country-to-port mapping

---

## Port Allocation

| Country | Port | Config File |
|---------|------|-------------|
| Sweden | 1080 | `configs/sweden.conf` |
| Netherlands | 1081 | `configs/netherlands.conf` |
| USA (New York) | 1082 | `configs/usa-nyc.conf` |
| USA (Los Angeles) | 1083 | `configs/usa-lax.conf` |
| UK | 1084 | `configs/uk.conf` |
| Germany | 1085 | `configs/germany.conf` |
| Japan | 1086 | `configs/japan.conf` |
| Singapore | 1087 | `configs/singapore.conf` |
| Australia | 1088 | `configs/australia.conf` |
| Switzerland | 1089 | `configs/switzerland.conf` |

---

## Usage Examples

### Start proxies

```bash
# Start all countries
docker compose up -d

# Start specific country
docker compose up -d sweden
```

### Launch browser with proxy

```bash
# Launch Chrome with Sweden proxy
./scripts/launch-browser.sh sweden

# Launch Chrome with Netherlands proxy
./scripts/launch-browser.sh netherlands
```

### curl with proxy

```bash
# Test Sweden proxy
curl --socks5-hostname 127.0.0.1:1080 https://ifconfig.me

# Test Netherlands proxy
curl --socks5-hostname 127.0.0.1:1081 https://ifconfig.me
```

---

## Files to Create

### 1. docker-compose.yml

```yaml
services:
  sweden:
    image: ghcr.io/windtf/wireproxy:latest
    container_name: mullvad-se
    restart: unless-stopped
    volumes:
      - ./configs/sweden.conf:/etc/wireproxy/config:ro
    ports:
      - "127.0.0.1:1080:1080"
```

### 2. configs/sweden.conf

```ini
[Interface]
PrivateKey = <from Mullvad>
Address = 10.64.0.2/32
DNS = 10.64.0.1

[Peer]
PublicKey = <from Mullvad>
Endpoint = <server-ip>:51820
AllowedIPs = 0.0.0.0/0

[Socks5]
BindAddress = 0.0.0.0:1080
```

### 3. scripts/launch-browser.sh

```bash
#!/bin/bash
COUNTRY=$1
case $COUNTRY in
  sweden)      PORT=1080 ;;
  netherlands) PORT=1081 ;;
  usa)         PORT=1082 ;;
  *)           echo "Unknown country"; exit 1 ;;
esac

chromium-browser --proxy-server=socks5://127.0.0.1:$PORT
```

---

## Testing Checklist

- [ ] Docker compose starts without errors
- [ ] Container shows healthy status
- [ ] curl test returns Mullvad IP
- [ ] curl test shows correct country
- [ ] Tailscale still works (check `tailscale status`)
- [ ] Browser launches with correct proxy
- [ ] Browser shows correct exit IP
- [ ] No DNS leaks (test at dnsleaktest.com)
- [ ] Can switch between countries
- [ ] Multiple countries work simultaneously

---

## Next Steps

1. **Get Mullvad WireGuard configs** (requires Mullvad subscription)
2. **Create directory structure**
3. **Write docker-compose.yml**
4. **Write config files**
5. **Test with curl**
6. **Create browser launch script**
7. **Add more countries as needed**

---

## Notes

- Each container runs wireproxy in userspace - no special Docker capabilities needed
- Proxy only listens on localhost (127.0.0.1) - not exposed to network
- Can add `CheckAlive` option for health monitoring
- Can add authentication with `Username`/`Password` in SOCKS5 section