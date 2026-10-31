/**
 * pi-plugins: notify — Extension entry
 *
 * Cross-platform notification system for Pi (native OS, Gotify, Telegram, ntfy).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { noteInput, resetInputActivity } from "./activity.js";
import { registerNotifyCommands } from "./commands.js";
import {
  BUILTIN_EVENTS,
  clearSessionContext,
  disarmRenotify,
  dispatchNotification,
  registerEventListeners,
  registerLifecycleHooks,
  reportDispatchOutcome,
  reportNotifyError,
  setSessionContext,
  unregisterEventListeners,
} from "./events.js";
import { loadConfig } from "./settings.js";
import { registerNotifyTools } from "./tools.js";

let unsubTerminalInput: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
  registerNotifyTools(pi);
  registerNotifyCommands(pi);
  registerLifecycleHooks(pi);

  pi.on("session_start", async (_event, ctx) => {
    setSessionContext(ctx);
    resetInputActivity();
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    const onTerminalInput = ctx.ui?.onTerminalInput;
    if (typeof onTerminalInput === "function") {
      try {
        unsubTerminalInput = onTerminalInput(() => {
          noteInput();
          disarmRenotify();
        });
      } catch {
        unsubTerminalInput = undefined;
      }
    }
    registerEventListeners(pi);
  });

  pi.on("session_shutdown", async () => {
    try {
      const config = loadConfig();
      if (config.events.session_shutdown.enabled) {
        await reportDispatchOutcome(dispatchNotification(pi, `Pi — ${BUILTIN_EVENTS.session_shutdown.label}`, "Session ending", config.events.session_shutdown.platforms, "session_shutdown", config, "low"));
      }
    } catch (err) {
      reportNotifyError(err);
    } finally {
      unsubTerminalInput?.();
      unsubTerminalInput = undefined;
      disarmRenotify();
      resetInputActivity();
      clearSessionContext();
      unregisterEventListeners();
    }
  });
}
