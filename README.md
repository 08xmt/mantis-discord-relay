# Mantis Discord relay

A thin Discord bot for [Mantis](https://mantis.inverse.finance) triage. It creates one thread per submission, accepts `/reply`, `/note`, `/status`, and `/open` from an allowlist, and shows an exact-text preview with Send and Cancel. It holds **no Mantis credential and no Mantis logic**.

Mantis Triage (a separate assistant) polls Mantis and calls this bot's signed HTTP API to post into threads. When someone presses Send, this bot posts a signed `{payload, sig}` envelope to Triage's webhook. Triage performs the one Mantis call and posts the outcome back.

The product spec is in [`docs/spec.md`](docs/spec.md). Threat-model notes and rotation steps are in [`docs/runbook.md`](docs/runbook.md).

## What runs where

| Piece | Where it lives |
|---|---|
| Threads, slash commands, previews, SQLite, Discord token | This process |
| Relay HMAC verification (`RELAY_HMAC_SECRET`) | This process |
| Action HMAC signing (`ACTION_HMAC_SECRET`) | This process |
| Mantis reads and writes, action verification, nonce ledger | Mantis Triage, using [`triage/`](triage/) |

Compromising the Discord host does not yield a Mantis token. Compromising Triage does not yield the Discord token, as long as posting goes through the relay (Option B in the spec).

## Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot** and create a token. Store it as `DISCORD_BOT_TOKEN`. Leave **Message Content Intent**, **Server Members Intent**, and **Presence Intent** off. The bot only uses the `Guilds` intent.
3. Invite it to the staff server with the `bot` and `applications.commands` scopes and these permissions:
   - View Channel
   - Send Messages
   - Read Message History
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads

   Invite URL (replace the client id; the permission integer is `326417583104`):

   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=326417583104&scope=bot%20applications.commands
   ```

4. Create a **private** staff channel (text or forum). Submission threads are created there, and confirmed action text is posted into those threads, so the channel must not be visible to hunters. Copy the server id, channel id, audit channel id, admin channel id, and the Discord user ids of the people who may act. Enable Developer Mode, then right-click to copy ids.

The bot registers guild slash commands on startup. Plain chat in a thread is never relayed.

## Configure

```sh
cp .env.example .env
```

Fill `.env` from your secret store. `.env` is gitignored. `.env.example` contains placeholders only.

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token. Never logged. |
| `DISCORD_GUILD_ID` | Server snowflake. |
| `DISCORD_CHANNEL_ID` | Private text or forum channel that parents the threads. |
| `DISCORD_AUDIT_CHANNEL_ID` | Private channel that mirrors the audit log. Optional. |
| `DISCORD_ADMIN_CHANNEL_ID` | Heartbeats, signature bursts, hash mismatches. Optional. |
| `ALLOWLIST_USER_IDS` | Comma-separated Discord user snowflakes. Empty means nobody can act. Triage keeps its own copy and checks again. |
| `ACTION_WEBHOOK_URL` | Grok Bot webhook for the Mantis-action routine. The path is a credential. Logs show the host only. |
| `ACTION_HMAC_SECRET` | 32+ character secret. The bot signs action envelopes with this value. `openssl rand -hex 32`. |
| `ACTION_HMAC_SECRET_NEXT` | Optional. Triage accepts it during rotation. The bot does not sign with it. |
| `RELAY_HMAC_SECRET` | Different secret. Triage signs relay calls; the bot verifies them. |
| `RELAY_HMAC_SECRET_NEXT` | Optional second relay key during rotation. |
| `RELAY_HOST` / `RELAY_PORT` | Relay bind address. Default `0.0.0.0:8787`. |
| `DATABASE_PATH` | SQLite file. Default `./data/bot.sqlite`. |
| `MANTIS_APP_URL` | Base URL used only to build "view in Mantis" links. Not a credential. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. |
| `HEARTBEAT_INTERVAL_MS` | Default 1 hour. |
| `DELIVERY_TIMEOUT_MS` | Per webhook attempt. Default 30 seconds. |

The HMAC key is the environment string as UTF-8. Both sides must use that same string. Placeholder values that start with `replace-with` are rejected at startup.

Put TLS in front of the relay (Caddy, a load balancer, or a Cloudflare Tunnel). Restrict the source IPs to Triage's egress when you can. The process itself speaks HTTP.

## Run

Requires Node.js 22.

```sh
npm install
npm test
npm run build
npm start
```

`npm run dev` runs TypeScript directly. Docker:

```sh
docker compose up --build -d
```

The container listens on port 8787 and stores SQLite on the `bot-data` volume (`DATABASE_PATH=/data/bot.sqlite`). Back up from inside the container with:

```sh
docker compose exec bot node dist/cli/backup.js /data/backups/bot.sqlite
```

Nightly backup:

```sh
./scripts/backup.sh data/backups
```

## Slash commands

All four commands work only inside a mapped submission thread, and only for allowlisted users. The check runs again when Send is pressed.

| Command | After Send | Hunter sees it? |
|---|---|---|
| `/reply` with `text`, or with no text to open a modal | `send_message` as the Mantis bot account | Yes |
| `/note` | `add_submission_note` | No |
| `/status` value plus an optional note | `update_submission_status` | Yes, status and note |
| `/open` | Fetch a flagged submission and post the summary | No |

`/reply` and `/status` previews include a red **Visible to the hunter** banner. Send and Cancel work only for the user who opened the preview. The preview expires after 5 minutes.

Send stores the action as `queued`, posts the signed envelope, and writes a public line in the thread:

```text
⏳ Queued by @user: `reply` (`<preview message id>`), confirming via Mantis, usually under a minute.
```

The preview message id is the idempotency key. Retries use a new nonce and timestamp and the same id. The webhook is tried once and then up to three more times, waiting 5 seconds, 30 seconds, and 2 minutes. If Triage has not posted an outcome within 3 minutes, the thread gets a warning and a **Retry** button.

Discord itself limits slash-command strings to 6000 characters and modal fields to 4000. The bot still rejects anything over 16,000 characters for a body and 4,000 for a status note.

Rate limit: 10 confirmed actions per user per 10 minutes, 30 total, and one in flight per submission.

## Relay API

Triage signs the raw JSON body:

```text
X-Relay-Timestamp: 2026-10-14T07:42:00Z
X-Relay-Nonce: <32 lowercase hex chars>
X-Relay-Signature: hex(HMAC-SHA256(RELAY_HMAC_SECRET, timestamp + "." + nonce + "." + rawBody))
```

`POST /v1/submissions`

```json
{
  "submission_id": "sub_123",
  "title": "Stored XSS",
  "severity_claim": "high",
  "status": "new",
  "summary_md": "...",
  "hunter_record_md": "...",
  "blocked": false,
  "hunter_label": "ada"
}
```

`hunter_label` is optional. The call is idempotent per `submission_id` and returns `{ "thread_id", "duplicate" }`. A `blocked: true` call creates a stub thread and does not include `summary_md`. A human later runs `/open`.

`POST /v1/submissions/{id}/messages`

```json
{
  "kind": "hunter_msg",
  "source_id": "mantis-message-id",
  "author_label": "ada",
  "body": "...",
  "created_at": "2026-10-14T07:40:00Z",
  "related_discord_message_id": "100000000000000101",
  "body_sha256": "<64 hex chars>",
  "outcome": "ok"
}
```

`kind` is `hunter_msg`, `followup`, `outcome`, or `status_change`. The call is idempotent per `source_id`. For outcomes, set `related_discord_message_id` to the preview message id, `body_sha256` to the hash of the text Triage sent, and `outcome` to `ok`, `failed`, or `unknown`. A hash that does not match the stored action raises an admin alert.

Unsigned, stale (outside ±10 minutes), or badly signed calls return 401. A reused nonce returns 401 `replay`. Unknown submissions return 404.

`GET /healthz` is unauthenticated and returns `{ "ok": true }`.

Everything the bot posts uses `allowed_mentions` with an empty parse list and `SUPPRESS_EMBEDS`. Untrusted text is code-fenced. Zero-width and bidi characters are stripped, `@everyone` / `@here` / user / role / channel mentions are broken up, and URLs are wrapped in `<>`. Bodies longer than 8,000 characters are truncated with a Mantis link. Messages are split under Discord's 2,000 character limit.

The action text stored for Mantis is the operator's original string. Sanitization applies to the Discord display only. The signed payload therefore still contains whatever the operator typed, and Triage must send that string verbatim.

## Action envelope

```json
{
  "payload": "<canonical JSON string>",
  "sig": "<hex HMAC-SHA256 of that exact string>"
}
```

Canonical key order is `v`, `submission_id`, `action`, `text`, then `status` only when the action is `status`, then `discord_user_id`, `discord_message_id`, `discord_thread_id`, `timestamp`, `nonce`. `timestamp` is UTC with a `Z` suffix and no milliseconds. `nonce` is 128 random bits as 32 hex characters.

```json
{"v":1,"submission_id":"sub_1","action":"reply","text":"hello","discord_user_id":"100000000000000021","discord_message_id":"100000000000000101","discord_thread_id":"100000000000000031","timestamp":"2026-10-14T07:42:00Z","nonce":"00112233445566778899aabbccddeeff"}
```

The receiving side verifies that exact string. Do not parse the payload and re-serialize it before the HMAC check. Use [`triage/verify_action.py`](triage/verify_action.py). The algorithm is also written up in [`docs/reference-verifier.md`](docs/reference-verifier.md).

```sh
ACTION_HMAC_SECRET=... ACTION_HMAC_SECRET_NEXT=... \
NONCE_LEDGER=$HOME/mantis-triage/nonces.json \
  python3 triage/verify_action.py < envelope.json
```

Triage's side of posting and state updates is [`triage/relay_client.py`](triage/relay_client.py) and [`triage/state.py`](triage/state.py). Paste [`triage/prompts/scheduled_routine.md`](triage/prompts/scheduled_routine.md) and [`triage/prompts/webhook_routine.md`](triage/prompts/webhook_routine.md) into the Grok Bot routines. Those prompts are not executed by this repository.

## Tests

```sh
npm test
npm run typecheck
```

The suite covers HMAC sign and verify (including the next secret, tampering, replay, and the timestamp window), the allowlist, SQLite idempotency for submissions and source ids across a reopened database, sanitization (mentions, hidden characters, URL wrapping, embed suppression), secret redaction, preview Send / double-click / Cancel / expiry, rate limits, and webhook retries that keep the same `discord_message_id`. A Python test checks that `verify_action.py` accepts an envelope produced by the TypeScript signer, and that `relay_client.py` can call the relay.

No test needs a live Discord token or a Mantis token.

## Phases

| Phase | State |
|---|---|
| 0. Discord app, Mantis bot account, secrets in a store | Operator work. This repo supplies `.env.example` and the setup above. |
| 1. Bot skeleton, SQLite, signed relay, sanitization, idempotency | Implemented and tested. |
| 2. Triage posting | `relay_client.py`, `state.py`, and the scheduled prompt are in `triage/`. The 10-minute poll runs inside Mantis Triage, not in this process. |
| 3. Inbound mirroring | The relay's message endpoint is idempotent per `source_id`. The poll loop is the scheduled prompt. |
| 4. Commands, preview, delivery, watchdog, audit, rate limits | Implemented and tested. |
| 5. Webhook routine | `verify_action.py` plus the webhook prompt. Wiring it to a live Mantis test org is an operator step. |
| 6. Hardening | Rotation and backup runbook, heartbeat, signature-burst alert, hash-mismatch alert. A live red-team pass still needs the test org. |

## Open questions

These are unresolved in the spec and are called out so the operator can decide:

1. Can the Grok Bot webhook restrict callers or expose headers, and how does it queue overlapping runs? The envelope signature does not depend on headers. Concurrency on Triage's files has to go through `flock`.
2. Option B (this relay) is what the code implements. Option A, putting the Discord token on Triage's box, is not implemented.
3. Should a reply be signed in Mantis with the Discord display name? The payload includes `discord_user_id` only. Triage can add a signature line if you want one; this bot does not append one.
4. If a hunter message does not bump `updatedAt`, the scheduled routine must sweep open threads. The bot does not poll Mantis, so it cannot compensate.
5. Critical-severity reports do not require a second teammate. One allowlisted Send is enough.
6. Mantis agent-token lifetime and the bot-account rotation runbook are outside this repo. HMAC rotation is in [`docs/runbook.md`](docs/runbook.md).
7. Threads are created in whatever channel `DISCORD_CHANNEL_ID` points at (text or forum). The bot does not archive on `closed` / `paid` / `rejected` / `duplicate`, and it does not backfill on first boot. Ask Triage to post existing open submissions once when you enable the schedule.

Also: the practical reply length is Discord's 6,000-character slash-command cap (4,000 in the modal), which is below the 16,000-character application limit.
