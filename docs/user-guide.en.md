# Usage and Deployment Guide

[← Back to README](../README.en.md) · [中文版](user-guide.md)

The README covers what this project is. This document is the full reference: how to use it, how to deploy it, how to operate it, and what to check when something breaks.

The project supports two deployment shapes: **Cloudflare Workers** (free tier, zero ops) and **Docker on your own server** (your data in one SQLite file). Bot behavior is identical on both; every deployment-specific section below is written in two tracks.

## Table of contents

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

---

## Friend perspective: how to use

No server, Cloudflare, or code required. Prerequisite: your host has shared their manager bot's username with you (e.g. `@YourHostRelayManagerBot`).

### First-time onboarding

1. Open the manager bot your host gave you, send `/whoami`, share the returned UID with your host, and wait until they run `/invite <your UID>`
2. Open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts to pick a name and username, copy the returned token (looks like `12345:ABC...`)
3. Back in the manager bot, send `/setup`, then paste the token from step 2
4. You should see `✅ @your_bot is live`. Done.
5. **Important**: long-press the message containing your token → "Delete for me and bot" to wipe it from chat history

Each user can onboard up to 3 bots (the host is exempt).

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
| Send `/blocklist` | List blocked guests' userKeys |
| Send `/unblock <userKey>` | Unblock by userKey (no reply needed) |
| Send `/status` | Show that bot's stats (msg-map / blocked / rate-limit counts) |

⚠️ `/block` **must be a reply to a forwarded message**. Naked UID arguments are not accepted, to prevent fat-finger blocks. Unblocking has one escape hatch: a blocked guest produces no new forwards and old ones expire after 30 days, so use `/unblock <userKey>` (the anonymous hash from `/blocklist`), never a UID.

### Manage your bots

In the manager bot:

