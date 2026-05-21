# feishu-codex-bridge

在飞书 / Lark 里调用本机 Codex CLI 的个人 bot。用户在飞书里发消息，bridge 在你的电脑上调用 `codex exec`，把结果流式回到飞书。

本项目参考 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) 制作，感谢原项目的设计和实现启发。

[English README](./README.md)

## 安装

```bash
npm i -g feishu-codex-bridge
feishu-codex-bridge start
```

## 使用

首次启动会进入 onboarding：

1. 终端显示二维码，用飞书 / Lark 扫码。
2. 创建或选择一个 PersonalAgent 应用。
3. bridge 保存应用配置，并把 App Secret 放进本地加密 keystore。
4. bridge 检查 `lark-cli`，没有就安装到 `~/.feishu-codex-bridge/lark-cli`。
5. bridge 用同一个 App ID 初始化 `lark-cli`，不会为 `lark-cli` 新建第二个应用。

启动成功后，在飞书私聊 bot：

```text
/status
帮我看一下这个项目
```

`/status` 是启动后的快速自检，用来看当前 cwd、Codex session、agent 和 reasoning effort。普通文本消息会交给 Codex 处理。

群聊和话题群默认需要 `@bot` 才会响应。

bridge 本地启动一个长连接 bot，把每条飞书消息转成一次本机 Codex 调用：

```text
Feishu/Lark chat
  -> bridge WebSocket
  -> local codex exec / resume
  -> optional lark-cli calls
  -> streaming card / text reply
```

三层能力各自分工：

- **bridge**：收发消息、会话映射、卡片流式更新、附件下载、后台常驻。
- **Codex CLI**：理解用户意图、读写本机项目、执行命令、延续 Codex session。
- **Lark CLI**：让 Codex 访问飞书 API，例如消息、云文档、日历、群管理和 OAuth。

## 前置条件

需要：

- Node.js >= 20
- 本机已安装并登录 `codex` CLI
- 一个飞书 / Lark PersonalAgent 应用，首次启动时可以扫码创建

不需要提前安装 `lark-cli`。bridge 会安装到自己的私有目录，避免公司电脑没有 `/usr/local` 写权限的问题：

```bash
~/.feishu-codex-bridge/lark-cli
```

如果你想在普通 Terminal 里直接使用 `lark-cli`，手动加 PATH：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

## 开放平台配置

扫码向导能创建应用，但开放平台里仍需要确认权限和事件。

权限 scope：

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat`，创建群需要
- `drive:drive`，云文档评论需要

事件订阅，使用长连接模式：

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`，云文档 `@bot` 需要
- `im.message.reaction.created_v1` / `deleted_v1`，可选
- `im.chat.member.bot.added_v1`，可选

如果要让 Codex 访问你的个人聊天记录、日历、云文档等用户资源，再做用户 OAuth：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

bot 身份可用不等于用户 OAuth 已完成。很多租户级 API 可以用 bot 身份；读“我的”个人资源通常需要用户 OAuth。

## 能做什么

- 私聊直接对话；群和话题群默认需要 `@bot`。
- 每个 chat / 话题独立 Codex session，可 `/new` 重置、`/resume` 恢复。
- `/cd` 和 `/ws` 管理工作目录，让 Codex 在指定项目里工作。
- 图片和文件会下载到本机缓存后传给 Codex。
- 流式消息卡片展示 Codex 回复和工具调用过程。
- `/config` 可调整回复方式、工具调用显示、并发、idle timeout、群 @ 策略、访问控制、Codex reasoning effort。
- 支持 macOS `launchd` 后台常驻。

## 飞书命令

| 命令 | 作用 |
|---|---|
| `/status` | 查看当前 cwd、session、agent、reasoning effort |
| `/new` / `/reset` | 重置当前 chat 的 Codex session |
| `/resume [N]` | 列出并恢复当前 cwd 下的历史 Codex session |
| `/cd <path>` | 切换当前 chat 的工作目录，并重置 session |
| `/ws list/save/use/remove` | 管理命名工作空间 |
| `/config` | 调整回复、工具显示、并发、timeout、reasoning effort、访问控制 |
| `/timeout [N|off|default]` | 当前 session 的 idle timeout 覆盖 |
| `/stop` | 停止当前正在跑的 Codex 任务 |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id|#>` | 关闭指定 bridge 进程 |
| `/reconnect` | 重连飞书 WebSocket |
| `/doctor [描述]` | 把近期 bridge 日志交给 Codex 做故障诊断 |
| `/account` | 查看或更换 bridge 使用的飞书应用 |
| `/help` | 查看帮助卡片 |

