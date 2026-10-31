---
name: notify
description: >
  Cross-platform notification system for Pi. Use notify_user when you need
  to urgently alert the user about critical findings, errors, or completion
  of long-running tasks.
allowed-tools:
  - notify_user
---

# Notify User

Use the `notify_user` tool to send notifications to the user's configured
platforms (native OS, Gotify, Telegram, ntfy).

## When to use notify_user

- Critical errors that need immediate attention
- Completion of long-running tasks (after user has been waiting)
- Results that the user explicitly asked to be notified about

## When NOT to use notify_user

- Routine status updates (use normal message instead)
- Non-urgent information (let user read at their pace)
- Every turn completion (handled automatically by `agent_settled`)

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | string | required | Notification body |
| `title` | string? | `"Pi Notification"` | Notification title |
| `priority` | string? | `"normal"` | `"low"`, `"normal"`, or `"high"` |
| `platforms` | string[]? | all enabled | Override which platforms to use (`"native"`, `"gotify"`, `"telegram"`, `"ntfy"`) |
