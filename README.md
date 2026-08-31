# bb-plugin-discord

Control BB agent threads from Discord. Mention the bot in a channel to open a dedicated Discord session thread, continue there without repeated mentions, answer supported BB interactions, and receive per-turn lifecycle updates. With full server access granted, BB can also administer the paired Discord server.

## Setup

Pair the bot from BB's UI—no terminal or Discord IDs required.

### 1. Create the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot.
2. On the Bot page, copy/reset the token and enable **Message Content Intent**. **Server Members Intent** is optional — enable it on the application only if you want member listing. The bridge uses Discord's REST member-list endpoint and does not request member events in its gateway connection.
3. Open BB → Settings → Plugins → Discord and paste the token.

### 2. Pair from BB

The **Discord connection** panel shows the gateway state and bot name, then walks you through the rest:

1. Select **Open Discord invite** and add the bot to your server.
2. Copy the pairing command shown in BB.
3. Send that command in the Discord channel you want to use.

The code is single-use and expires after ten minutes. The panel updates as soon as Discord accepts it, showing the paired server, home channel, and authorized user. It also provides a confirmation-backed unpair action.

The default `messages` invite includes **Create Public Threads** and **Send Messages in Threads**, which the session model requires. If the bot was invited before those permissions were added to its role, open the invite link again after saving the desired access level.

### Terminal alternative

The existing CLI flow remains available:

```sh
bb discord pair
bb discord invite
```

Send the printed command in Discord:

```text
<@123456789012345678> pair ABC-123
```

BB fills in the bot's actual user id. Copy the command exactly as printed;
Discord resolves the raw `<@BOT_USER_ID>` syntax as a real bot mention.

The bot confirms the server, authorized user, and home channel. No Developer Mode or copied snowflake IDs are needed.

The code is generated in BB and consumed in Discord, so a server cannot claim your bot by talking to it first. While unpaired, the bot ignores every message that is not a mention carrying a valid code.

```sh
bb discord status     # connection, pairing, access level, recent threads
bb discord allow <id> # authorize another Discord user
bb discord unpair     # forget the server and every allowed user
```

`bb discord status` reports that pairing is pending but deliberately omits the live code. Use the explicit `bb discord pair` operator command to reveal it. If you previously configured the advanced guild and user ID settings, the UI and CLI unpair actions clear plugin-owned users and conversation mappings but cannot edit those settings; both surfaces tell you which fields to clear to finish revoking access.

## Security boundary

This plugin can start agent work on the machine that runs BB. Treat access like shell access:

- Pairing requires a code that only appears inside BB.
- Only the paired guild is accepted; only paired and explicitly allowed users can drive BB.
- New conversations require an explicit bot mention.
- Discord-started BB threads run in `auto` — BB checks in before anything risky — unless you choose otherwise. A machine whose permission ceiling is lower lowers the thread further.
- The bot token is a secret setting stored in BB's permission-restricted plugin secrets directory and is never exposed to the frontend.
- Prompts are capped at 8,000 characters and Discord message IDs are deduplicated.
- Discord-started threads use your personal project unless you pick a default project. There is deliberately no "first available project" fallback.

## Settings

| Setting | Required | Purpose |
|---|---:|---|
| Discord bot token | Yes | Gateway authentication; stored as a secret. Everything else is discovered or optional. |
| Permission mode for Discord threads | No | Defaults to `auto`. `project-default` inherits the project's mode. |
| Discord server access | No | `messages` (default) or `full`. See below. |
| Allow destructive server actions | No | Off by default, and inert until server access is `full`. Changing it never changes server access. |
| Project for Discord threads | No | Which checkout the agent gets. Defaults to your personal project. |
| Machine for Discord threads | No | Which enrolled machine runs the thread. Choose it from the **Machine** list in the Configuration panel rather than typing an id. Empty follows the project default. |
| Provider for Discord threads | No | Only read when a model is set; the **Model** list sets it for you. Empty uses the project's default provider. |
| Model for Discord threads | No | Choose it from the **Model** list in the Configuration panel, which offers only what the selected machine can serve. Empty uses the project's default model. |
| Only start conversations in this channel | No | Empty means the bot can open new conversations anywhere in the paired server. Existing conversation threads always keep working. |
| Home channel for status and alerts | No | Empty sends them to the channel the pairing command ran in. The Configuration panel shows which channel that is. |
| Advanced: server (guild) ID | No | Pin a server by hand instead of pairing. Pairing normally fills this in, and the Configuration panel shows the value even when the field is empty. |
| Advanced: additional Discord user IDs | No | Extra allowlist entries; `bb discord allow` is easier. |

### Where Discord requests run

Project, machine and model are one decision, not three. The project decides the
checkout, the machine decides the computer, and **the model catalog belongs to
the machine** — a provider signed in on your laptop is not signed in on a build
box. So a saved model can stop being valid without this form changing.