| Command | Purpose |
|---|---|
| `/list` | List bots you own |
| `/info <bot_username>` | Show details for a bot |
| `/displaymode <bot_username> <native\|tag\|hex>` | Change display mode (see below) |
| `/admins <bot_username> [add\|remove <uid> \| list]` | Manage admin UIDs (owner cannot be removed) |
| `/start_message <bot_username> <text>` | Customize the /start message (multi-line; up to 1000 chars) |
| `/pause <bot_username>` | Pause (unregister webhook; messages sent meanwhile queue on Telegram's side, kept up to 24h) |
| `/resume <bot_username>` | Resume (re-register webhook; queued messages from the pause are delivered) |
| `/delete <bot_username> --yes` | Delete (unregister webhook + purge all stored data) |

Without `--yes`, `/delete` only prints a confirmation prompt.

---

---

## Host perspective: how to deploy

Pick a deployment track first:

| | Cloudflare Workers | Docker / your own server |
|---|---|---|
| Cost | Free tier covers personal/small-team use (KV has a daily write quota, see FAQ) | The smallest VPS (1 vCPU / 512 MB) is enough |
| You need | Cloudflare account + Node.js | A server with Docker + a domain with an HTTPS cert (reverse proxy) |
| Where the data lives | Cloudflare KV (their cloud) | `./data/db.sqlite`, one file — backup = copy the file |

Bot behavior and commands are identical on both tracks, and you can switch later (see FAQ).

### Deploy to Cloudflare Workers

Prerequisites:

1. **Cloudflare account** — sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free)
2. **Node.js** — install LTS from [nodejs.org](https://nodejs.org)
3. **A manager bot** — `/newbot` with [@BotFather](https://t.me/BotFather); recommend a `Manager` suffix to distinguish it from tenant bots; save the token
4. **Your own Telegram UID** — message [@userinfobot](https://t.me/userinfobot), note the digits after `Id:`

```bash
# 1. Clone & install
git clone <this repo>
cd tg-relay-bot
npm install

# 2. Log in to Cloudflare
npx wrangler login

# 3. Create the KV namespace
npx wrangler kv namespace create nfd
# Paste the returned id into wrangler.toml at id = "..."
# ⚠️ The id currently in the file belongs to a previous host; if you don't replace it,
# deploy fails with "KV namespace not found" (or, within the same Cloudflare
# account, silently binds to the old data).

# 4. Add your public URL to wrangler.toml (after deploy it is
#    https://tg-relay-bot.<your-subdomain>.workers.dev, or your custom domain):
#      [vars]
#      ENV_PUBLIC_BASE_URL = "https://tg-relay-bot.<your-subdomain>.workers.dev"

# 5. Set the four required secrets
npx wrangler secret put ENV_MANAGER_BOT_TOKEN   # the manager bot token from above
npx wrangler secret put ENV_HOST_UID            # your Telegram UID
npx wrangler secret put ENV_MASTER_ENC_KEY      # openssl rand -base64 32
npx wrangler secret put ENV_ADMIN_SECRET        # openssl rand -hex 32

# (optional) enable debug logging
npx wrangler secret put ENV_DEBUG               # type "1"

# 6. Deploy
npx wrangler deploy
# Outputs e.g. https://tg-relay-bot.<your-subdomain>.workers.dev

# 7. Register the manager bot's webhook
curl 'https://tg-relay-bot.<your-subdomain>.workers.dev/admin/registerWebhook?s=<ENV_ADMIN_SECRET>'
# Should return: manager webhook registered at https://.../wh/<managerBotId>

# 8. Open your manager bot in Telegram, send /start, expect a welcome message
```

Cloudflare-track troubleshooting:

| Symptom | Likely cause |
|---|---|
| `wrangler deploy` errors with `KV namespace not found` | The id in `wrangler.toml` wasn't replaced (or replaced wrong) |
| Every request 404s and `wrangler tail` shows a `config` error | `ENV_PUBLIC_BASE_URL` not set (step 4) or doesn't start with `https://` |
| `/admin/registerWebhook` returns `Not found` | `ENV_ADMIN_SECRET` not set, URL mistyped, or secret contains chars that need URL-encoding |
| `/admin/registerWebhook` returns 502 with `telegram error` | `ENV_MANAGER_BOT_TOKEN` wrong or revoked |
| Manager bot ignores `/start` | Webhook never registered (re-run step 7); check `npx wrangler tail` |
| `/setup` reports `setWebhook failed` | `ENV_PUBLIC_BASE_URL` wrong, DNS not yet propagated, or transient network — retry after ~30s |
| After deploy, Telegram replays old messages | `update_id` dedup TTL is 5 min; replays settle on their own |

### Deploy to Docker / your own server

Prerequisites:

1. **A server** — Linux usually. 1 vCPU / 512 MB RAM / 5 GB disk is plenty for personal / small-team use
2. **Docker + Docker Compose** — install per your distro ([official docs](https://docs.docker.com/engine/install/))
3. **A reverse proxy + HTTPS domain** — Telegram requires HTTPS for webhooks; the container itself only listens on HTTP. Common setups: Caddy (auto-renew certs) / Nginx + certbot / Traefik / Cloudflare Tunnel
4. **A manager bot** and **your own Telegram UID** — same as above

```bash
# 1. Clone
git clone <this repo>
cd tg-relay-bot

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

Docker-track troubleshooting:

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

### Secret meaning & rotation policy

Shared by both tracks (Cloudflare track: `wrangler secret put` / `wrangler.toml [vars]`; Docker track: edit `.env` and restart with `docker compose up -d`):

| Field | Purpose | When to rotate |
|---|---|---|
| `ENV_MANAGER_BOT_TOKEN` | Manager bot's identity | When manager bot is reset; re-register the manager webhook after |
| `ENV_HOST_UID` | Your (host's) Telegram UID | When you change Telegram accounts |
| `ENV_MASTER_ENC_KEY` | AES key for all tenant tokens at rest | **Never** — rotation makes every tenant unrecoverable |
| `ENV_PUBLIC_BASE_URL` | The public HTTPS URL Telegram delivers webhooks to | When you change domains; afterwards run `/host_migrate` once to refresh every tenant webhook, then re-run `/admin/registerWebhook` |
| `ENV_ADMIN_SECRET` | Auth for `/admin/*` endpoints (registering the manager webhook needs it, so required in practice) | Whenever you suspect a leak |
| `ENV_DEBUG` | Toggle debug logging | Off by default |

> ⚠️ `ENV_MASTER_ENC_KEY` is the most sensitive secret in the system. Losing or changing it = all tenant tokens irrecoverable = every tenant must re-`/setup`. Keep an offline backup of the value; on the Docker track, also back up `./data/db.sqlite` regularly.

### Onboard yourself as the first friend

After deploying, the host also goes through the friend flow to get the first outward-facing bot:

1. Use BotFather to create a separate outward-facing relay bot (**not the manager bot**)
2. In the manager bot, send `/setup`, paste the new bot's token (the host needs no invite and is exempt from the tenant cap)
3. Done

---

---

## Manager bot command reference

Available to both friends and host:

| Command | Purpose |
|---|---|
| `/start` | Welcome message |
| `/help` | Command list (host sees additional host-only commands) |
| `/whoami` | Show your Telegram UID |
| `/cancel` | Reset current conversation state (cancel `/setup`) |
| `/setup` | Multi-step: paste token → auto-validate → auto-register webhook (requires a host `/invite`; up to 3 bots per user) |
| `/list` | List bots you own |
| `/info <bot_username>` | Show details for a bot |
| `/displaymode <bot_username> <native\|tag\|hex>` | Change display mode |
| `/admins <bot_username> [add\|remove <uid> \| list]` | Manage admin UIDs; defaults to `list`; the owner cannot be removed; max 10 admins per bot |
| `/start_message <bot_username> <text>` | Customize the /start message (multi-line allowed, up to 1000 chars) |
| `/pause <bot_username>` | Pause a bot (guest messages sent while paused queue on Telegram's side for up to 24h) |
| `/resume <bot_username>` | Resume a bot (queued messages from the pause are then delivered) |
| `/delete <bot_username> [--yes]` | Delete bot; bare form prints a confirmation, with `--yes` actually deletes |

Host only:

| Command | Purpose |
|---|---|
| `/host_migrate` | Run once after upgrading from an older version: encrypts legacy plaintext secrets and refreshes webhooks; idempotent |
| `/invite <uid>` | Allow a user to `/setup` (they can find their UID via `/whoami`) |
| `/uninvite <uid>` | Revoke an invite (existing bots unaffected; use `/host_purge` if needed) |
| `/invites` | List invited users |
| `/host_list` | List **all** tenants (including other friends') |
| `/host_disable <bot_username>` | Forcibly pause any tenant (no ownership required) |
| `/host_purge <bot_username> --yes` | Forcibly delete any tenant; bare form only prints confirmation |

---

---

## Tenant bot behavior

Each onboarded bot supports the following inside its own private chat.

For everyone:

| Command | Purpose |
|---|---|
| `/start` | Show welcome message (default is bilingual; the owner can customize it via `/start_message` in the manager bot) |
| `/help` | Show usage |
| `/whoami` | Show the sender's UID |

For admins only (the owner plus anyone they added via `/admins`):

| Action | Effect |
|---|---|
| Reply to a forwarded message with any text | Text is sent back to the original guest |
| Reply with `/block` | Block that guest |
| Reply with `/unblock` | Unblock |
| Reply with `/checkblock` | Show block status |
| Send `/blocklist` | List blocked guests' userKeys |
| Send `/unblock <userKey>` | Unblock by userKey (for when the original forward has expired) |
| Send `/status` | Show stats (msg-map / blocked / rate-limit windows counts) |

Non-admin users sending `/block` etc. → not effective; the message is treated as a normal forward to admin. Admin-sent text starting with `/` that is not one of the commands above (e.g. a typo like `/blck`) is intercepted with a notice and never sent to the guest.

Note: the webhook only subscribes to new messages (`message`); a guest's **edits to already-sent messages are not synced** to admins.

---

---

## Display modes

Each tenant bot configures this independently; default is `native`. Change via `/displaymode <bot_username> <mode>` in the manager bot.

| Mode | What admin sees | Suits |
|---|---|---|
| `native` | Native Telegram forward UI ("Forwarded from <name>" header, profile clickable) | Most cases; most direct |
| `tag` | Rich HTML tag (`↘ <name> · @handle · id:xxx`, with tg://user clickable link) + copyMessage (no forward metadata) | When you want sender identity but don't want the bot to look like it's "forwarding" |
| `hex` | Opaque hash tag (`↘ a3f9c1b8...`) + copyMessage | Maximum privacy; even admin only sees an anonymous hash |

---

---

## Operations

### Live logs

```bash
npx wrangler tail             # Cloudflare track
docker compose logs -f bot    # Docker track
```

Default: only error output. Set `ENV_DEBUG=1` to see structured event flow (still no message content).

### Inspect storage

Cloudflare track (note `--remote`: Wrangler v4 targets local simulated data by default):

```bash
# Top-level overview
npx wrangler kv key list --binding=nfd --remote

# All keys for one tenant
npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:" --remote
```

Docker track (the state lives in `./data/db.sqlite` on the host):

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
# Cloudflare track (requires jq; both commands need --remote, or you'd be deleting local simulated data)
for key in $(npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:" --remote | jq -r '.[].name'); do
  npx wrangler kv key delete --binding=nfd "$key" --remote
done

# Docker track
sqlite3 ./data/db.sqlite "DELETE FROM kv WHERE key LIKE 'tenant:<botId>:%';"
```

Also `curl https://api.telegram.org/bot<token>/deleteWebhook` to unbind the webhook, otherwise Telegram keeps delivering updates to a tenant that no longer exists.

### Backup / restore (Docker track)

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

On the Cloudflare track the data lives in KV in their cloud with no one-command backup; the critical thing to back up offline is `ENV_MASTER_ENC_KEY` itself.

### Upgrade

```bash
# Cloudflare track
git pull
npm install
npx wrangler deploy

# Docker track
git pull
docker compose build --pull
docker compose up -d
```

No need to re-register webhooks, reconfigure secrets, or migrate data.

**Upgrading from a pre-merge version** (the old Worker-only version, or the `tg-relay-bot-docker` fork):

1. Old Worker-only version: after `git pull`, add `[vars] ENV_PUBLIC_BASE_URL = "https://<your worker>.workers.dev"` to `wrangler.toml` (newly required), then `npx wrangler deploy`
2. `tg-relay-bot-docker` fork: point the git remote at this repo and `git pull`; `.env` needs no new fields — just `docker compose build --pull && docker compose up -d`
3. On both tracks: re-run `curl 'https://.../admin/registerWebhook?s=<ENV_ADMIN_SECRET>'`, then run `/host_migrate` in the manager bot — it encrypts existing tenants' plaintext secrets and applies `allowed_updates` to every tenant webhook. Both steps are idempotent
4. In multi-admin tenants, reply routing for forwards stored before the migration uses the old key format: replying to an occasional old message may report no target; those records age out within the 30-day TTL and need no action

### Full uninstall

```bash
# First: in Telegram, /mybots in BotFather → delete every bot you created (manager + tenant). Then:

# Cloudflare track
npx wrangler delete
npx wrangler kv namespace delete --binding=nfd

# Docker track
docker compose down -v
rm -rf ./data
docker image rm tg-relay-bot:local   # optional
```

### Rebuild (tear down and redeploy)

= **full uninstall + the deploy steps again**. If you want to keep some bots, only unbind their webhook instead of deleting the bot in BotFather:

```bash
# 1a. Unbind webhook for each bot you want to keep (does NOT delete the bot)
curl "https://api.telegram.org/bot<old bot token>/deleteWebhook"

# 1b. For bots you no longer want, go to BotFather → /mybots → Delete Bot

# 2. Tear down the old deployment (your track's steps under "Full uninstall")

# 3. Follow the "Deploy" steps from the top
```

Caveats:

1. **The new `ENV_MASTER_ENC_KEY` cannot match the old one** — every old tenant's encrypted token is now garbage; every friend has to `/setup` again
2. Cloudflare track: the new KV namespace id is different — **remember to update `wrangler.toml`**; if the Worker name is unchanged, the URL usually stays the same and friends won't notice
3. Just want to rotate one secret without a teardown? Cloudflare track: `npx wrangler secret put <NAME>`; Docker track: edit `.env` and `docker compose up -d`. Note: rotating `ENV_MASTER_ENC_KEY` makes **all existing tenant tokens undecryptable**

Just want to take everything offline temporarily (no data loss)? `/pause` each tenant from the manager bot (on the Docker track, `docker compose stop bot` also works). Guest messages sent while paused queue on Telegram's side (up to 24 hours) and are delivered after resuming; anything older is dropped by Telegram.

---

---

## Privacy & security model

### What we guarantee

- Guest chatIds are stored as HMAC-SHA256 hashes (`userKey`); a storage dump reveals no chatId plaintext (the one exception is the reply-routing msg-map, which expires after 30 days)
- Every tenant's token, webhook secret, and hashSecret are AES-GCM encrypted at rest — a storage dump alone (without `ENV_MASTER_ENC_KEY`) cannot brute-force userKeys offline (deployments upgraded from older versions must run `/host_migrate` once)
- Webhook auth relies on a per-tenant random `secret_token` header (constant-time compared, thwarting side channels), not path secrecy — the botId in the path is public information; a missing or wrong secret gets a uniform 404, unusable for probing whether a bot is hosted here
- Telegram's webhook retries are deduplicated by `update_id`
- Per-guest rate limit: max 5 messages per 60s; excess silently dropped
- All admin endpoints require `ENV_ADMIN_SECRET`; invalid → 404
- Bot ignores group chats and all update types other than `message` by default
- Admin commands require replying to a forwarded message; naked UID operations are forbidden
- Onboarding requires an explicit host `/invite` plus a per-user bot cap — strangers who discover the manager bot cannot attach bots to your deployment

### What we cannot do

| Who | Sees content | Why |
|---|---|---|
| Telegram (the company) | ✅ | Telegram is **not** end-to-end encrypted; bot protocol can't use Secret Chats |
| Cloudflare (Cloudflare track) | ✅ technically possible | The Worker runs on their edge; TLS terminates at CF |
| Reverse proxy / TLS terminator (Docker track) | ✅ technically possible | TLS terminates at the proxy; cleartext is forwarded inside the local network. If the proxy is someone else's (Cloudflare Tunnel etc.), they can see it too |
| Host (the deployer) | ✅ | Logs + storage hold every tenant's token; inherent cost of multi-tenant hosting |
| Anyone with a leaked bot token | ✅ | Token = full access; switching the webhook intercepts all messages |
| Anyone with a storage dump + `ENV_MASTER_ENC_KEY` | ✅ | Together they decrypt every tenant token |
| ISPs / on-path observers | ❌ metadata only | TLS encrypted |
| Other Telegram users | ❌ | Private chats are 1-to-1 |

### Trust model

- **Host and friend must mutually trust each other** — host can decrypt every tenant's token
- **Don't host your bot on an untrusted host**
- Background assumptions: on the Cloudflare track, trust in Telegram + Cloudflare; on the Docker track, trust in Telegram + the IDC hosting your server + your TLS-terminating proxy
- Docker track: a compromised server = attacker has `./data/db.sqlite` + the container's `ENV_MASTER_ENC_KEY` = every tenant compromised. Harden the host, lock down SSH, restrict `./data/` permissions to the owner

---

---

## Data retention

Both storage backends share the same key layout. Cloudflare KV expires keys natively; the SQLite backend (the `kv` table in `./data/db.sqlite`) stores an `expires_at` per row, filters expired rows lazily on read, and purges them with an hourly background timer.

| Data | Retention |
|---|---|
| `tenant:{botId}:cfg` (encrypted token & secrets) | Until `/delete --yes` |
| `tenant:{botId}:msg-map-{adminUid}-{id}` | TTL 30 days |
| `tenant:{botId}:block-{userKey}` | Until `/unblock` |
| `tenant:{botId}:rate-{userKey}` | TTL 60 seconds |
| `tenant:{botId}:update-{id}` | TTL 5 minutes |
| `tenant:{botId}:mg-*` / `album-*` (album tag & rate-unit dedup markers) | TTL 60 seconds |
| `manager:user-state-{uid}` | TTL 1 hour after inactivity |
| `manager:dedup-update-{id}` | TTL 5 minutes |
| `manager:allow-{uid}` (invite list) | Until `/uninvite` |

---

---

## FAQ

**Q: What if I change `ENV_MASTER_ENC_KEY`?**
A: All tenants become irrecoverable — this key encrypts every token. **Never rotate it.** If it does happen (key lost or mistakenly replaced), the recovery path: `/delete <bot> --yes` (or host `/host_purge`) each tenant — the local purge still runs even when the token can no longer be decrypted; only the old webhook can't be deregistered on the tenant's behalf — then re-`/setup`; the new setWebhook simply overwrites the old webhook.

**Q: Why does the webhook URL sometimes return 404?**
A: Three possibilities: (a) wrong path; (b) missing/wrong `X-Telegram-Bot-Api-Secret-Token` header; (c) tenant deleted. A `/pause`d tenant does NOT 404 — it returns 200 and drops the update (normally pause has unregistered the webhook, so Telegram stops delivering at all).

**Q: Manager bot doesn't respond.**
A: Check the logs (`npx wrangler tail` or `docker compose logs -f bot`); re-register via `/admin/registerWebhook?s=...`; verify `ENV_MANAGER_BOT_TOKEN` is correct. On the Docker track also confirm the reverse proxy + DNS are healthy (`curl https://relay.example.com/healthz` should return `{"ok":true}`).

**Q: A friend's tenant bot isn't receiving messages.**
A: In the manager bot, `/info <their_bot>` → check `status`; if paused, `/resume`; or have the friend re-`/setup`.

**Q: Can friends see each other's bot data?**
A: Other friends cannot — tenants are isolated by key prefix (`tenant:{botId}:`), and a regular user's `/info /pause /...` only reach bots they own. The **host, however, is the super-admin**: besides the `/host_*` commands, the host's regular management commands also work on any tenant (the host already holds the master key and the deployment account, so this concedes no extra trust). Message contents are visible to no one — they are not persisted.

**Q: Is Cloudflare's free tier enough?** (Cloudflare track)
A: For small scale, yes. Workers free: 100k requests/day; KV free: **1k writes/day (shared platform-wide, resets 00:00 UTC)**. Each delivered guest message costs ~3 KV writes (blocked / rate-limited / junk messages cost none). Beware: **once the daily free quota is exhausted, further KV writes fail outright** — messages are silently lost, not "slightly over budget". 10 friends × 50 messages/day ≈ 1500 writes clearly exceeds it — at that scale use Workers Paid ($5/month, 1M writes/month), or switch to the Docker track (SQLite has no write quota).

**Q: How big a machine do I need?** (Docker track)
A: 1 vCPU / 512 MB RAM / 5 GB disk is enough for a dozen tenant bots. SQLite's single-writer model handles personal/small-team load fine; if you ever expect hundreds of concurrently-active tenants you should switch to Redis/Postgres — but at that point this whole architecture is the wrong shape anyway.

**Q: Can I migrate between the two tracks?**
A: Business code and key layout are identical, but there is no automated data mover. The pragmatic path: deploy the new track, then have each friend `/setup` again (same bot, same token — it just re-registers and points the webhook at the new address); state like blocklists is lost.

**Q: How do I run it locally?**
A: Cloudflare track: create `.dev.vars` (gitignored) mirroring the required secrets, then `npm run dev:worker`. Node track: `cp .env.example .env`, fill it in, then `npm run dev` (tsx watch, auto-restarts on file change); the SQLite db defaults to `./data/db.sqlite` — wipe and recreate freely. To exercise real webhooks locally, expose the port via ngrok / cloudflared tunnel and set `ENV_PUBLIC_BASE_URL` to the tunnel URL.

**Q: Why does a guest who sends 6+ messages within 60 seconds only see the first 5 reach the admin?**
A: Rate limiting. Per-guest cap is 5 per 60s; excess is silently dropped (no feedback to attackers). A media group (album) counts as a single unit, so a 2–10 item album arrives whole.

---

---

## Development

```bash
npm install           # install dependencies (incl. better-sqlite3 native build)
npm run typecheck     # tsc type check (runs both the Node and the Worker tsconfig)
npm test              # main test suite (plain Node + in-memory store, fully offline)
npm run test:worker   # Worker entry smoke tests (workers-pool, real workerd runtime)
npm run test:watch    # main suite in watch mode
npm run dev           # Node-track local dev: tsx watch src/server.ts
npm run dev:worker    # Cloudflare-track local dev: wrangler dev
npm run deploy        # deploy to Cloudflare
```

Tests live under `tests/unit/` (KV backends, crypto, security, storage), `tests/integration/` (webhook routing, tenant isolation, manager commands), and `tests/worker/` (Worker entry smoke). Integration tests drive the Hono app directly via `app.fetch(new Request(...))` — no HTTP server needed.

The container-side behavior can be reproduced locally too:

```bash
docker compose build       # build image (~1–2 min first time)
docker compose up -d       # start
docker compose logs -f bot # follow logs
docker compose down        # stop (keeps ./data)
```

---
