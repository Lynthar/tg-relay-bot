# Relay Bot

[中文](README.md) | **English**

A privacy-focused Telegram **message relay bot platform**. One codebase, two deployment shapes: a **Cloudflare Worker** (free tier, zero ops) or a **Docker container** (your own server, your data in one SQLite file). One deployment hosts your own bot plus your friends' bots — friends onboard through Telegram with zero infrastructure to manage.

> Forked from [LloydAsp/nfd](https://github.com/LloydAsp/nfd) and rewritten as a multi-tenant TypeScript service with a stronger privacy/security model.

---

## What it is

In one sentence: let anyone reach you through your bot **without learning who you are or where to find you**.

In detail:

- Someone messages your bot → you (the operator) receive it in your own Telegram
- You reply directly to that message → they receive your reply, sender shown as the bot
- They have no way to discover the real account behind the bot

**Multi-tenant** means: a single deployment can host both your own bots and your trusted friends' bots, each with fully isolated data.

## Key features

- **Lightweight** — Cloudflare track: single Worker + single KV namespace; Docker track: single container + one SQLite file. No external services either way
- **Multi-tenant** — one deployment hosts every bot; friends self-onboard from inside Telegram (after a host `/invite`)
- **Encryption at rest** — every tenant's bot token, webhook secret, and hashSecret are AES-GCM encrypted
- **Anonymized senders** — guest chatIds are stored as HMAC-SHA256 hashes; even a full storage dump cannot reveal who messaged whom
- **Hardened webhook surface** — every webhook request must carry a per-tenant random secret_token (constant-time compared), `update_id` deduplication, per-guest rate limiting, admin commands gated to reply context
- **Cheap** — Cloudflare's free tier covers personal/small-team usage; or a 1 vCPU / 512 MB RAM VPS comfortably hosts a dozen tenant bots

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
| **Host** | The person who deploys this repo | Cloudflare account + Node.js, **or** a server with Docker + a public HTTPS domain |
| **Friend** | Someone who wants their own bot, invited by host | Just Telegram |
| **Guest** | Anyone messaging some bot | Just Telegram |

## Architecture

```
                       ┌──────────────────────────────────┐
                       │  One Hono app (one codebase)     │
 Friend ──manager bot─→│   /wh/{managerBotId}              │── KV storage (manager:user-state-*)
                       │     ↓ /setup conversation         │
 Guest ──tenant bot──→ │   /wh/{tenantBotId}               │── KV storage (tenant:{botId}:*)
                       │     ↓ relay logic                 │      msg-map / block / rate / dedup
 Friend ←──────────── │     ↓ forwardMessage              │
                       └──────────────────────────────────┘
```

- **Manager bot** (set up once by the host): friends use it to onboard and manage their own bots
- **Tenant bots** (each friend's): the actual relays
- Both share one process; URL paths distinguish them

The two deployment shapes differ only in entry point and storage backend:

- **Cloudflare track** — `src/worker.ts` entry, Telegram reaches the Worker directly, storage is Cloudflare KV
- **Docker track** — `src/server.ts` entry, a reverse proxy terminates TLS and forwards to the container's port 8080 (Telegram webhooks require HTTPS), storage is SQLite (`/data/db.sqlite`)

---

---

## Quick start

**If you are a friend** (your host has given you the manager bot's username): send `/whoami` to that manager bot and pass the UID to your host so they can `/invite` you. Then create your own bot at [@BotFather](https://t.me/BotFather), come back and send `/setup` with the token. You never touch a server.

**If you are the host**, pick one track:

### Cloudflare track

```bash
git clone <this repo> && cd tg-relay-bot && npm install
npx wrangler login
npx wrangler kv namespace create nfd      # put the returned id into wrangler.toml
# add to wrangler.toml:  [vars] ENV_PUBLIC_BASE_URL = "https://<your worker>.workers.dev"
npx wrangler secret put ENV_MANAGER_BOT_TOKEN
npx wrangler secret put ENV_HOST_UID
npx wrangler secret put ENV_MASTER_ENC_KEY   # openssl rand -base64 32
npx wrangler secret put ENV_ADMIN_SECRET     # openssl rand -hex 32
npx wrangler deploy
curl 'https://<your worker>.workers.dev/admin/registerWebhook?s=<ENV_ADMIN_SECRET>'
```

⚠️ The KV id currently in `wrangler.toml` belongs to a previous host — **replace it with your own**.

### Docker track

You need a machine that runs Docker and a domain you can get an HTTPS certificate for.

```bash
git clone <this repo> && cd tg-relay-bot
cp .env.example .env      # fill in the five required values (including ENV_PUBLIC_BASE_URL)
docker compose up -d      # the first run compiles better-sqlite3, roughly 1-2 minutes
# point a reverse proxy at 127.0.0.1:8080, terminating TLS for your domain
curl "https://relay.example.com/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
```

⚠️ Both tracks: if `ENV_MASTER_ENC_KEY` is ever lost or changed, every tenant token becomes unrecoverable. Keep an offline backup of the value you generate.

Step-by-step instructions, reverse-proxy examples, the troubleshooting tables, and secret rotation policy live in the [Usage and Deployment Guide](docs/user-guide.en.md#host-perspective-how-to-deploy).

## Documentation

The **[Usage and Deployment Guide](docs/user-guide.en.md)** is the full reference:

| Section | What it covers |
|---|---|
| [Friend perspective](docs/user-guide.en.md#friend-perspective-how-to-use) | Onboarding, day-to-day relay, blocking, managing your own bots |
| [Host perspective](docs/user-guide.en.md#host-perspective-how-to-deploy) | Both deployment tracks, reverse-proxy config, troubleshooting, secret rotation |
| [Commands](docs/user-guide.en.md#manager-bot-command-reference) · [Tenant behavior](docs/user-guide.en.md#tenant-bot-behavior) · [Display modes](docs/user-guide.en.md#display-modes) | Every command, and the three forwarding styles |
| [Operations](docs/user-guide.en.md#operations) | Logs, storage inspection, force-purging a tenant, backup/restore, upgrades (including from pre-merge versions), teardown, rebuild |
| [Privacy & security model](docs/user-guide.en.md#privacy--security-model) | What it does protect, what it **cannot**, and the trust model |
| [Data retention](docs/user-guide.en.md#data-retention) · [FAQ](docs/user-guide.en.md#faq) · [Development](docs/user-guide.en.md#development) | TTL of every key, FAQ, local development and tests |

Chinese readers: [中文指南](docs/user-guide.md).

---

## Acknowledgments

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — the single-tenant single-file version this was forked from
- Cloudflare Workers + KV — the zero-ops runtime shape
- Hono, @hono/node-server, better-sqlite3 — what lets the same codebase run on your own server

## License

Inherited from upstream — see [LICENSE](LICENSE).
