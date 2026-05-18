# Relay Bot

[中文](README.md) | **English**

A privacy-focused Telegram message relay bot platform running on Cloudflare Workers. One deployment hosts your own bot plus your friends' bots — friends onboard through Telegram with zero infrastructure to manage.

> Forked from [LloydAsp/nfd](https://github.com/LloydAsp/nfd) and rewritten as a multi-tenant TypeScript service with a stronger privacy/security model.

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

- **Lightweight** — single Cloudflare Worker + single KV namespace, zero runtime external dependencies
- **Multi-tenant** — one deployment hosts every bot; friends self-onboard from inside Telegram
- **Encrypted tokens** — every tenant's bot token is AES-GCM encrypted at rest in KV
- **Anonymized senders** — guest chatIds are stored in KV as HMAC-SHA256 hashes; even a full KV dump cannot reveal who messaged whom
- **Hardened webhook surface** — unguessable derived path, mandatory secret_token check, constant-time comparison, `update_id` deduplication, per-guest rate limiting, admin commands gated to reply context
- **Zero cost** — Cloudflare's free tier covers personal/small-team usage

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
| **Host** | The person who deploys this repo | Cloudflare account + Node.js + this code |
| **Friend** | Someone who wants their own bot, invited by host | Just Telegram |
| **Guest** | Anyone messaging some bot | Just Telegram |

## Architecture

```
                       ┌──────────────────────────────────┐
                       │  Cloudflare Worker (one codebase)│
 Friend ──manager bot─→│   /wh/{managerBotId}              │── KV (manager:user-state-*)
                       │     ↓ /setup conversation         │
 Guest ──tenant bot──→ │   /wh/{tenantBotId}               │── KV (tenant:{botId}:*)
                       │     ↓ relay logic                 │      msg-map / block / rate / dedup
 Friend ←──────────── │     ↓ forwardMessage              │
                       └──────────────────────────────────┘
```

- **Manager bot** (set up once by the host): friends use it to onboard and manage their own bots
- **Tenant bots** (each friend's): the actual relays
- Both share one Worker; URL paths distinguish them

---

## Friend perspective: how to use

No Cloudflare or code required. Prerequisite: your host has shared their manager bot's username with you (e.g. `@YourHostRelayManagerBot`).

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
| `/delete <bot_username> --yes` | Delete (unregister webhook + purge all KV) |

Without `--yes`, `/delete` only prints a confirmation prompt.

---

## Host perspective: how to deploy

### Prerequisites

1. **Cloudflare account** — sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free)
2. **Node.js** — install LTS from [nodejs.org](https://nodejs.org)
3. **A manager bot** — `/newbot` with [@BotFather](https://t.me/BotFather); recommend a `Manager` suffix to distinguish it from tenant bots; save the token
4. **Your own Telegram UID** — message [@userinfobot](https://t.me/userinfobot), note the digits after `Id:`

### Deploy

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

# 4. Set the four required secrets
npx wrangler secret put ENV_MANAGER_BOT_TOKEN   # the manager bot token from above
npx wrangler secret put ENV_HOST_UID            # your Telegram UID
npx wrangler secret put ENV_MASTER_ENC_KEY      # openssl rand -base64 32
npx wrangler secret put ENV_ADMIN_SECRET        # openssl rand -hex 32

# (optional) enable debug logging
npx wrangler secret put ENV_DEBUG               # type "1"

# 5. Deploy
npx wrangler deploy
# Outputs e.g. https://tg-relay-bot.<your-subdomain>.workers.dev

# 6. Register the manager bot's webhook
curl 'https://tg-relay-bot.<your-subdomain>.workers.dev/admin/registerWebhook?s=<ENV_ADMIN_SECRET>'
# Should return: manager webhook registered at https://.../wh/<managerBotId>

# 7. Open your manager bot in Telegram, send /start, expect a welcome message
```

### Secret meaning & rotation policy

| Secret | Purpose | When to rotate |
|---|---|---|
| `ENV_MANAGER_BOT_TOKEN` | Manager bot's identity | When manager bot is reset; redo step 6 after |
| `ENV_HOST_UID` | Your (host's) Telegram UID | When you change Telegram accounts |
| `ENV_MASTER_ENC_KEY` | AES key for all tenant tokens at rest | **Never** — rotation makes every tenant unrecoverable |
| `ENV_ADMIN_SECRET` | Auth for `/admin/*` endpoints | Whenever you suspect a leak |
| `ENV_DEBUG` | Toggle debug logging | Off by default |

> ⚠️ `ENV_MASTER_ENC_KEY` is the most sensitive secret in the system. Losing or changing it = all tenant tokens irrecoverable = every tenant must re-`/setup`. Keep an offline backup of the value.

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
npx wrangler tail
```

Default: only error output. Set `ENV_DEBUG=1` to see structured event flow (still no message content).

### Inspect KV

```bash
# Top-level overview
npx wrangler kv key list --binding=nfd

# All keys for one tenant
npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:"
```

### Force-purge a tenant (bypass manager bot)

Normally use `/delete <bot_username> --yes`. If the manager bot is down:

```bash
for key in $(npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:" --remote | jq -r '.[].name'); do
  npx wrangler kv key delete --binding=nfd "$key"
done
```

### Upgrade

```bash
git pull
npm install
npx wrangler deploy
```

No need to re-register webhooks, re-put secrets, or migrate KV.

### Full uninstall

```bash
# 1. In Telegram, /mybots in BotFather → delete every bot you created (manager + tenant)
# 2. Delete the Worker
npx wrangler delete
# 3. Delete the KV namespace
npx wrangler kv namespace delete --binding=nfd
```

---

## Privacy & security model

### What we guarantee

- Guest chatIds are stored in KV as HMAC-SHA256 hashes (`userKey`); a KV dump reveals no chatId plaintext (except short-lived msg-map records)
- Every tenant token is AES-GCM encrypted at rest in KV
- Webhook URL paths are SHA-256-derived and unguessable
- Webhook secret is compared in constant time to thwart side-channel attacks
- Telegram's webhook retries are deduplicated by `update_id`
- Per-guest rate limit: max 5 messages per 60s; excess silently dropped
- All admin endpoints require `ENV_ADMIN_SECRET`; invalid → 404
- Bot ignores group chats and all update types other than `message` by default
- Admin commands require replying to a forwarded message; naked UID operations are forbidden

### What we cannot do

| Who | Sees content | Why |
|---|---|---|
| Telegram (the company) | ✅ | Telegram is **not** end-to-end encrypted; bot protocol can't use Secret Chats |
| Cloudflare | ✅ technically possible | The Worker runs on their edge; TLS terminates at CF |
| Host (the deployer) | ✅ | `wrangler tail` for logs; KV holds all tenant tokens; inherent cost of multi-tenant hosting |
| Anyone with a leaked bot token | ✅ | Token = full access; switching the webhook intercepts all messages |
| ISPs / on-path observers | ❌ metadata only | TLS encrypted |
| Other Telegram users | ❌ | Private chats are 1-to-1 |

### Trust model

- **Host and friend must mutually trust each other** — host can decrypt every tenant's token
- **Don't host your bot on an untrusted host**
- Trust in Telegram and Cloudflare are background assumptions of this architecture

---

## Data retention

| Data | Retention |
|---|---|
| `tenant:{botId}:cfg` (encrypted token) | Until `/delete --yes` |
| `tenant:{botId}:msg-map-{id}` | TTL 30 days |
| `tenant:{botId}:block-{userKey}` | Until `/unblock` |
| `tenant:{botId}:rate-{userKey}` | TTL 60 seconds |
| `tenant:{botId}:update-{id}` | TTL 5 minutes |
| `manager:user-state-{uid}` | TTL 1 hour after inactivity |
| `manager:dedup-update-{id}` | TTL 5 minutes |

---

## FAQ

**Q: What if I change `ENV_MASTER_ENC_KEY`?**
A: All tenants become irrecoverable — this key encrypts every token. Each must re-`/setup`. **Never rotate it.**

**Q: Why does the webhook URL sometimes return 404?**
A: Four possibilities: (a) wrong path; (b) missing/wrong `X-Telegram-Bot-Api-Secret-Token` header; (c) tenant `/pause`d; (d) tenant deleted.

**Q: Manager bot doesn't respond.**
A: Check `npx wrangler tail`; re-register via `/admin/registerWebhook?s=...`; verify `ENV_MANAGER_BOT_TOKEN` is correct.

**Q: A friend's tenant bot isn't receiving messages.**
A: In the manager bot, `/info <their_bot>` → check `status`; if paused, `/resume`; or have the friend re-`/setup`.

**Q: Can friends see each other's bot data?**
A: No. Tenants are isolated by KV prefix (`tenant:{botId}:`), and only owners can use `/info /pause /...` on their own. Host can `/host_list` to see tenants exist, but message contents are not persisted.

**Q: Is Cloudflare's free tier enough?**
A: Usually yes. Workers free: 100k requests/day; KV free: 1k writes/day. Each guest message is ~3-4 KV writes. 10 friends × 50 messages/day ≈ 1500-2000 writes — may slightly exceed; if so, Workers Paid ($5/month) gives 1M writes/month.

**Q: How do I run it locally?**
A: Create `.dev.vars` (gitignored) mirroring all four required secrets, then `npx wrangler dev`.

**Q: Why does a guest who sends 6+ messages within 60 seconds only see the first 5 reach the admin?**
A: Rate limiting. Per-guest cap is 5 per 60s; excess is silently dropped (no feedback to attackers).

---

## Development

```bash
npm install           # install dependencies
npm run typecheck     # tsc type check
npm test              # run the test suite (vitest + @cloudflare/vitest-pool-workers, fully offline)
npm run test:watch    # tests in watch mode
npm run dev           # local wrangler dev
npm run deploy        # deploy to Cloudflare
```

Tests live under `tests/unit/` (pure functions) and `tests/integration/` (webhook, tenant isolation, manager commands).

---

## Acknowledgments

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — the single-tenant single-file version this was forked from
- Cloudflare Workers + KV — making lightweight zero-ops bot platforms possible

## License

Inherited from upstream — see [LICENSE](LICENSE).
