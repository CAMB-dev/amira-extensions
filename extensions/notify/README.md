# notify

Tells you when Amira needs you while you look elsewhere: a long turn ended, a question
waits for your answer, or background work (sub-agents, workflows, swarms) finished. On the
desktop, through a chat webhook (Telegram, Discord, WeCom), or both.

```sh
amira ext install notify
```

Needs Amira's extension API 0.1.2, whose `ui.focus` event says whether the terminal has focus:
it notifies only while the terminal is in the background. Where a frontend does not report
focus, it counts as unknown and notifies as if you were away.

## When it notifies

| Moment | Notification |
|---|---|
| A turn of the main session ran at least `longTurnSeconds` (30) and ended | `Done after 2m 05s` and the start of the reply, or `Failed after …` and the error. A turn you interrupt never notifies. |
| A question (a confirm, a choice, an approval, a form) is still open after `dialogDelaySeconds` (2) | `Waiting for your answer: <question>` |
| Background sub-agents, workflows or swarms of the main session ended | `◆ <title> finished (42s)`; several close together make one notification. While the main session is in a turn, or when their results start one (they usually do), they are told when that turn ends. |

By default (`"when": "unfocused"`) nothing is sent while the terminal has focus. The TUI
tells focus from the terminal's focus reports (Windows Terminal, VS Code, iTerm2, kitty,
WezTerm, most others); where the terminal never reports it, as in print mode, it notifies
as if you were away, except that a question then waits `longTurnSeconds` before it notifies
(many terminals report focus only once it changes, so right after starting it is unknown).
`"when": "always"` notifies either way. Sub-agents that run in the foreground, inside the
call that started them, are part of their turn and not told about on their own.

## Channels

- **Desktop** (on by default):
  - Windows: a toast, from Windows PowerShell 5.1 through the WinRT notification API, so
    nothing needs installing; where toasts are unavailable, a tray balloon.
  - macOS: Notification Center through `osascript`.
  - Linux and BSD: `notify-send` (libnotify).
- **Webhooks**, any number of them:

| `type` | Settings | Sends |
|---|---|---|
| `telegram` | `botTokenEnv`, and `chatId` or `chatIdEnv` | the bot's `sendMessage` to that chat |
| `discord` | `urlEnv`: a channel webhook URL | a message from "Amira", mentions off |
| `wecom` | `urlEnv` (the group robot's webhook URL) or `keyEnv` (its key) | a text message (企业微信群机器人) |
| `json` | `urlEnv`, optional `tokenEnv` (sent as `Authorization: Bearer …`) | `{"source": "amira", "kind", "title", "body", "at"}` as a POST |

Secrets never go into settings files: every URL and token is read from the environment
variable the settings name, when a notification is sent. A settings entry with a `url`,
`token`, `botToken` or `key` value, or a URL where an `…Env` name belongs, is refused (and
the value is not repeated in the error). Errors from a webhook have its URL and token taken
out.

Commands run through Amira's `runCommand`, and webhooks go straight to the URL you set,
with a 10 s timeout.

## Limits

At most `rateLimit.max` (5) notifications go out within `rateLimit.perSeconds` (60).
Those over the limit are held: the latest one goes out as soon as the limit allows, with a
count of the others. The same notification again within `dedupeSeconds` (30) is dropped.
A channel that fails is reported once (as an extension error) until it works again or fails
differently.

## Commands

- `/notify`: what is set up: whether it is on, the focus the terminal reported, the
  moments, the channels, and which environment variables are missing.
- `/notify test`: sends a test notification through every channel, ignoring focus, the
  limits and `/notify off`, and prints what each one did.
- `/notify off`, `/notify on`: mute and unmute for this session; the status bar shows
  `notify off` while muted.

## Settings

In `settings.json`, under `extensions.notify`:

```jsonc
{
  "extensions": {
    "notify": {
      "enabled": true,
      "when": "unfocused",           // or "always"
      "longTurnSeconds": 30,
      "dialogDelaySeconds": 2,       // 0: as soon as a question opens
      "events": { "turn": true, "dialog": true, "background": true },
      "preview": true,               // the start of the reply or question in the text
      "desktop": true,               // or false, or {"enabled": true, "when": "always"}
      "rateLimit": { "max": 5, "perSeconds": 60 },
      "dedupeSeconds": 30,
      "webhooks": [
        { "type": "telegram", "botTokenEnv": "AMIRA_TG_TOKEN", "chatId": "123456789" },
        { "type": "discord", "urlEnv": "AMIRA_DISCORD_WEBHOOK", "when": "always" },
        { "type": "wecom", "keyEnv": "AMIRA_WECOM_KEY" },
        { "type": "json", "urlEnv": "AMIRA_HOOK_URL", "tokenEnv": "AMIRA_HOOK_TOKEN" }
      ]
    }
  }
}
```

Each channel may set its own `when` (`desktop.when`, a webhook's `when`), e.g. the desktop
only while you are away but your phone always. `"preview": false` keeps replies and
questions out of the text, e.g. for a webhook to a shared chat.

## Tests

The tests run the extension on Amira's extension host with fake commands, a fake `fetch`
and a fake clock, so they need Amira's packages:

```sh
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
