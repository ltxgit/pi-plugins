/**
 * pi-plugins: notify — Command registration
 *
 * Registers slash commands for notification configuration, status, and testing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_EVENTS } from "./events.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { SuppressedError, sendNativeNotification } from "./platforms/native.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { getNotifyConfigPath, isNotifyEventKey, KNOWN_EVENT_KEYS, loadConfig, saveConfig } from "./settings.js";
import { GotifySetupOverlay } from "./tui/gotify-setup.js";
import { NtfySetupOverlay } from "./tui/ntfy-setup.js";
import { TelegramSetupOverlay } from "./tui/telegram-setup.js";
import { OVERLAY_OPTIONS } from "./tui/theme.js";

function formatStatusSummary(): string {
  const configPath = getNotifyConfigPath();
  const config = loadConfig(configPath);
  const platforms = [
    `native: ${config.native.enabled ? "on" : "off"}`,
    `gotify: ${config.gotify.enabled ? `on (${config.gotify.serverUrl ?? "unset"})` : "off"}`,
    `telegram: ${config.telegram.enabled ? `on (chat ${config.telegram.chatId ?? "unset"})` : "off"}`,
    `ntfy: ${config.ntfy.enabled ? `on (${config.ntfy.serverUrl}/${config.ntfy.topic ?? "unset"})` : "off"}`,
  ];
  const events = KNOWN_EVENT_KEYS.map((key) => `  ${key}: ${config.events[key].enabled ? "on" : "off"} (${BUILTIN_EVENTS[key].description})`);
  return [`Config: ${configPath}`, `Platforms: ${platforms.join(" · ")}`, "Events:", ...events].join("\n");
}

export function registerNotifyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("notify:status", {
    description: "Show notification platform and event status",
    handler: async (_args: string, ctx: ExtensionContext) => {
      try {
        ctx.ui.notify(formatStatusSummary(), "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("notify:event", {
    description: "Toggle a notify event: /notify:event <event> <on|off>",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      if (!trimmed.includes(" ")) {
        return KNOWN_EVENT_KEYS.filter((k) => k.startsWith(trimmed)).map((k) => ({
          value: `${k} `,
          label: k,
          description: BUILTIN_EVENTS[k].description,
        }));
      }
      const [eventKey, statePrefix = ""] = trimmed.split(/\s+/, 2);
      if (!isNotifyEventKey(eventKey)) return null;
      return ["on", "off"].filter((s) => s.startsWith(statePrefix)).map((s) => ({ value: `${eventKey} ${s}`, label: s }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        try {
          ctx.ui.notify(formatStatusSummary(), "info");
        } catch (err) {
          ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }

      const [event, value] = parts;
      if (parts.length !== 2 || (value !== "on" && value !== "off")) {
        ctx.ui.notify("Usage: /notify:event <event> <on|off>", "warning");
        return;
      }

      if (!isNotifyEventKey(event)) {
        ctx.ui.notify(`Unknown event "${event}". Known events: ${KNOWN_EVENT_KEYS.join(", ")}`, "error");
        return;
      }

      try {
        const config = loadConfig();
        config.events[event].enabled = value === "on";
        saveConfig(config);
        ctx.ui.notify(`notify: ${event} is now ${value}.`, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("notify:test", {
    description: "Send a test notification to all enabled platforms",
    handler: async (_args: string, ctx: ExtensionContext) => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig();
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }
      const title = "Pi — Test Notification";
      const message = `Test notification sent at ${new Date().toLocaleTimeString()}`;
      const results: string[] = [];

      if (config.native.enabled) {
        try {
          await sendNativeNotification(title, message, {
            windowsAppId: config.native.windowsAppId,
            suppressWhenFocused: config.native.suppressWhenFocused,
          });
          results.push("✓ Native: sent");
        } catch (err) {
          if (err instanceof SuppressedError) {
            results.push("— Native: suppressed (window focused)");
          } else {
            results.push(`✗ Native: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
      }

      if (config.gotify.enabled && config.gotify.serverUrl && config.gotify.appToken) {
        try {
          await sendGotifyNotification(config.gotify.serverUrl, config.gotify.appToken, title, message, config.gotify.priority);
          results.push("✓ Gotify: sent");
        } catch (err) {
          results.push(`✗ Gotify: ${err instanceof Error ? err.message : "failed"}`);
        }
      }

      if (config.telegram.enabled && config.telegram.botToken && config.telegram.chatId) {
        try {
          await sendTelegramNotification(config.telegram.botToken, config.telegram.chatId, title, message);
          results.push("✓ Telegram: sent");
        } catch (err) {
          results.push(`✗ Telegram: ${err instanceof Error ? err.message : "failed"}`);
        }
      }

      if (config.ntfy.enabled && config.ntfy.serverUrl && config.ntfy.topic) {
        try {
          await sendNtfyNotification(config.ntfy.serverUrl, config.ntfy.topic, title, message, config.ntfy.priority, config.ntfy.token);
          results.push("✓ ntfy: sent");
        } catch (err) {
          results.push(`✗ ntfy: ${err instanceof Error ? err.message : "failed"}`);
        }
      }

      if (results.length === 0) {
        ctx.ui.notify("No platforms enabled. Configure one via /notify:setup-ntfy, /notify:setup-telegram, or /notify:setup-gotify.", "warning");
      } else {
        ctx.ui.notify(`Test results:\n${results.join("\n")}`, "info");
      }
    },
  });

  pi.registerCommand("notify:setup-gotify", {
    description: "Interactive Gotify notification setup wizard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Gotify setup requires an interactive UI.", "warning");
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const overlay = new GotifySetupOverlay();
          overlay.setTheme(theme);
          overlay.onClose = () => done(undefined);
          overlay.requestRender = () => tui.requestRender();
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { ...OVERLAY_OPTIONS },
      );
    },
  });

  pi.registerCommand("notify:setup-telegram", {
    description: "Interactive Telegram bot notification setup wizard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Telegram setup requires an interactive UI.", "warning");
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const overlay = new TelegramSetupOverlay();
          overlay.setTheme(theme);
          overlay.onClose = () => done(undefined);
          overlay.requestRender = () => tui.requestRender();
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { ...OVERLAY_OPTIONS },
      );
    },
  });

  pi.registerCommand("notify:setup-ntfy", {
    description: "Interactive ntfy notification setup wizard",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("ntfy setup requires an interactive UI.", "warning");
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const overlay = new NtfySetupOverlay();
          overlay.setTheme(theme);
          overlay.onClose = () => done(undefined);
          overlay.requestRender = () => tui.requestRender();
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { ...OVERLAY_OPTIONS },
      );
    },
  });
}
