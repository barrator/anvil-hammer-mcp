# Deploying anvil-hammer-mcp (hosted mode)

This guide sets up the server on a Linux VPS so that Claude (web, desktop, mobile, Claude Code) can use it as a custom connector. It assumes nothing about your infrastructure beyond Docker and a reverse proxy. Commands run on the VPS; `sudo` is needed where files belong to the container user.

The stack has two containers:

- **server**: the MCP server. It sits on an internal network with no internet access and no published port.
- **gateway**: a small nginx, the only container with internet access. It relays requests from your reverse proxy to the server, and lets the server reach `www.worldanvil.com` and `claude.ai` over HTTPS (port 443), nothing else. `claude.ai` is needed to read Claude's published client identity at sign-in.

```
Claude ── https ──> Caddy (host) ── 127.0.0.1:8080 ──> gateway ──> server
                                                       gateway <── server ──> www.worldanvil.com, claude.ai (443 only)
```

## 1. What you need

- A VPS with Docker Engine and the Compose plugin (`docker compose version`). The image is built for x86_64 (amd64).
- A domain name pointing to the VPS, or a free [sslip.io](https://sslip.io) name: for the address `203.0.113.7`, the name `wa.203-0-113-7.sslip.io` resolves to it.
- A reverse proxy with TLS on the host. The examples use [Caddy](https://caddyserver.com), which gets certificates by itself. Ports 80 and 443 must reach it from the internet.
- Your own World Anvil **application key** and **user token**. Each installation uses its owner's keys; never share them.

## 2. Get the deployment files

Copy the `deploy/` folder of this repository to the VPS, for example to `/opt/anvil-hammer-mcp`:

```bash
git clone https://github.com/barrator/anvil-hammer-mcp.git /tmp/ahm
sudo mkdir -p /opt/anvil-hammer-mcp
sudo cp -r /tmp/ahm/deploy/. /opt/anvil-hammer-mcp/
cd /opt/anvil-hammer-mcp
```

You now have `docker-compose.yml`, `gateway/nginx.conf`, `env.example` and `Caddyfile.example`.

## 3. Settings

```bash
sudo cp env.example .env
sudo nano .env
```

- `WA_PUBLIC_URL`: the public https address, origin only, for example `https://wa.203-0-113-7.sslip.io`. The MCP URL for Claude is this address followed by `/mcp`.
- `ANVIL_HAMMER_VERSION`: the image version to run, a release tag without the `v` (for example `0.2.0`).
- `WA_HTTP_PORT`: the port on `127.0.0.1` where the reverse proxy reaches the gateway (default 8080). Pick a free one if 8080 is taken.
- Memory and CPU limits (defaults: 256 MB and 1 CPU for the server, 64 MB and half a CPU for the gateway), retention periods, and `WA_ENABLE_DELETE` (keep `false` unless you need deletion).

`.env` holds no secret. The two internal networks use `10.213.70.0/29` and `10.213.71.0/29`. If they collide with networks on your host, change them in `docker-compose.yml` **and** the matching addresses in `gateway/nginx.conf`.

## 4. Secrets

Keys and the passphrase hash are files, mounted read-only as Docker secrets. They never appear in environment variables, so `docker inspect` shows only paths. The server refuses to start if a file is missing, empty, or readable by other users.

```bash
sudo mkdir -p secrets
sudo sh -c 'printf "%s" "PASTE-YOUR-APPLICATION-KEY" > secrets/wa_app_key'
sudo sh -c 'printf "%s" "PASTE-YOUR-USER-TOKEN" > secrets/wa_auth_token'
```

(Or open each file with `sudo nano` and paste the value, so it does not stay in your shell history.)

The sign-in page asks for a **passphrase**. Only its scrypt hash is stored. Choose at least 12 characters, then hash it with the image itself (`read -rs` keeps it off the screen and out of the history):

```bash
read -rs PASS && printf '%s' "$PASS" | sudo docker run --rm -i \
  ghcr.io/barrator/anvil-hammer-mcp:0.2.0 hash-passphrase | sudo tee secrets/wa_passphrase_hash >/dev/null; unset PASS
```

The container runs as user 65532. Give it the files, readable by it only:

```bash
sudo chown 65532:65532 secrets/*
sudo chmod 400 secrets/*
```

## 5. Data folders and access levels

```bash
sudo mkdir -p data/config data/backups data/index data/logs
sudo sh -c 'echo "{}" > data/config/access.json'
sudo chown -R 65532:65532 data
sudo chmod 700 data/*
```

`data/config/access.json` maps world IDs to an access level (`full_edit`, `edit_only`, `read_only`, `blocked`); a world that is not listed is `read_only`. See the README, "Access levels". After editing it (`sudo nano data/config/access.json`), restart the server: `sudo docker compose restart server`.

## 6. Reverse proxy

Add a site to your Caddyfile (see `Caddyfile.example`), with your name and port:

```
wa.203-0-113-7.sslip.io {
	reverse_proxy 127.0.0.1:8080
}
```

Reload Caddy (`sudo systemctl reload caddy`). Caddy replaces any `X-Forwarded-For` a client sends with the real client address; the gateway believes that header only from the host side (your reverse proxy), and the server only from the gateway. The sign-in attempt limits rely on it.

The example also shows an optional restriction of `/mcp` and `/token` to Anthropic's addresses (`160.79.104.0/21`). Use it only if you never use Claude Code, which connects from your own computer.

## 7. Start

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps        # server should become "healthy"
curl -s https://wa.203-0-113-7.sslip.io/healthz
```

`/healthz` answers `{"status":"ok"}` without calling World Anvil. Then check the World Anvil connection and the network limits from inside the server container:

```bash
sudo docker compose exec server /nodejs/bin/node dist/index.js check
sudo docker compose exec server /nodejs/bin/node dist/index.js egress-check
```

Administration commands run inside the running server container with `docker compose exec` (`docker compose run` would clash with the server's fixed address). `check` prints `World Anvil: ok (… ms)` or an error kind. `egress-check` must show World Anvil and claude.ai reachable, and everything else blocked (another site, a raw IP, plain HTTP, a TLS connection naming another host). `/healthz/worldanvil` does the same World Anvil check over HTTP but needs an access token.

If the server does not start, `sudo docker compose logs server` gives the reason (for example a secret file readable by others, or a data folder it cannot write).

## 8. Add the connector in Claude

**Claude on the web, desktop or mobile.** Open the [Connectors directory](https://claude.ai/customize/connectors), select **Add**, then **Add custom connector**.

- Name: anything, for example "World Anvil".
- URL: `https://wa.203-0-113-7.sslip.io/mcp` (your `WA_PUBLIC_URL` followed by `/mcp`, exactly).
- Authentication: **Sign in now**. OAuth client: **Use Claude's published identity**. Claude usually detects both.
- Click **Add**, then **Connect**. Your browser opens the server's sign-in page: check that it says your browser will go to **claude.ai**, enter the passphrase, approve.

A connector added on the web is available in the desktop and mobile apps of the same account.

**Claude Code.**

```bash
claude mcp add --transport http world-anvil https://wa.203-0-113-7.sslip.io/mcp
```

Then run `/mcp` in Claude Code and choose the server to sign in. The sign-in page shows **localhost** or **127.0.0.1** and a warning: approve only if you started this sign-in yourself.

Access tokens last 30 minutes and are renewed automatically; a sign-in stays valid for 30 days without use, and 90 days at most.

**Other MCP clients.** Clients that do not publish an identity can use a pre-registered public client (no secret):

```bash
sudo docker compose exec server /nodejs/bin/node dist/index.js add-client \
  --name "My client" --redirect-uri https://client.example/callback
```

It prints a `client_id` to give to the client. Redirect URIs must be https, or `http://localhost/...` / `http://127.0.0.1/...` (any port). The list lives in `data/config/oauth/clients.json`; changes apply without a restart.

## 9. Revoke access

To cut every sign-in at once (lost phone, passphrase shared by mistake), even while the server runs:

```bash
sudo docker compose exec server /nodejs/bin/node dist/index.js revoke-all
```

Every client must sign in again. To change the passphrase, write a new hash in `secrets/wa_passphrase_hash` (section 4), run `revoke-all`, then `sudo docker compose restart server`.

## 10. Update and roll back

Images are published on GitHub's registry with one tag per version (`0.2.0`) and one per minor line (`0.2`). Read the release notes, then:

```bash
sudo nano .env                     # ANVIL_HAMMER_VERSION=<new version>
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

To roll back, set the previous version again and run the same commands. Data folders are kept across versions. Compare the new release's `deploy/` folder with yours when it changes.

If the image cannot be pulled (`denied`), the package may not be public yet: make it public in the repository's package settings on GitHub, or build it yourself from a clone: `docker build -t ghcr.io/barrator/anvil-hammer-mcp:0.2.0 .`

## 11. Back up the data, encrypted and off the host

Back up `data/`, `secrets/` and `.env`. They hold world content and keys, so encrypt before the copy leaves the VPS, for example with [age](https://age-encryption.org):

```bash
cd /opt/anvil-hammer-mcp
sudo tar -czf - data secrets .env | age -r age1yourpublickey... > anvil-$(date +%F).tar.gz.age
```

Copy the encrypted file to another machine or a storage service, and keep the age private key elsewhere. To restore: decrypt, extract into the deployment folder, then `sudo chown -R 65532:65532 data secrets`.

## 12. Privacy

Several folders hold personal or sensitive information. Limit access to the VPS, keep backups encrypted, and include these folders in any privacy impact assessment (for example under Québec's Law 25):

| Folder | Content | Sensitivity |
|---|---|---|
| `data/backups` | A full copy of every element before it was modified (90 days by default) | **High**: world content, may include real people's names |
| `data/index` | Empty for now; later a search index and an ID cache | **High** |
| `data/logs` | Technical log: tool, world ID, element ID, duration, result; authentication events **with the client IP address** (180 days by default, `WA_LOG_RETENTION_DAYS`). Never content or keys | Medium: IP addresses are personal information |
| `data/config` | Access levels, pre-registered clients, hashes of refresh tokens | Low to medium |
| `secrets/` | World Anvil keys and the passphrase hash | **High** |

Retention runs inside the server: technical log files older than their retention period are deleted daily, and old backups each time a new backup is written.
