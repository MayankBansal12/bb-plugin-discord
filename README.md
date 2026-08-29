# bb-plugin-discord

Control BB agent threads from Discord. Mention the bot to create a linked BB thread, continue chatting in the same Discord channel without repeated mentions, answer supported BB interactions, and receive per-turn lifecycle updates.

## Security boundary

This plugin can start agent work on the machine that runs BB. Treat access like shell access:

- A required Discord user-ID allowlist limits control to explicitly trusted accounts.
- A guild allowlist rejects every other Discord server.
- New conversations require an explicit bot mention.
- An optional spawn channel limits where new conversations may begin; its child threads are accepted.
- The bot token is a secret setting stored in BB's permission-restricted plugin secrets directory and is never exposed to the frontend.
- Prompts are capped at 8,000 characters and Discord message IDs are deduplicated.

The spawned thread uses the selected BB project's provider, model, reasoning, service-tier, and permission defaults. Review those defaults before enabling Discord control.

## Setup

### 1. Create and invite the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot.
2. On the Bot page, copy/reset the token and enable **Message Content Intent**. Server Members Intent is not required.
3. In OAuth2 → URL Generator, select the `bot` scope and grant:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Add Reactions
4. Invite the bot to the intended Discord server.

### 2. Configure BB

Open BB → Settings → Plugins → Discord and set:

| Setting | Required | Purpose |
|---|---:|---|
| Discord bot token | Yes | Gateway authentication; stored as a secret. |
| Allowed server (guild) ID | Yes | The only Discord server accepted. |
| Allowed Discord user IDs | Yes | Comma- or space-separated users allowed to control BB. |
| Home channel ID | No | Online notices and failure alerts. |
| Spawn channel ID | No | Restricts new conversations to this channel and its threads. |
| Default BB project | No | Project used for new threads; otherwise the personal/first available project is used. |

Enable Discord Developer Mode and use **Copy ID** to obtain guild, channel, and user IDs. Then reload:

```sh
bb plugin reload discord
bb discord status
```

## Usage

Start a conversation by mentioning the bot:

```text
@bb inspect the failing login tests
```

Once linked, every message from an allowlisted user in that Discord channel is forwarded as a follow-up without another mention. BB's final response for each turn is sent back to the channel.

When BB asks one question, reply normally. For several questions, reply with numbered lines:

```text
1: feature/discord
2: run the full suite
```

For approvals, reply with one of:

```text
approve
approve session
deny
```

Only decisions offered by BB are accepted. If several interactions are pending simultaneously, the bot asks you to resolve them in BB to avoid ambiguity.

## Development and verification

```sh
npm install
npm run check
```

`npm run check` typechecks against the vendored declarations, runs the bridge logic tests, verifies that declarations match the installed BB SDK, and produces the plugin artifacts.

Install or reload the local checkout with:

```sh
bb plugin install .
bb plugin reload discord
bb plugin list
bb plugin logs discord -n 100
```

The Gateway connection runs as a supervised `bb.background.service`. Discord.js handles gateway reconnects, and outbound message chunks receive bounded retries. Deduplication state and channel ↔ BB-thread mappings are stored in the plugin SQLite database.

## Current scope

- One Discord channel/thread maps to one BB thread.
- One configured guild with one or more allowlisted users.
- Replies are per turn, not token-streamed.
- Plain text and approval/question interactions are bridged; multiple simultaneous interactions must be resolved in BB.
