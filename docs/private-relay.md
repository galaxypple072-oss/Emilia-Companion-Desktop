# Private companion relay

The relay changes only multi-device transport. Product Core, its SQLite database,
persona, memories, provider credentials, QQ integration, email access, file access,
and future TTS remain on the user's Windows host.

## Privacy boundary

Both Core and desktop clients create outbound WebSocket connections to the relay.
The pairing code is a 256-bit secret that never leaves those endpoints. They derive
separate routing and AES-256-GCM keys with context-separated HMAC-SHA-256 operations.
Only the derived routing credential is sent to the relay. Chat events are encrypted
with authenticated routing metadata, so changing the sender, recipient, device, or
message identity makes decryption fail.

The relay keeps only in-memory connection rooms. It has no message database and no
offline queue. It can observe device identifiers, peer identifiers, connection times,
frame sizes, and routing direction, but it cannot read frame contents.

## Local proof

Generate a development pairing code:

```bash
pnpm relay:pair
```

Start the local relay:

```bash
pnpm relay:dev
```

Configure Core without disabling the existing LAN bridge:

```dotenv
COMPANION_RELAY_ENABLED=true
COMPANION_RELAY_URL=ws://127.0.0.1:8876/
COMPANION_RELAY_PAIRING_CODE=emilia1.core-xxxx.<secret>
```

The desktop connection wizard supports both `Private relay` and `LAN direct` modes.
For a real deployment, place the relay behind a TLS reverse proxy and use `wss://`.
Do not expose the development `ws://` endpoint to the internet.

## Ubuntu/Debian cloud deployment (one command)

Create a DNS A record such as `relay.example.com` pointing to the server's public
IPv4 address. Allow inbound TCP 80 and TCP/UDP 443 in the cloud firewall. Do not
open port 8876 publicly; it exists only on the private Compose network.

Create the DNS record first, then log into the Ubuntu/Debian server and run one
command (replace the domain):

```bash
curl -fsSL https://raw.githubusercontent.com/galaxypple072-oss/Emilia-Companion-Desktop/main/scripts/install-relay-ubuntu.sh \
  | sudo bash -s -- --domain relay.example.com
```

The installer installs Docker if needed, downloads only the relay source to
`/opt/emilia-relay`, generates a private path plus an end-to-end pairing code,
starts Caddy with TLS, and prints the two values to paste into the desktop
app’s graphical **Settings → Private relay connection** form. It is safe to
run again for the same domain and retains the existing secrets.

The installer can open UFW when it is enabled, but a cloud provider firewall
still needs TCP 80 and TCP/UDP 443 allowed manually.

Caddy obtains and renews the public TLS certificate. Its persistent certificate
state is stored in named volumes. Both containers use `restart: unless-stopped`,
so they return after a host reboot.

Update an existing deployment by rerunning the same command:

```bash
docker compose --env-file infra/relay/.env -f infra/relay/compose.yml up -d --build
```

The production endpoint entered into Core and desktop is:

```text
wss://relay.example.com/<private-relay-path>
```

The private path blocks unsolicited public connections before they reach the
relay. It is not a replacement for end-to-end encryption; the independent
pairing code still protects message contents.
