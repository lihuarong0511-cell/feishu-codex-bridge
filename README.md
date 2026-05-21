# feishu-codex-bridge

A local Feishu / Lark bot for calling Codex CLI from chat. Users send messages in Feishu / Lark; the bridge runs `codex exec` on your machine and streams the result back to chat.

This project is built with reference to [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge), with thanks for the original design and implementation.

[中文 README](./README.zh.md)

## Install

```bash
npm i -g feishu-codex-bridge
feishu-codex-bridge start
```

## Use

The first start runs onboarding:

1. Scan the QR code with Feishu / Lark.
2. Create or select a PersonalAgent app.
3. The bridge saves app config and moves the App Secret into a local encrypted keystore.
4. The bridge checks `lark-cli`; if missing, it installs it into `~/.feishu-codex-bridge/lark-cli`.
5. The bridge initializes `lark-cli` with the same App ID. It does not create a second app for `lark-cli`.

After startup, DM the bot:

```text
/status
Help me inspect this repo
```

`/status` is a quick health check. It shows the current cwd, Codex session, active agent, and reasoning effort. Regular messages are sent to Codex.

In groups and topic groups, the default policy is to respond only when mentioned.

The bridge keeps a local long-lived bot process and turns each chat message into a local Codex run:

```text
Feishu/Lark chat
  -> bridge WebSocket
  -> local codex exec / resume
  -> optional lark-cli calls
  -> streaming card / text reply
```

Responsibilities are split:

- **bridge** receives events, maps chats to sessions, downloads attachments, renders cards, and keeps the bot alive.
- **Codex CLI** reasons, edits files, runs commands, and resumes Codex sessions.
- **Lark CLI** gives Codex a practical API tool for messages, docs, calendars, groups, OAuth, and other Lark resources.

## Requirements

You need:

- Node.js >= 20
- `codex` CLI installed and logged in
- A Feishu / Lark PersonalAgent app; the first-run QR wizard can create one

You do not need to preinstall `lark-cli`. The bridge installs it into a private directory to avoid `/usr/local` permission issues on managed company machines:

```bash
~/.feishu-codex-bridge/lark-cli
```

For direct terminal usage:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

## Platform Settings

The QR wizard creates the app shell. You still need to confirm scopes and events in the developer console.

Permission scopes:

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat`, required for group creation
- `drive:drive`, required for cloud-doc comments

Event subscriptions, long-connection mode:

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`, required for cloud-doc `@bot` comments
- `im.message.reaction.created_v1` / `deleted_v1`, optional
- `im.chat.member.bot.added_v1`, optional

User OAuth is only needed when Codex must access personal resources such as your own chat history, docs, or calendar:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

Bot identity being ready does not mean user OAuth is complete. Tenant/bot APIs can work with bot identity; personal resources usually require user OAuth.

## Capabilities

- DM the bot directly; in groups and topic groups the default policy is “respond only when mentioned”.
- Per-chat and per-topic Codex sessions, with `/new` reset and `/resume` recovery.
- Workspace control through `/cd` and `/ws`.
- Image and file attachments are downloaded locally and passed to Codex.
- Streaming markdown/card replies show final text and optional tool-call blocks.
- `/config` controls reply mode, tool visibility, concurrency, idle timeout, group mention policy, access control, and Codex reasoning effort.
- macOS `launchd` service support for background operation.

## Chat Commands

| Command | Effect |
|---|---|
| `/status` | Show cwd, session, agent, and reasoning effort |
| `/new` / `/reset` | Reset the current chat’s Codex session |
| `/resume [N]` | List and resume recent Codex sessions under the current cwd |
| `/cd <path>` | Change cwd for the current chat and reset the session |
| `/ws list/save/use/remove` | Manage named workspaces |
| `/config` | Adjust reply mode, tools, concurrency, timeout, reasoning effort, access control |
| `/timeout [N|off|default]` | Override idle timeout for the current session |
| `/stop` | Stop the current Codex run |
| `/ps` | List bridge processes on this host |
| `/exit <id|#>` | Stop a bridge process |
| `/reconnect` | Reconnect the Feishu / Lark WebSocket |
| `/doctor [description]` | Ask Codex to diagnose recent bridge logs |
| `/account` | View or change the Feishu / Lark app used by the bridge |
| `/help` | Show the help card |

