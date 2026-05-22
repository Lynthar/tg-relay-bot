# Relay Bot

[中文](README.md) | **English**

A privacy-focused Telegram message relay bot platform deployed via Docker. One deployment hosts your own bot plus your friends' bots — friends onboard through Telegram with zero infrastructure to manage.

> Forked from [LloydAsp/nfd](https://github.com/LloydAsp/nfd) and rewritten as a multi-tenant TypeScript service. Originally targeted Cloudflare Workers; this branch ships a Node.js + SQLite container instead, with a stronger privacy/security model.

---

## Table of contents

- [What it is](#what-it-is)
- [Key features](#key-features)
- [When to use / when not to use](#when-to-use--when-not-to-use)
- [The three roles](#the-three-roles)
- [Architecture](#architecture)
- [Friend perspective: how to use](#friend-perspective-how-to-use)
- [Host perspective: how to deploy](#host-perspective-how-to-deploy)
- [Manager bot command reference](#manager-bot-command-reference)
- [Tenant bot behavior](#tenant-bot-behavior)
- [Display modes](#display-modes)
- [Operations](#operations)
- [Privacy & security model](#privacy--security-model)
- [Data retention](#data-retention)
- [FAQ](#faq)
- [Development](#development)
- [Acknowledgments](#acknowledgments)
- [License](#license)

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

## Friend perspective: how to use

No server access or code required. Prerequisite: your host has shared their manager bot's username with you (e.g. `@YourHostRelayManagerBot`).

### First-time onboarding

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts to pick a name and username, copy the returned token (looks like `12345:ABC...`)
2. Open the manager bot your host gave you
3. Send `/setup`, then paste the token from step 1
4. You should see `✅ @your_bot is live`. Done.
5. **Important**: long-press the message containing your token → "Delete for me and bot" to wipe it from chat history

### Day-to-day use

- Anyone who messages `@your_bot` → you receive a **native Telegram forwarded message** in your chat with the bot (blue "Forwarded from <name>" header, sender's profile clickable)
- Reply directly to that forwarded message → the reply goes back to the original sender (sender sees the bot, not you)
- Your reply is sent via copyMessage, **never revealing your real identity**

### Block / unblock

In the chat with **your own bot** (not the manager bot):

| Action | Effect |
|---|---|
| Reply to a forwarded message with any text | Text is sent back to the original guest |
| Reply to a forwarded message with `/block` | Block that guest |
| Reply to a forwarded message with `/unblock` | Unblock |
| Reply to a forwarded message with `/checkblock` | Show whether blocked |
| Send `/status` | Show that bot's stats (msg-map / blocked / rate-limit counts) |

⚠️ `/block` and friends **must be a reply to a forwarded message**. Naked UID arguments are not accepted, to prevent fat-finger blocks.

### Manage your bots

In the manager bot:

| Command | Purpose |
|---|---|
| `/list` | List bots you own |
| `/info <bot_username>` | Show details for a bot |
| `/displaymode <bot_username> <native\|tag\|hex>` | Change display mode (see below) |
| `/admins <bot_username> [add\|remove <uid> \| list]` | Manage admin UIDs (owner cannot be removed) |
| `/start_message <bot_username> <text>` | Customize the /start message (multi-line; up to 1000 chars) |
| `/pause <bot_username>` | Pause (unregister webhook; bot stops receiving) |
| `/resume <bot_username>` | Resume (re-register webhook) |
| `/delete <bot_username> --yes` | Delete (unregister webhook + purge all data) |

Without `--yes`, `/delete` only prints a confirmation prompt.

---

## Host perspective: how to deploy

### Prerequisites

1. **A server** — Linux usually. 1 vCPU / 512 MB RAM / 5 GB disk is plenty for personal / small-team use
2. **Docker + Docker Compose** — install per your distro ([official docs](https://docs.docker.com/engine/install/))
3. **A reverse proxy + HTTPS domain** — Telegram requires HTTPS for webhooks; the container itself only listens on HTTP. Common setups: Caddy (auto-renew certs) / Nginx + certbot / Traefik / Cloudflare Tunnel
4. **A manager bot** — `/newbot` with [@BotFather](https://t.me/BotFather); recommend a `Manager` suffix to distinguish it from tenant bots; save the token
5. **Your own Telegram UID** — message [@userinfobot](https://t.me/userinfobot), note the digits after `Id:`

### Deploy

```bash
# 1. Clone
git clone <this repo>
cd tg-relay-bot-docker

# 2. Prepare env file
cp .env.example .env
# Edit .env, fill in:
#   ENV_MANAGER_BOT_TOKEN  — manager bot token from above
#   ENV_HOST_UID           — your Telegram UID
#   ENV_MASTER_ENC_KEY     — generate once with `openssl rand -base64 32`
#   ENV_PUBLIC_BASE_URL    — your reverse proxy's public HTTPS URL, e.g.
#                            https://relay.example.com (must be https://, no trailing slash)
#   ENV_ADMIN_SECRET       — generate once with `openssl rand -hex 32`

# 3. Start the container (first build pulls the image + compiles better-sqlite3, ~1–2 min)
docker compose up -d

# 4. Configure your reverse proxy to terminate TLS for ENV_PUBLIC_BASE_URL and forward to 127.0.0.1:8080
#    Caddyfile example:
#       relay.example.com {
#           reverse_proxy 127.0.0.1:8080
#       }

# 5. Register the manager bot's webhook (after the container is up and reverse proxy is in place)
curl "https://relay.example.com/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
# Should return: manager webhook registered at https://relay.example.com/wh/<managerBotId>

# 6. Open your manager bot in Telegram, send /start, expect a welcome message
```

### Deployment troubleshooting

| Symptom | Likely cause |
|---|---|
| Container exits immediately with `fatal: missing env XXX` | A required field in `.env` isn't set |
| Startup error `fatal: ENV_PUBLIC_BASE_URL must start with https://` | You used `http://` or a bare hostname; must be `https://` |
| Reverse proxy reports 502 / healthcheck failing | Container not ready yet — `docker compose logs bot` should show `listening on :8080`; or proxy is targeting the wrong upstream port |
| `/admin/registerWebhook` returns `Not found` | `ENV_ADMIN_SECRET` not set, URL mistyped, or secret contains chars that need URL-encoding |
| `/admin/registerWebhook` returns 502 with `telegram error` | `ENV_MANAGER_BOT_TOKEN` wrong or revoked |
| Manager bot ignores `/start` | Webhook never registered (re-run step 5); `docker compose logs -f bot` |
| `/setup` reports `setWebhook failed` | Telegram cannot reach the URL behind `ENV_PUBLIC_BASE_URL` (DNS, cert, firewall, Cloudflare proxy, …); sanity-check with `curl -I https://relay.example.com/healthz` |
| After restart, Telegram replays old messages | `update_id` dedup TTL is 5 min; replays settle on their own |

### Configuration & rotation policy

| Field | Purpose | When to rotate |
|---|---|---|
| `ENV_MANAGER_BOT_TOKEN` | Manager bot's identity | When manager bot is reset; redo step 5 after |
| `ENV_HOST_UID` | Your (host's) Telegram UID | When you change Telegram accounts |
| `ENV_MASTER_ENC_KEY` | AES key for all tenant tokens at rest | **Never** — rotation makes every tenant unrecoverable |
| `ENV_PUBLIC_BASE_URL` | Public HTTPS URL the reverse proxy exposes | When you change domains; every tenant must `/pause` then `/resume` to re-register webhook |
| `ENV_ADMIN_SECRET` | Auth for `/admin/*` endpoints | Whenever you suspect a leak |
| `ENV_DEBUG` | Toggle debug logging | Off by default |

After editing `.env`, run `docker compose up -d` to restart the container with the new values.

> ⚠️ `ENV_MASTER_ENC_KEY` is the most sensitive secret in the system. Losing or changing it = all tenant tokens irrecoverable = every tenant must re-`/setup`. Keep an offline backup of the value, and back up `./data/db.sqlite` regularly.

### Onboard yourself as the first friend

After deploying, the host also goes through the friend flow to get the first outward-facing bot:

1. Use BotFather to create a separate outward-facing relay bot (**not the manager bot**)
2. In the manager bot, send `/setup`, paste the new bot's token
3. Done

---

## Manager bot command reference

Available to both friends and host:

| Command | Purpose |
|---|---|
| `/start` | Welcome message |
| `/help` | Command list (host sees additional host-only commands) |
| `/whoami` | Show your Telegram UID |
| `/cancel` | Reset current conversation state (cancel `/setup`) |
| `/setup` | Multi-step: paste token → auto-validate → auto-register webhook |
| `/list` | List bots you own |
| `/info <bot_username>` | Show details for a bot |
| `/displaymode <bot_username> <native\|tag\|hex>` | Change display mode |
| `/admins <bot_username> [add\|remove <uid> \| list]` | Manage admin UIDs; defaults to `list`; the owner cannot be removed |
| `/start_message <bot_username> <text>` | Customize the /start message (multi-line allowed, up to 1000 chars) |
| `/pause <bot_username>` | Pause a bot |
| `/resume <bot_username>` | Resume a bot |
| `/delete <bot_username> [--yes]` | Delete bot; bare form prints a confirmation, with `--yes` actually deletes |

Host only:

| Command | Purpose |
|---|---|
| `/host_list` | List **all** tenants (including other friends') |
| `/host_disable <bot_username>` | Forcibly pause any tenant (no ownership required) |
| `/host_purge <bot_username> --yes` | Forcibly delete any tenant; bare form only prints confirmation |

---

## Tenant bot behavior

Each onboarded bot supports the following inside its own private chat.

For everyone:

| Command | Purpose |
|---|---|
| `/start` | Show welcome message (default is bilingual) |
| `/help` | Show usage |
| `/whoami` | Show the sender's UID |

For the owner only (i.e. the friend who onboarded this bot):

| Action | Effect |
|---|---|
| Reply to a forwarded message with any text | Text is sent back to the original guest |
| Reply with `/block` | Block that guest |
| Reply with `/unblock` | Unblock |
| Reply with `/checkblock` | Show block status |
| Send `/status` | Show stats (msg-map / blocked / rate-limit windows counts) |

Non-admin users sending `/block` etc. → not effective; the message is treated as a normal forward to admin.

---

## Display modes

Each tenant bot configures this independently; default is `native`. Change via `/displaymode <bot_username> <mode>` in the manager bot.

| Mode | What admin sees | Suits |
|---|---|---|
| `native` | Native Telegram forward UI ("Forwarded from <name>" header, profile clickable) | Most cases; most direct |
| `tag` | Rich HTML tag (`↘ <name> · @handle · id:xxx`, with tg://user clickable link) + copyMessage (no forward metadata) | When you want sender identity but don't want the bot to look like it's "forwarding" |
| `hex` | Opaque hash tag (`↘ a3f9c1b8...`) + copyMessage | Maximum privacy; even admin only sees an anonymous hash |

---

## Operations

### Live logs

```bash
docker compose logs -f bot
```

Default: only error output. Set `ENV_DEBUG=1` in `.env` to see structured event flow (still no message content).

### Inspect the database

The state lives in `./data/db.sqlite` on the host. Query it directly with `sqlite3`:

```bash
# List all keys
sqlite3 ./data/db.sqlite "SELECT key FROM kv ORDER BY key;"

# All keys for one tenant
sqlite3 ./data/db.sqlite "SELECT key FROM kv WHERE key LIKE 'tenant:<botId>:%' ORDER BY key;"

# msg-map / blocklist counts
sqlite3 ./data/db.sqlite "SELECT substr(key, 1, instr(key, '-')-1) AS kind, COUNT(*) FROM kv GROUP BY kind;"
```

### Force-purge a tenant (bypass manager bot)

Normally use `/delete <bot_username> --yes`. If the manager bot is down:

```bash
sqlite3 ./data/db.sqlite "DELETE FROM kv WHERE key LIKE 'tenant:<botId>:%';"
```

Also `curl https://api.telegram.org/bot<token>/deleteWebhook` to unbind the webhook, otherwise Telegram keeps delivering updates to a tenant that no longer exists.

### Backup / restore

Everything is in one file. Either use SQLite's online backup or stop the container first:

```bash
# Recommended: online backup, no downtime
sqlite3 ./data/db.sqlite ".backup ./data/backup-$(date +%F).sqlite"

# Or: stop, copy, restart
docker compose down
cp ./data/db.sqlite /path/to/backup/db.sqlite
docker compose up -d
```

To restore, replace `./data/db.sqlite` with your backup and `docker compose restart bot`.

### Upgrade

```bash
git pull
docker compose build --pull
docker compose up -d
```

No need to re-register webhooks, edit `.env`, or migrate data.

### Full uninstall

```bash
# 1. In Telegram, /mybots in BotFather → delete every bot you created (manager + tenant)
# 2. Stop the container and wipe data
docker compose down -v
rm -rf ./data
# 3. Remove the image (optional)
docker image rm tg-relay-bot:local
```

### Rebuild (tear down and redeploy)

= **full uninstall + the deploy steps again**. If you want to keep some bots, only unbind their webhook instead of deleting the bot in BotFather:

```bash
# 1a. Unbind webhook for each bot you want to keep (does NOT delete the bot)
curl "https://api.telegram.org/bot<old bot token>/deleteWebhook"

# 1b. For bots you no longer want, go to BotFather → /mybots → Delete Bot

# 2. Stop the container and wipe data
docker compose down -v
rm -rf ./data

# 3. Follow the "Deploy" steps from the top
```

Note: **the new `ENV_MASTER_ENC_KEY` cannot match the old one** — every old tenant's encrypted token is now garbage; every friend has to `/setup` again.

Just want to rotate one field without losing data? Edit `.env` and `docker compose up -d`. Note: rotating `ENV_MASTER_ENC_KEY` makes **all existing tenant tokens undecryptable**.

Just want to take everything offline temporarily? `docker compose stop bot`; `docker compose start bot` brings it back. Per-tenant: `/pause` / `/resume` in the manager bot.

---

## Privacy & security model

### What we guarantee

- Guest chatIds are stored as HMAC-SHA256 hashes (`userKey`); a database dump reveals no chatId plaintext (except short-lived msg-map records)
- Every tenant token is AES-GCM encrypted at rest in SQLite
- Each tenant has its own random 32-byte webhook secret; comparisons are constant-time to thwart side-channel attacks
- Telegram's webhook retries are deduplicated by `update_id`
- Per-guest rate limit: max 5 messages per 60s; excess silently dropped
- All admin endpoints require `ENV_ADMIN_SECRET`; invalid → 404
- Bot ignores group chats and all update types other than `message` by default
- Admin commands require replying to a forwarded message; naked UID operations are forbidden

### What we cannot do

| Who | Sees content | Why |
|---|---|---|
| Telegram (the company) | ✅ | Telegram is **not** end-to-end encrypted; bot protocol can't use Secret Chats |
| Host (the deployer) | ✅ | `docker logs` for logs; `./data/db.sqlite` holds every tenant's encrypted token; inherent cost of multi-tenant hosting |
| Reverse proxy / TLS terminator | ✅ technically possible | TLS terminates at the proxy; cleartext is forwarded inside the local network. If the proxy is someone else's (Cloudflare Tunnel etc.), they can see it too. |
| Anyone with a leaked bot token | ✅ | Token = full access; switching the webhook intercepts all messages |
| Anyone with `./data/db.sqlite` + `ENV_MASTER_ENC_KEY` | ✅ | Together they decrypt every tenant token |
| ISPs / on-path observers | ❌ metadata only | TLS encrypted |
| Other Telegram users | ❌ | Private chats are 1-to-1 |

### Trust model

- **Host and friend must mutually trust each other** — host can decrypt every tenant's token
- **Don't host your bot on an untrusted host**
- Trust in Telegram, the IDC hosting your server, and your TLS-terminating proxy are background assumptions of this architecture
- A compromised server = attacker has `./data/db.sqlite` + the container's `ENV_MASTER_ENC_KEY` = every tenant compromised. Harden the host, lock down SSH, restrict `./data/` permissions to the owner

---

## Data retention

The database `./data/db.sqlite` has a single `kv` table with an `expires_at` column. Expired rows are lazily filtered on read and purged by a background timer that runs hourly.

| Data | Retention |
|---|---|
| `tenant:{botId}:cfg` (encrypted token) | Until `/delete --yes` |
| `tenant:{botId}:msg-map-{id}` | TTL 30 days |
| `tenant:{botId}:block-{userKey}` | Until `/unblock` |
| `tenant:{botId}:rate-{userKey}` | TTL 60 seconds |
| `tenant:{botId}:update-{id}` | TTL 5 minutes |
| `tenant:{botId}:mg-{adminId}-{mgId}` | TTL 60 seconds |
| `manager:user-state-{uid}` | TTL 1 hour after inactivity |
| `manager:dedup-update-{id}` | TTL 5 minutes |

---

## FAQ

**Q: What if I change `ENV_MASTER_ENC_KEY`?**
A: All tenants become irrecoverable — this key encrypts every token. Each must re-`/setup`. **Never rotate it.**

**Q: Why does the webhook URL sometimes return 404?**
A: Four possibilities: (a) wrong path; (b) missing/wrong `X-Telegram-Bot-Api-Secret-Token` header; (c) tenant `/pause`d; (d) tenant deleted.

**Q: Manager bot doesn't respond.**
A: Check `docker compose logs -f bot`; re-register via `/admin/registerWebhook?s=...`; verify `ENV_MANAGER_BOT_TOKEN` is correct and that the reverse proxy + DNS are healthy (`curl https://relay.example.com/healthz` should return `{"ok":true}`).

**Q: A friend's tenant bot isn't receiving messages.**
A: In the manager bot, `/info <their_bot>` → check `status`; if paused, `/resume`; or have the friend re-`/setup`.

**Q: Can friends see each other's bot data?**
A: No. Tenants are isolated by key prefix (`tenant:{botId}:`), and only owners can use `/info /pause /...` on their own. Host can `/host_list` to see tenants exist, but message contents are not persisted.

**Q: How big a machine do I need?**
A: 1 vCPU / 512 MB RAM / 5 GB disk is enough for a dozen tenant bots. SQLite's single-writer model handles personal/small-team load fine; if you ever expect hundreds of concurrently-active tenants you should switch to Redis/Postgres — but at that point this whole architecture is the wrong shape anyway.

**Q: How do I run it locally?**
A: `cp .env.example .env` and fill it in; `npm install`; `npm run dev` (tsx watch, auto-restarts on file change). SQLite db defaults to `./data/db.sqlite` — wipe and recreate freely. To exercise real webhooks locally, expose the port via ngrok / cloudflared tunnel and set `ENV_PUBLIC_BASE_URL` to the tunnel URL.

**Q: Why does a guest who sends 6+ messages within 60 seconds only see the first 5 reach the admin?**
A: Rate limiting. Per-guest cap is 5 per 60s; excess is silently dropped (no feedback to attackers).

---

## Development

```bash
npm install           # install dependencies (incl. better-sqlite3 native build)
npm run typecheck     # tsc type check
npm test              # vitest test suite, fully offline (no Docker needed)
npm run test:watch    # tests in watch mode
npm run dev           # tsx watch src/server.ts — auto-restarts on file change
npm start             # one-shot run of src/server.ts (the prod entry)
```

Tests live under `tests/unit/` (KV backends, crypto, security, storage) and `tests/integration/` (webhook routing, tenant isolation, manager commands). Integration tests drive the Hono app directly via `app.fetch(new Request(...))` — no HTTP server needed.

The container-side behavior can be reproduced locally too:

```bash
docker compose build       # build image (~1–2 min first time)
docker compose up -d       # start
docker compose logs -f bot # follow logs
docker compose down        # stop (keeps ./data)
```

---

## Acknowledgments

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — the single-tenant single-file version this was forked from
- Cloudflare Workers + KV — the original Worker version's runtime; the starting point for this repo
- Hono, @hono/node-server, better-sqlite3 — the Node-side runtime stack

## License

Inherited from upstream — see [LICENSE](LICENSE).
