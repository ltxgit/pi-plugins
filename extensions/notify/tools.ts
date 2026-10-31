/**
 * pi-plugins: notify — Agent tool registration
 *
 * Registers the `notify_user` tool for ad-hoc notifications.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dispatchNotification, mapNotifyPriority } from "./events.js";
import { loadConfig } from "./settings.js";
import type { NotifyPriority } from "./types.js";

export const NOTIFY_USER_TOOL = "notify_user";

const NotifyUserSchema = Type.Object({
  message: Type.String({ description: "Notification message body" }),
  title: Type.Optional(Type.String({ description: "Notification title (default: Pi Notification)" })),
  priority: Type.Optional(
    Type.String({
      enum: ["low", "normal", "high"],
      description: "Priority level",
    }),
  ),
  platforms: Type.Optional(
    Type.Array(Type.String({ enum: ["native", "gotify", "telegram", "ntfy"] }), {
      description: "Override platforms for this notification",
    }),
  ),
});

export function registerNotifyTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: NOTIFY_USER_TOOL,
    label: "Notify User",
    description:
      "Send a notification to the user's configured platforms (native OS, Gotify, Telegram, ntfy). " + "Use for critical errors, completion of long-running tasks, or when the user explicitly asked to be notified.",
    parameters: NotifyUserSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { message, title, priority, platforms } = params as {
        message: string;
        title?: string;
        priority?: NotifyPriority;
        platforms?: Array<"native" | "gotify" | "telegram" | "ntfy">;
      };

      const config = loadConfig();
      const notifTitle = title || "Pi Notification";
      const notifPlatforms = platforms || config.defaultPlatforms;

      const dispatchResult = await dispatchNotification(pi, notifTitle, message, notifPlatforms, "agent_tool", config, priority);

      const priorityByPlatform = priority
        ? Object.fromEntries(
            notifPlatforms.flatMap((platform) => {
              if (platform === "gotify" || platform === "ntfy") {
                return [[platform, mapNotifyPriority(platform, priority)]];
              }
              return [];
            }),
          )
        : undefined;

      if (dispatchResult.results.length === 0) {
        const msg = `No notification platforms enabled for target(s): ${notifPlatforms.join(", ")}`;
        ctx?.ui?.notify?.(msg, "warning");
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { platforms: notifPlatforms, priority, priorityByPlatform, results: dispatchResult.results, allSuccess: false },
        };
      }

      const statusLines = dispatchResult.results.map((r) => {
        if (r.suppressed) return `${r.platform}: suppressed`;
        if (r.success) return `${r.platform}: sent`;
        return `${r.platform}: failed (${r.error ?? "unknown error"})`;
      });
      const failed = dispatchResult.results.filter((r) => !r.success && !r.suppressed);
      if (failed.length > 0) {
        const failureText = failed.map((r) => `${r.platform}: ${r.error ?? "failed"}`).join("; ");
        ctx?.ui?.notify?.(`Notification delivery failed — ${failureText}`, "error");
      }

      const summaryPrefix = failed.length === 0 ? "Notification results" : `Notification delivery failed (${failed.length}/${dispatchResult.results.length} failed)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${summaryPrefix}: ${statusLines.join(", ")}`,
          },
        ],
        details: {
          platforms: notifPlatforms,
          priority,
          priorityByPlatform,
          results: dispatchResult.results,
          allSuccess: dispatchResult.allSuccess,
        },
      };
    },
  });
}
