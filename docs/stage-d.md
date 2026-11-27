# Stage D — Hosted mode (HTTP, OAuth, Docker)

Read `CLAUDE.md` and `docs/architecture.md` (§7). **Start by presenting your plan**; do not write code before it is approved. Before planning the OAuth part, read the current MCP authorization specification and Claude's custom connector authentication documentation, and quote in your plan the requirements you will follow.

Goal: the server runs as a Claude custom connector from a hardened Docker container behind a reverse proxy, usable from a phone. After this stage the owner deploys it on his VPS (deployment itself is not part of the repository).

Out of scope: new types and helper tools (stage E), search, write cap, change journal, ID cache, API change detection (stage F).

## 1. Streamable HTTP transport

Same tools and behaviour as stdio. Stdio keeps working.

## 2. Built-in OAuth authorization server (single user)

As in `docs/architecture.md` §7: Dynamic Client Registration and Client ID Metadata Documents; PKCE S256 required; short-lived access tokens with refresh; passphrase page (passphrase from a secret file, stored hashed; attempt limiting); allowed redirect URIs configurable with Claude's as defaults; every MCP request without a valid token rejected before any tool runs. Use the MCP TypeScript SDK's auth building blocks where they fit. Persist registered clients and refresh tokens in the `config` volume.

## 3. Docker image and compose

- Dockerfile: pinned base image digest, non-root user, minimal runtime.
- `docker-compose.yml` example: secrets as files (`WA_APP_KEY_FILE`, `WA_AUTH_TOKEN_FILE`, passphrase file), read-only root filesystem, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`, memory/CPU/PID limits, port on `127.0.0.1` only, volumes `config`, `backups`, `index`, `logs` with strict permissions.
- **Egress proxy** service: the server is on an internal network with no internet; only the proxy can reach the internet and it allows only `www.worldanvil.com` over HTTPS.
- Startup refuses missing or world-readable secret files.
- `/healthz` without any World Anvil call; an authenticated route that checks the World Anvil connection.
- Technical log in the `logs` volume: tool, world, element ID, duration, result. No content, no key. Retention 180 days by default.
- Example Caddy block.

## 4. Release pipeline

GitHub Actions: build and publish the image to GHCR on version tags; Dependabot or Renovate for dependencies and base image. Version `0.x` for now.

## 5. Documentation

`docs/deployment.md`: step-by-step for someone without the owner's infrastructure: domain and reverse proxy, secrets, compose up, adding the connector in Claude, access configuration, updating and rolling back by tag, backing up the volumes (encrypted, off-host), and a privacy note on the sensitive volumes.

## What does not change

All tool behaviour and safety from stages A–C.

## Delivery

Offline tests: auth flow (registration, PKCE, passphrase, token refresh, rejection without token), secret file checks, healthz. A local end-to-end run of the compose stack with a test client, and a check that the server container cannot reach any host other than World Anvil (show the command and output in the PR). Update `CLAUDE.md`. Pull request to `main`.

## Review checklist (for the owner)

- [ ] Does any request reach a tool without a valid token?
- [ ] From inside the server container, does `curl https://example.com` fail and `https://www.worldanvil.com` work?
- [ ] `docker inspect` on the running container: any key visible?
- [ ] Is the passphrase stored hashed? Are attempts limited?
- [ ] Could someone follow `docs/deployment.md` without knowing your setup?
- [ ] Add it as a connector in claude.ai and use it from the phone on the test world.