## 后台常驻

先前台跑一次 `start`，完成扫码、`lark-cli` 安装和同应用绑定。然后安装 macOS `launchd` 服务：

```bash
feishu-codex-bridge service install launchd
feishu-codex-bridge service status
feishu-codex-bridge service logs --follow
```

重启和卸载：

```bash
feishu-codex-bridge service restart
feishu-codex-bridge service uninstall
```

服务日志：

- `~/.feishu-codex-bridge/service.log`
- `~/.feishu-codex-bridge/service.err.log`

## 重要约束

bridge 和 `lark-cli` **必须使用同一个飞书 / Lark 应用**。不要为 `lark-cli` 运行：

```bash
lark-cli config init --new
```

否则 bot 收消息、API 权限、OAuth 用户身份会落到不同 app 上，后面很难查问题。正确做法是让 bridge onboarding 用当前 App ID 初始化 `lark-cli`。

## 配置文件

| 路径 | 内容 |
|---|---|
| `~/.feishu-codex-bridge/config.json` | bridge 应用配置和偏好 |
| `~/.feishu-codex-bridge/secrets.enc` | 加密保存的 App Secret |
| `~/.feishu-codex-bridge/sessions.json` | chat / 话题到 Codex session 的映射 |
| `~/.feishu-codex-bridge/workspaces.json` | 命名工作空间 |
| `~/.feishu-codex-bridge/processes.json` | 正在运行的 bridge 进程注册表 |
| `~/.feishu-codex-bridge/lark-cli/` | bridge 私有安装的 Lark CLI |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | bridge 结构化运行日志 |
| `~/.feishu-codex-bridge/media/<chatId>/` | 下载的图片和文件缓存，24h 清理 |

### Codex reasoning effort

默认不覆盖 Codex CLI 全局配置，继承 `~/.codex/config.toml` 里的 `model_reasoning_effort`。

如果只想固定 bridge 的调用强度，可以在飞书 `/config` 里设置 **Codex reasoning effort**，或直接改：

```json
{
  "preferences": {
    "codexReasoningEffort": "xhigh"
  }
}
```

支持值：`minimal`、`low`、`medium`、`high`、`xhigh`。恢复继承全局配置时，在 `/config` 里选默认，或删除该字段。

### 访问控制

默认是开放模式：能找到 bot 的人可以私聊，群里 `@bot` 可以触发。需要收紧时，在 `/config` 里配置：

- `allowedUsers`：允许交互的用户 `open_id` 列表。
- `allowedChats`：允许响应的群 `chat_id` 列表，私聊不受它限制。
- `admins`：允许执行 `/account`、`/config`、`/exit`、`/reconnect`、`/doctor`、`/cd`、`/ws` 的用户。

找 `open_id` / `chat_id`：

```bash
grep '"event":"enter"' ~/.feishu-codex-bridge/logs/$(date +%Y-%m-%d).log | tail -5
```

## 故障排查

**bot 没反应**

先查服务是否在跑：

```bash
feishu-codex-bridge ps
feishu-codex-bridge service status
```

再查日志：

```bash
feishu-codex-bridge service logs --follow
```

**Codex 说找不到 `lark-cli`**

先跑：

```bash
feishu-codex-bridge doctor
```

如果普通 Terminal 里要直接用 `lark-cli`：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

**`lark-cli` App ID 和 bridge 不一致**

重新前台跑：

```bash
feishu-codex-bridge start
```

按提示切换到 bridge 当前应用。不要运行 `lark-cli config init --new`。

**Codex 卡住**

可以在飞书发 `/stop`。长期使用建议在 `/config` 设置全局 run idle timeout，或对当前 session 使用：

```text
/timeout 10
```

## License

[MIT](./LICENSE)