Pick the machine and model from the two lists in **Settings → Plugins → Discord
→ Configuration**. Both offer *Automatic — project default* alongside your live
machines and the models that machine's signed-in providers actually report, so
there is no id to type and no invalid pair to choose. Changing the machine
resets the model to Automatic, because the model list belongs to the machine;
the panel says so rather than silently picking a different model for you. The
server re-checks whatever the panel posts against the catalog it just read, so a
list that went stale between render and click is refused rather than saved.

Resolution happens again on every Discord request rather than trusting what was
saved. A pinned model the machine cannot serve, **a project-default model that
machine does not offer**, an offline machine, or a project with no checkout
there is refused with a message naming what to change — never quietly swapped
for something else. The Configuration panel runs the same check continuously, so
a combination that has gone stale shows up there before a Discord request hits
it.

Leave all three empty and behaviour is unchanged: the personal project, the
project's default host, and the project's default provider and model.

## Usage

Start a conversation by mentioning the bot anywhere in the paired server:

```text
@bb inspect the failing login tests
```

The bot creates a Discord thread named from that request and links a new BB thread to it. The initiating mention gets a 🚀 reaction once the session is established. Continue inside the Discord thread: every message from an allowlisted user is forwarded without another mention, and BB's replies and interaction prompts return there.

The parent channel remains ordinary Discord space. Unmentioned messages there are ignored completely — they are not forwarded and receive no reaction. Mention the bot again in the parent channel whenever you want a separate session.

Upgrades preserve older channel-bound mappings. Their channel chatter becomes mention-only immediately; lifecycle output continues in that original channel until the next explicit mention moves the existing BB conversation into a newly named Discord thread.

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

## Controlling the Discord server from BB

Once paired, BB threads get Discord tools. The access level is a setting, not a hardcoded limit.

**`messages` (default)** — messages and threads only:

| Tool | Does |
|---|---|
| `discord_server_info` | Summarize the paired server. |
| `discord_list_channels` | List channels with ids, types, categories, topics. |
| `discord_read_channel` | Read recent messages from a channel or thread. |
| `discord_send_message` | Post to any channel or thread. |
| `discord_create_thread` | Open a thread under a text channel. |

**`full`** — adds server administration:

| Tool | Does |
|---|---|
| `discord_list_roles` | List roles by position. |
| `discord_list_members` | List members over REST (needs Server Members Intent enabled for the application, but no member gateway intent). |
| `discord_create_channel` | Create text/voice/category/announcement/forum/stage channels. |
| `discord_edit_channel` | Rename, retopic, or set slowmode. |
| `discord_manage_member_role` | Add or remove a role on a member. |

**Destructive actions**, behind `full` *and* the separate "Allow destructive server actions" toggle:

| Tool | Does |
|---|---|
| `discord_delete_channel` | Permanently delete a channel and its history. |
| `discord_moderate_member` | Kick, ban, or time out a member. |

Destructive tools also require the model to pass an explicit `confirm` flag and are instructed to get your go-ahead in the thread first. Every administrative call writes the originating BB thread id into the Discord audit log.

Re-invite the bot with `bb discord invite --full` after raising the access level, otherwise Discord itself will refuse the new operations.

## Failure handling

Configuration mistakes surface as sentences, not stack traces:

- **Bad token** — "Discord rejected the bot token…" and the bridge stops retrying until you change it.
- **Message Content Intent off** — Discord refuses the connection with `4014`; the plugin names the exact toggle to flip. If content still arrives empty, it warns once in the home channel.
- **Server Members Intent off** — only the REST-backed `discord_list_members` call fails, and it says to enable the privileged intent for the application on the Developer Portal's Bot page. The gateway deliberately does not identify with `GuildMembers`; every other tool keeps working.
- **Missing bot permissions** — reported as a permission problem with a pointer to the invite link in the connection panel, and sends are not retried into a rate limit.
- **Network drops** — exponential backoff from 2s to a 60s ceiling; discord.js resumes the session itself.

Saving a new token reconnects the gateway on its own — no `bb plugin reload discord`.

BB's `needs-configuration` badge is used for standing token and gateway-intent configuration failures. Pairing and connection state stays live in the Discord connection panel through realtime invalidations and RPC refreshes, with a slow safety refresh after missed signals.

## Development and verification

```sh
npm install
npm run check
```

`npm run check` typechecks against the vendored declarations, runs the bridge, pairing, and tool-gating tests, verifies that declarations match the installed BB SDK, and produces the plugin artifacts.

Install or reload the local checkout with:

```sh
bb plugin install .
bb plugin reload discord
bb plugin list
bb plugin logs discord -n 100
```

The Gateway connection runs as a supervised `bb.background.service`. Discord.js handles gateway reconnects, and outbound message chunks receive bounded retries. Deduplication state, pairing, and Discord-session ↔ BB-thread mappings are stored in the plugin SQLite database.

## Current scope

- Each bot mention in a normal channel opens a separate Discord session thread mapped to one BB thread.
- One paired guild with one or more allowlisted users.
- Replies are per turn, not token-streamed.
- Plain text and approval/question interactions are bridged; multiple simultaneous interactions must be resolved in BB.
- Per-channel project routing is not implemented yet; all Discord threads use one project.