## Background Service

Run `start` once in the foreground so QR setup, private `lark-cli` install, and same-app binding can complete. Then install the macOS `launchd` service:

```bash
feishu-codex-bridge service install launchd
feishu-codex-bridge service status
feishu-codex-bridge service logs --follow
```

Restart or uninstall:

```bash
feishu-codex-bridge service restart
feishu-codex-bridge service uninstall
```

Service logs:

- `~/.feishu-codex-bridge/service.log`
- `~/.feishu-codex-bridge/service.err.log`

## Important Constraint

The bridge and `lark-cli` **must use the same Feishu / Lark app**. Do not run this for `lark-cli`:

```bash
lark-cli config init --new
```

Otherwise bot messages, API permissions, and OAuth identities are split across apps. Let bridge onboarding initialize `lark-cli` with the bridge App ID.

## Configuration Files

| Path | Purpose |
|---|---|
| `~/.feishu-codex-bridge/config.json` | Bridge app config and preferences |
| `~/.feishu-codex-bridge/secrets.enc` | Encrypted App Secret store |
| `~/.feishu-codex-bridge/sessions.json` | Chat/topic to Codex session mapping |
| `~/.feishu-codex-bridge/workspaces.json` | Named workspaces |
| `~/.feishu-codex-bridge/processes.json` | Live bridge process registry |
| `~/.feishu-codex-bridge/lark-cli/` | Bridge-managed private Lark CLI install |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | Structured runtime logs |
| `~/.feishu-codex-bridge/media/<chatId>/` | Downloaded image/file cache, cleaned after 24h |

### Codex Reasoning Effort

By default the bridge does not override Codex CLI reasoning effort. Codex inherits `model_reasoning_effort` from `~/.codex/config.toml`.

To pin it for bridge runs only, use `/config` in Feishu / Lark or edit:

```json
{
  "preferences": {
    "codexReasoningEffort": "xhigh"
  }
}
```

Allowed values: `minimal`, `low`, `medium`, `high`, `xhigh`. Remove the field, or select default in `/config`, to inherit the global Codex config again.

### Access Control

The default mode is open: anyone who can find the bot can DM it, and group users can mention it. Tighten this in `/config`:

- `allowedUsers`: open_id allowlist for interacting with the bot.
- `allowedChats`: group chat_id allowlist; DMs are not restricted by this field.
- `admins`: users allowed to run sensitive commands such as `/account`, `/config`, `/exit`, `/reconnect`, `/doctor`, `/cd`, and `/ws`.

Find IDs from logs:

```bash
grep '"event":"enter"' ~/.feishu-codex-bridge/logs/$(date +%Y-%m-%d).log | tail -5
```

## Common Fixes

**Bot is silent**

Check process and service state:

```bash
feishu-codex-bridge ps
feishu-codex-bridge service status
```

Follow logs:

```bash
feishu-codex-bridge service logs --follow
```

**Codex cannot find `lark-cli`**

Run:

```bash
feishu-codex-bridge doctor
```

For direct terminal usage:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

**`lark-cli` App ID differs from the bridge App ID**

Run foreground onboarding again:

```bash
feishu-codex-bridge start
```

Accept the prompt to switch `lark-cli` back to the bridge app. Do not run `lark-cli config init --new`.

**Codex run hangs**

Send `/stop` in chat. For recurring hangs, set a global idle timeout in `/config`, or set one for the current session:

```text
/timeout 10
```

## License

[MIT](./LICENSE)
