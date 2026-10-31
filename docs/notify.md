# Notify

Send notifications to your desktop or phone when Pi finishes a run or waits for your input.

## Features

- Four delivery platforms: **native OS** (macOS `osascript` / Windows / Linux `node-notifier`), **Gotify**, **Telegram**, and **ntfy**.
- Event-driven notifications for run completion (`agent_settled`) and blocking prompts (`input_needed`, `ask_user_prompt`, `permission_request`).
- Periodic re-notification reminders while a blocking prompt waits for your answer.
- Optional quiet window after keyboard input (`silenceAfterInput`).
- Optional one-sentence LLM summary of the final response (`recap`).
- Exposes the `notify_user` tool to the agent.

## Configuration

All settings live in `~/.pi/agent/notify.json`. Changes take effect immediately without `/reload`.

### Commands

| Command | Description |
|---|---|
| `/notify:status` | Show active platforms, events, and config file path |
| `/notify:test` | Send a test notification to all enabled platforms |
| `/notify:event <event> <on\|off>` | Enable or disable a notification event |
| `/notify:setup-gotify` | Interactive Gotify setup wizard with connection test |
| `/notify:setup-telegram` | Interactive Telegram bot setup wizard with chat ID auto-detection |
| `/notify:setup-ntfy` | Interactive ntfy setup wizard with connection test |

### Agent Tools

| Tool | Description |
|---|---|
| `notify_user` | Send an ad-hoc notification (`message`, optional `title`, `priority` `low\|normal\|high`, `platforms`) |

### Events

| Event | Default | Trigger |
|---|---|---|
| `agent_settled` | `on` | The agent run finished and settled (waits 1.5s grace for chained follow-ups and defers while wake-capable background tasks are running) |
| `input_needed` | `on` | The agent is waiting on any blocking UI prompt while running |
| `ask_user_prompt` | `on` | The agent asked a question via `ask_user` |
| `permission_request` | `on` | A permission prompt is waiting for approval |
| `agent_end` | `off` | Alias for run completion notification |
| `session_shutdown` | `off` | The Pi session shuts down |
