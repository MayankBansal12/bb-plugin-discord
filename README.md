# bb-plugin-discord

Drive BB agent threads from a Discord server. One Discord thread ↔ one BB thread: you @bb to start a conversation, keep typing to chat, and the agent's replies come back into the same thread.

## What it does

- **Start a thread:** @bb with a prompt in a Discord thread/channel. The plugin spawns a BB thread and confirms with its ID and title.
- **Chat:** Reply in the same Discord thread. Each message is forwarded to the BB thread as a follow-up.
- **Replies:** When the BB agent goes idle, its reply is posted back into the Discord thread.
- **Questions & approvals:** If the agent needs input (a question, a command approval, a file-change approval), the bot posts the prompt in the thread. Reply to answer.
- **Lifecycle pings:** Failures and deletions are posted both in the originating thread and a home channel for visibility.

## Transport: Gateway bot

The plugin runs a Discord **Gateway** bot (via `discord.js`) as a `bb.background.service`. This is required for the chat loop — only the Gateway delivers message events, which slash-command webhooks cannot. The bot reconnects automatically on disconnect.

## Setup

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → New Application.
2. **Bot** tab → Reset Token → copy the token.
3. Enable **Message Content Intent** and **Server Members Intent** under Privileged Gateway Intents.
4. **OAuth2 → URL Generator**: scopes `bot`, permissions `Send Messages`, `Read Message History`, `Create Public Threads`, `Add Reactions`.
5. Invite the bot to your server with the generated URL.

### 2. Configure the plugin

In BB → Settings → Discord plugin:

| Setting | Purpose |
|---|---|
| **Discord bot token** | Secret — stored encrypted on disk, never shown again. |
| **Allowed server (guild) ID** | Only messages from this server are processed. |
| **Home channel ID** | Where lifecycle pings and reminders post. |
| **Spawn channel ID** *(optional)* | Restrict thread-starting to one channel. |
| **Default BB project** | Which BB project new threads spawn into. |

Get IDs with Discord's Developer Mode (right-click → Copy ID).

### 3. Reload

```
bb plugin reload discord
```

## Security model

- The bot token is a **secret setting** — stored in a `0600` file under `<dataDir>/plugins/discord/secrets/`, never in the database or sent to the frontend.
- **Guild allowlist:** the bot ignores every message from any server not in the allowlist.
- **Mention-gated:** the bot only acts on explicit @bb mentions. It does not read or log other messages.
- **Idempotency:** Discord message IDs are deduplicated in SQLite, so reconnect redelivery never double-processes a message.
- **Prompt-size limit:** prompts over 8000 chars are rejected before reaching BB.
- **Outbound retry:** Discord sends are wrapped with bounded retry/backoff.

## How it works

```
Discord @bb "fix the login bug"
  → bb.sdk.threads.spawn(...)         # new BB thread
  → store discord_channel ↔ bb_thread
  → confirm in Discord

Discord reply "also check the CSS"
  → bb.sdk.threads.send(...)          # follow-up to same thread

BB agent finishes turn (thread.idle)
  → lastAssistantText posted to Discord thread
  → interactions.list() checked for pending questions
  → if pending, bot posts "BB needs you: …"
```

## CLI

```
bb discord status   # list recent bridged threads
```

## Out of scope (v1)

- Multi-server / per-user auth
- Reminders and scheduled automations
- Streaming token-level progress (replies are per-turn, not live)
- Reply-to-thread appending from BB's side
