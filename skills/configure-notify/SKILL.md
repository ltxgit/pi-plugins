---
name: configure-notify
description: >
  Configure Pi notification settings in ~/.pi/agent/notify.json — platforms
  (native, Gotify, Telegram, ntfy), events, silence window, and re-notification.
---

# Configure Notify

Configure the notify extension from `@ltxgit/pi-plugins`.

## Config file

All configuration is stored in a single file:

```text
~/.pi/agent/notify.json
```

Changes to `~/.pi/agent/notify.json` take effect immediately on the next event without requiring `/reload`.

## Full schema and defaults

```json
{
  "defaultPlatforms": ["native"],
  "events": {
    "agent_settled": { "enabled": true, "platforms": [] },
    "agent_end": { "enabled": false, "platforms": [] },
    "input_needed": { "enabled": true, "platforms": [] },
    "ask_user_prompt": { "enabled": true, "platforms": [] },
    "permission_request": { "enabled": true, "platforms": [] },
    "session_shutdown": { "enabled": false, "platforms": [] }
  },
  "native": {
    "enabled": true,
    "suppressWhenFocused": false
  },
  "gotify": {
    "enabled": false,
    "serverUrl": "https://gotify.example.com",
    "appToken": "AT_xxxxx",
    "priority": 5
  },
  "telegram": {
    "enabled": false,
    "botToken": "123456:ABC-DEF",
    "chatId": "987654321"
  },
  "ntfy": {
    "enabled": false,
    "serverUrl": "https://ntfy.sh",
    "topic": "my-pi-alerts",
    "token": "tk_optional",
    "priority": 3
  },
  "recap": {
    "enabled": false,
    "model": "openrouter/openai/gpt-oss-20b",
    "disableThinking": false
  },
  "silenceAfterInput": {
    "enabled": false,
    "windowMs": 10000,
    "platforms": ["native"]
  },
  "renotify": {
    "enabled": true,
    "intervalMs": 120000,
    "maxRepeats": 3
  }
}
```

## Slash commands

| Command | Description |
|---|---|
| `/notify:status` | Display current platform and event status |
| `/notify:test` | Send a test notification to all enabled platforms |
| `/notify:event <event> <on\|off>` | Toggle a specific event on or off |
| `/notify:setup-gotify` | Interactive Gotify setup wizard |
| `/notify:setup-telegram` | Interactive Telegram bot setup wizard |
| `/notify:setup-ntfy` | Interactive ntfy setup wizard |

## Validation rules

- `gotify`: `serverUrl` and `appToken` are required when `enabled: true`; `priority` is `1`–`10`.
- `telegram`: `botToken` and `chatId` are required when `enabled: true`.
- `ntfy`: `serverUrl` and `topic` are required when `enabled: true`; `priority` is `1`–`5`.
- `events.<key>.platforms`: empty array `[]` uses all enabled platforms (or `defaultPlatforms`).
- `renotify.intervalMs`: number `>= 10000` (default `120000`).
- `renotify.maxRepeats`: integer `>= 0` (default `3`).
