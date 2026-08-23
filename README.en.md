# Relay Bot

[中文](README.md) | **English**

A privacy-focused Telegram message relay bot platform deployed via Docker. One deployment hosts your own bot plus your friends' bots — friends onboard through Telegram with zero infrastructure to manage.

> Forked from [LloydAsp/nfd](https://github.com/LloydAsp/nfd) and rewritten as a multi-tenant TypeScript service. Originally targeted Cloudflare Workers; this branch ships a Node.js + SQLite container instead, with a stronger privacy/security model.

---

## What it is

In one sentence: let anyone reach you through your bot **without learning who you are or where to find you**.

In detail:

- Someone messages your bot → you (the operator) receive it in your own Telegram
- You reply directly to that message → they receive your reply, sender shown as the bot
- They have no way to discover the real account behind the bot

**Multi-tenant** means: a single deployment can host both your own bots and your trusted friends' bots, each with fully isolated data.

## Key features

- **Lightweight** — single container + one SQLite file, no external services to run
- **Multi-tenant** — one deployment hosts every bot; friends self-onboard from inside Telegram
- **Encrypted tokens** — every tenant's bot token is AES-GCM encrypted at rest
- **Anonymized senders** — guest chatIds are stored as HMAC-SHA256 hashes; even a full database dump cannot reveal who messaged whom
- **Hardened webhook surface** — per-tenant random secret, mandatory secret_token check, constant-time comparison, `update_id` deduplication, per-guest rate limiting, admin commands gated to reply context
- **Low footprint** — a 1 vCPU / 512 MB RAM VPS comfortably hosts a dozen tenant bots

## When to use / when not to use

| ✅ Use it for | ❌ Skip it for |
|---|---|
| Public-facing inbox bot without revealing your ID | Real end-to-end encryption (Telegram itself can't do this) |
| Personal customer support / inquiry channel | Large-scale commercial support (use Crisp / Chatwoot / Intercom) |
| Small team's shared external contact point | Ticketing / agent assignment / handoff |
| Hosting bots for friends without per-user infra | Untrusted hosting (host holds token decryption capability) |

## The three roles

| Role | Who | Needs |
|---|---|---|
| **Host** | The person who deploys this repo | A server with Docker + a public HTTPS domain (your reverse proxy fronts the container) |
| **Friend** | Someone who wants their own bot, invited by host | Just Telegram |
| **Guest** | Anyone messaging some bot | Just Telegram |

## Architecture

```
                   ┌─────────────────┐    ┌──────────────────────────────┐
                   │  Reverse proxy  │    │  Docker container (Node+Hono)│
 Friend ──tg ─→ ───┤  TLS termination├─→──┤  /wh/{managerBotId}          │── SQLite (/data/db.sqlite)
                   │  (Caddy/Nginx/  │    │    ↓ /setup conversation     │      manager:* + tenant:{botId}:*
 Guest  ──tg ─→ ───┤   Traefik...)   ├─→──┤  /wh/{tenantBotId}           │
                   │                 │    │    ↓ relay logic             │
 Friend ←─tg ──── ─┤                 │←─── ─    ↓ forwardMessage         │
                   └─────────────────┘    │  /healthz, /admin/*          │
                                          └──────────────────────────────┘
```

- **Manager bot** (set up once by the host): friends use it to onboard and manage their own bots
- **Tenant bots** (each friend's): the actual relays
- Both share one container process; URL paths distinguish them
- **The reverse proxy must terminate TLS** — Telegram requires HTTPS for webhooks, but the container itself only listens on HTTP (port 8080)

---

---

## Quick start

**If you are a friend** (your host has given you the manager bot's username): send `/whoami` to that manager bot and pass the UID to your host so they can `/invite` you. Then create your own bot at [@BotFather](https://t.me/BotFather), come back and send `/setup` with the token. You never touch the server.

**If you are the host**: you need a machine that runs Docker and a domain you can get an HTTPS certificate for.

```bash
git clone <this repo> && cd tg-relay-bot-docker
cp .env.example .env      # fill in the five required values, listed below
docker compose up -d      # the first run compiles better-sqlite3, roughly 1-2 minutes
# point a reverse proxy at 127.0.0.1:8080, terminating TLS for your domain
curl "https://relay.example.com/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
```

The five required `.env` values: `ENV_MANAGER_BOT_TOKEN` (the manager bot's token) · `ENV_HOST_UID` (your Telegram UID) · `ENV_MASTER_ENC_KEY` (`openssl rand -base64 32`) · `ENV_PUBLIC_BASE_URL` (the public HTTPS URL of your reverse proxy — must be `https://`, no trailing slash) · `ENV_ADMIN_SECRET` (`openssl rand -hex 32`).

⚠️ If `ENV_MASTER_ENC_KEY` is ever lost or changed, every tenant token becomes unrecoverable. Keep an offline backup of the value you generate.

## Documentation

The **[Usage and Deployment Guide](docs/user-guide.en.md)** is the full reference:

| Section | What it covers |
|---|---|
| [Friend perspective](docs/user-guide.en.md#friend-perspective-how-to-use) | Onboarding, day-to-day relay, blocking, managing your own bots |
| [Host perspective](docs/user-guide.en.md#host-perspective-how-to-deploy) | The six deployment steps, reverse-proxy config, troubleshooting, secret rotation |
| [Commands](docs/user-guide.en.md#manager-bot-command-reference) · [Tenant behavior](docs/user-guide.en.md#tenant-bot-behavior) · [Display modes](docs/user-guide.en.md#display-modes) | Every command, and the three forwarding styles |
| [Operations](docs/user-guide.en.md#operations) | Logs, database inspection, force-purging a tenant, backup/restore, upgrades, teardown, rebuild |
| [Privacy & security model](docs/user-guide.en.md#privacy--security-model) | What it does protect, what it **cannot**, and the trust model |
| [Data retention](docs/user-guide.en.md#data-retention) · [FAQ](docs/user-guide.en.md#faq) · [Development](docs/user-guide.en.md#development) | Retention of every table, FAQ, local development and tests |

Chinese readers: [中文指南](docs/user-guide.md).

---

## Acknowledgments

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — the single-tenant single-file version this was forked from
- Cloudflare Workers + KV — the original Worker version's runtime; the starting point for this repo
- Hono, @hono/node-server, better-sqlite3 — the Node-side runtime stack

## License

Inherited from upstream — see [LICENSE](LICENSE).
