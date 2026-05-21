# feishu-codex-bridge

A local Feishu / Lark bot that lets you talk to Codex CLI from chat. The bridge handles messaging, sessions, attachments, cards, and process lifecycle; Codex still runs on your machine.

This project is built with reference to [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge), with thanks for the original design and implementation.

[中文 README](./README.zh.md)

## Runtime Model

The bridge is not a hosted agent service. It keeps a local long-lived bot process and turns chat messages into local Codex runs:

```text
Feishu/Lark chat
  -> bridge WebSocket
  -> local codex exec / resume
  -> optional lark-cli calls
  -> streaming card / text reply
```

Responsibilities are intentionally split:

- **bridge** receives events, maps chats to sessions, downloads attachments, renders cards, and keeps the bot alive.
- **Codex CLI** reasons, edits files, runs commands, and resumes Codex sessions.
- **Lark CLI** gives Codex a practical API tool for messages, docs, calendars, groups, OAuth, and other Lark resources.

Important: **the bridge and `lark-cli` must use the same Feishu / Lark app**. Do not create a second app for `lark-cli`; otherwise bot identity, permissions, OAuth, and API calls are split across apps.

## Capabilities

- DM the bot directly; in groups and topic groups the default policy is “respond only when mentioned”.
- Per-chat and per-topic Codex sessions, with `/new` reset and `/resume` recovery.
- Workspace control through `/cd` and `/ws`.
- Image and file attachments are downloaded locally and passed to Codex.
- Streaming markdown/card replies show final text and optional tool-call blocks.
- `/config` controls reply mode, tool visibility, concurrency, idle timeout, group mention policy, access control, and Codex reasoning effort.
- `lark-cli` onboarding is mandatory and uses a bridge-managed private install.
- macOS `launchd` service support for background operation.

## Quick Start

### 1. Requirements

You need:

- Node.js >= 20
- `codex` CLI installed and logged in
- A Feishu / Lark PersonalAgent app; the first-run QR wizard can create or select one

You do not need to preinstall `lark-cli`. `start` installs it into:

```bash
~/.feishu-codex-bridge/lark-cli
```

This avoids `/usr/local` permission issues on managed company machines. At runtime the bridge prepends this private bin directory to its own and Codex subprocess `PATH`:

```bash
~/.feishu-codex-bridge/lark-cli/node_modules/.bin
```

### 2. Install And Start

With a published package:

```bash
npm i -g feishu-codex-bridge
# or
pnpm add -g feishu-codex-bridge
```

Then start:

```bash
feishu-codex-bridge start
```

For local source validation:

```bash
cd /Users/bytedance/Documents/feishu-codex-bridge
corepack pnpm install
corepack pnpm start
```

Or:

```bash
node bin/feishu-codex-bridge.mjs start
```

First-run flow:

1. Scan a QR code and create or select a PersonalAgent app.
2. Save credentials under `~/.feishu-codex-bridge/config.json`; App Secret is moved to the encrypted local keystore.
3. Install `lark-cli` into the bridge private directory when missing.
4. Initialize `lark-cli` with the same App ID / App Secret, without creating a second app.
5. Detect same-app bridge processes before connecting, so multiple WebSocket connections do not race for events.

### 3. Confirm Platform Settings

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

### 4. Verify

Check local setup:

```bash
node bin/feishu-codex-bridge.mjs doctor
```

Expected:

- bridge config points to the current App ID
- Codex CLI is available
- `lark-cli` is installed
- `lark-cli` App ID matches the bridge App ID

Then DM the bot:

```text
/status
hi
```

User OAuth is only needed when Codex must access personal resources such as your own chat history, docs, or calendar:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

Bot identity being ready does not mean user OAuth is complete. Tenant/bot APIs can work with bot identity; personal resources usually require user OAuth.

## Background Service

On macOS, use `launchd`:

```bash
node bin/feishu-codex-bridge.mjs service install launchd
node bin/feishu-codex-bridge.mjs service status
node bin/feishu-codex-bridge.mjs service logs --follow
```

Restart or uninstall:

```bash
node bin/feishu-codex-bridge.mjs service restart
node bin/feishu-codex-bridge.mjs service uninstall
```

Run `start` once in the foreground before installing or restarting the service, so QR setup, private `lark-cli` install, and same-app binding can complete interactively.

Service logs:

- `~/.feishu-codex-bridge/service.log`
- `~/.feishu-codex-bridge/service.err.log`

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

## Configuration

Important files:

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
node bin/feishu-codex-bridge.mjs ps
node bin/feishu-codex-bridge.mjs service status
```

Follow logs:

```bash
node bin/feishu-codex-bridge.mjs service logs --follow
```

**Codex cannot find `lark-cli`**

Run:

```bash
node bin/feishu-codex-bridge.mjs doctor
```

For direct terminal usage:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

**`lark-cli` App ID differs from the bridge App ID**

Run foreground onboarding again:

```bash
node bin/feishu-codex-bridge.mjs start
```

Accept the prompt to switch `lark-cli` back to the bridge app. Do not run `lark-cli config init --new`.

**Codex run hangs**

Send `/stop` in chat. For recurring hangs, set a global idle timeout in `/config`, or set one for the current session:

```text
/timeout 10
```

## Source Validation And Local Changes

You can skip this section when using the published package. These commands are for local source changes, validation, and release preparation.

```bash
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

## License

[MIT](./LICENSE)
