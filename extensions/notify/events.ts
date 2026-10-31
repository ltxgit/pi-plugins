/**
 * pi-plugins: notify — Event subscription and notification dispatch
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { filterPlatformsAfterInput } from "./activity.js";
import { buildAskUserPromptMessage } from "./ask-user-prompt-message.js";
import { buildInputNeededMessage } from "./input-needed-message.js";
import { buildPermissionPromptMessage } from "./permission-prompt-message.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { SuppressedError, sendNativeNotification } from "./platforms/native.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { isNotifyEventKey, loadConfig } from "./settings.js";
import { summarizeLastMessage } from "./summarize.js";
import type { NotifyConfig, NotifyDispatchResult, NotifyEventKey, NotifyPlatform, NotifyPriority } from "./types.js";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;
const PERMISSION_UI_PROMPT_EVENT = "permissions:ui_prompt" as const;

const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
let bgReqSeq = 0;

function hasRunningWakeTask(tasks: unknown): boolean {
  return (
    Array.isArray(tasks) &&
    tasks.some(
      (task) =>
        task !== null &&
        typeof task === "object" &&
        (task as { status?: string }).status === "running" &&
        (task as { notifyOnCompletion?: boolean }).notifyOnCompletion === true &&
        (task as { triggerOnCompletion?: boolean }).triggerOnCompletion === true,
    )
  );
}

/**
 * True when a background task will wake the agent with its own follow-up turn.
 * Queries pi-background-tasks EventBus API; requires both notifyOnCompletion and triggerOnCompletion.
 */
export async function hasPendingWakeTask(pi?: ExtensionAPI): Promise<boolean> {
  if (!pi?.events) return false;

  return new Promise<boolean>((resolve) => {
    const requestId = `notify-wake-check-${Date.now()}-${++bgReqSeq}`;
    let settled = false;
    let unsub: (() => void) | undefined;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsub?.();
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), 25);
    timer.unref?.();

    try {
      unsub = pi.events.on(BG_RESPONSE_CHANNEL, (data: unknown) => {
        const res = data as {
          schema_version?: string;
          request_id?: string;
          ok?: boolean;
          result?: { tasks?: unknown };
        } | null;
        if (!res || res.schema_version !== BG_RESPONSE_SCHEMA || res.request_id !== requestId) return;
        finish(Boolean(res.ok && hasRunningWakeTask(res.result?.tasks)));
      });

      pi.events.emit(BG_REQUEST_CHANNEL, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: requestId,
        operation: "status",
        payload: {},
      });
    } catch {
      finish(false);
    }
  });
}

export const BUILTIN_EVENTS: Record<NotifyEventKey, { label: string; description: string }> = {
  agent_settled: {
    label: "Agent Complete",
    description: "One notification when a run finishes and settles",
  },
  agent_end: {
    label: "Agent Run Complete",
    description: "Alias for run completion notification",
  },
  input_needed: {
    label: "Input Needed",
    description: "Agent is waiting on a blocking UI prompt",
  },
  ask_user_prompt: {
    label: "Question Asked",
    description: "Agent asked a question via ask_user",
  },
  permission_request: {
    label: "Permission Request",
    description: "A permission prompt is waiting for approval",
  },
  session_shutdown: {
    label: "Session End",
    description: "Session shuts down",
  },
};

export const PROMPT_DEDUP_MS = 2000;
export const FINISH_GRACE_MS = 1500;

const finishGraceMs = (): number => {
  const raw = process.env.UNIPI_NOTIFY_FINISH_GRACE_MS;
  const v = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v : FINISH_GRACE_MS;
};

let sessionCtx: ExtensionContext | null = null;
const busUnsubs: Array<() => void> = [];
let renotifyTimer: ReturnType<typeof setInterval> | undefined;
let finishTimer: ReturnType<typeof setTimeout> | undefined;
let agentRunning = false;
let openPrompts = 0;
let lastBlockingAlertAt = 0;

export function setSessionContext(ctx: ExtensionContext): void {
  sessionCtx = ctx;
}

export function clearSessionContext(): void {
  sessionCtx = null;
}

export function reportNotifyError(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  sessionCtx?.ui?.notify?.(`notify error: ${detail}`, "error");
}

export async function reportDispatchOutcome(promise: Promise<NotifyDispatchResult>): Promise<void> {
  try {
    const outcome = await promise;
    const failed = outcome.results.filter((r) => !r.success && !r.suppressed);
    if (failed.length > 0) {
      const summary = failed.map((r) => `${r.platform}: ${r.error ?? "failed"}`).join("; ");
      sessionCtx?.ui?.notify?.(`Notification delivery failed — ${summary}`, "warning");
    }
  } catch (err) {
    reportNotifyError(err);
  }
}

export function disarmRenotify(): void {
  const timer = renotifyTimer;
  renotifyTimer = undefined;
  if (timer === undefined) return;
  try {
    clearInterval(timer);
  } catch {}
}

function cancelFinish(): void {
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = undefined;
}

function armRenotify(pi: ExtensionAPI, title: string, message: string, platforms: NotifyPlatform[], eventType: string, config: NotifyConfig, dispatch: DispatchNotification): void {
  disarmRenotify();
  const { enabled, intervalMs, maxRepeats } = config.renotify;
  if (!enabled || maxRepeats <= 0) return;

  let fired = 0;
  const timer = setInterval(() => {
    let latestConfig: NotifyConfig;
    try {
      latestConfig = loadConfig();
    } catch (err) {
      disarmRenotify();
      reportNotifyError(err);
      return;
    }
    const eventCfg = isNotifyEventKey(eventType) ? latestConfig.events[eventType] : undefined;
    if (!latestConfig.renotify.enabled || latestConfig.renotify.maxRepeats <= 0 || (eventCfg && !eventCfg.enabled)) {
      disarmRenotify();
      return;
    }
    fired += 1;
    const activePlatforms = eventCfg ? eventCfg.platforms : platforms;
    reportDispatchOutcome(dispatch(pi, `${title} (still waiting)`, message, activePlatforms, eventType, latestConfig, "high"));
    if (fired >= latestConfig.renotify.maxRepeats) disarmRenotify();
  }, intervalMs);
  timer.unref?.();
  renotifyTimer = timer;
}

function notifyBlocking(pi: ExtensionAPI, eventKey: NotifyEventKey, title: string, message: string, platforms: NotifyPlatform[], config: NotifyConfig, dispatch: DispatchNotification): void {
  if (eventKey !== "input_needed") lastBlockingAlertAt = Date.now();
  reportDispatchOutcome(dispatch(pi, title, message, platforms, eventKey, config, "high"));
  armRenotify(pi, title, message, platforms, eventKey, config, dispatch);
}

export function unregisterEventListeners(): void {
  disarmRenotify();
  cancelFinish();
  agentRunning = false;
  openPrompts = 0;
  for (const unsub of busUnsubs) {
    try {
      unsub();
    } catch {}
  }
  busUnsubs.length = 0;
}

/**
 * Register Pi lifecycle hooks once per extension load.
 * Handlers read `loadConfig()` dynamically so config changes apply immediately without reload.
 */
export function registerLifecycleHooks(pi: ExtensionAPI, dispatch: DispatchNotification = dispatchNotification): void {
  const isChildSession = process.env.UNIPI_SUBAGENT_CHILD === "1" || process.env.UNIPI_FUSION_CHILD === "1";

  pi.on("agent_start", () => {
    agentRunning = true;
    disarmRenotify();
    cancelFinish();
  });

  pi.on("agent_end", () => {
    agentRunning = false;
  });

  if (!isChildSession) {
    pi.on("agent_settled", (payload) => {
      cancelFinish();
      let config: NotifyConfig;
      try {
        config = loadConfig();
      } catch (err) {
        reportNotifyError(err);
        return;
      }
      const eventKey: "agent_settled" | "agent_end" | undefined = config.events.agent_settled.enabled ? "agent_settled" : config.events.agent_end.enabled ? "agent_end" : undefined;
      if (!eventKey) return;

      finishTimer = setTimeout(() => {
        finishTimer = undefined;
        let currentConfig: NotifyConfig;
        try {
          currentConfig = loadConfig();
        } catch (err) {
          reportNotifyError(err);
          return;
        }
        const activeKey: "agent_settled" | "agent_end" | undefined = currentConfig.events.agent_settled.enabled ? "agent_settled" : currentConfig.events.agent_end.enabled ? "agent_end" : undefined;
        if (!activeKey) return;
        void dispatchRunFinished(pi, activeKey, currentConfig.events[activeKey].platforms, currentConfig, payload, dispatch);
      }, finishGraceMs());
      finishTimer.unref?.();
    });

    pi.on("ui_prompt_start", (payload) => {
      openPrompts += 1;
      if (!agentRunning) return;
      if (Date.now() - lastBlockingAlertAt < PROMPT_DEDUP_MS) return;
      let config: NotifyConfig;
      try {
        config = loadConfig();
      } catch (err) {
        reportNotifyError(err);
        return;
      }
      const eventConfig = config.events.input_needed;
      if (!eventConfig.enabled) return;
      notifyBlocking(pi, "input_needed", `Pi — ${BUILTIN_EVENTS.input_needed.label}`, buildInputNeededMessage(payload), eventConfig.platforms, config, dispatch);
    });

    pi.on("ui_prompt_end", () => {
      openPrompts = Math.max(0, openPrompts - 1);
      if (openPrompts === 0) disarmRenotify();
    });
  }
}

/**
 * Register EventBus listeners for the active session.
 */
export function registerEventListeners(pi: ExtensionAPI, dispatch: DispatchNotification = dispatchNotification): void {
  unregisterEventListeners();

  busUnsubs.push(
    pi.events.on(ASK_USER_PROMPT_EVENT, (payload: unknown) => {
      let config: NotifyConfig;
      try {
        config = loadConfig();
      } catch (err) {
        reportNotifyError(err);
        return;
      }
      const askUserConfig = config.events.ask_user_prompt;
      if (!askUserConfig.enabled) return;
      notifyBlocking(pi, "ask_user_prompt", `Pi — ${BUILTIN_EVENTS.ask_user_prompt.label}`, buildAskUserPromptMessage(payload), askUserConfig.platforms, config, dispatch);
    }),
  );

  busUnsubs.push(
    pi.events.on(PERMISSION_UI_PROMPT_EVENT, (payload: unknown) => {
      let config: NotifyConfig;
      try {
        config = loadConfig();
      } catch (err) {
        reportNotifyError(err);
        return;
      }
      const permConfig = config.events.permission_request;
      if (!permConfig.enabled) return;
      notifyBlocking(pi, "permission_request", `Pi — ${BUILTIN_EVENTS.permission_request.label}`, buildPermissionPromptMessage(payload), permConfig.platforms, config, dispatch);
    }),
  );

  busUnsubs.push(
    pi.events.on("herdr:blocked", (payload: unknown) => {
      if ((payload as { active?: unknown } | null)?.active === false) disarmRenotify();
    }),
  );
}

function getEnabledPlatforms(config: NotifyConfig): NotifyPlatform[] {
  const enabled: NotifyPlatform[] = [];
  if (config.native.enabled) enabled.push("native");
  if (config.gotify.enabled) enabled.push("gotify");
  if (config.telegram.enabled) enabled.push("telegram");
  if (config.ntfy.enabled) enabled.push("ntfy");
  return enabled;
}

export type DispatchNotification = typeof dispatchNotification;

export async function dispatchNotification(
  _pi: ExtensionAPI,
  title: string,
  message: string,
  eventPlatforms: NotifyPlatform[],
  eventType: string,
  config: NotifyConfig,
  priority?: NotifyPriority,
): Promise<NotifyDispatchResult> {
  const allEnabled = getEnabledPlatforms(config);
  const platforms = eventPlatforms.length > 0 ? eventPlatforms : allEnabled.length > 0 ? allEnabled : config.defaultPlatforms;

  const enabledPlatforms = platforms.filter((p) => {
    if (p === "native") return config.native.enabled;
    if (p === "gotify") return config.gotify.enabled;
    if (p === "telegram") return config.telegram.enabled;
    if (p === "ntfy") return config.ntfy.enabled;
    return false;
  });

  const { send: platformsToSend, silenced: inputSilenced } = filterPlatformsAfterInput(enabledPlatforms, config, Date.now(), eventType);

  const results = await Promise.all(
    platformsToSend.map(async (platform) => {
      try {
        const effectivePriority = await sendToPlatform(platform, title, message, config, priority, eventType);
        return {
          platform,
          success: true,
          ...(effectivePriority === undefined ? {} : { priority: effectivePriority }),
        };
      } catch (err) {
        if (err instanceof SuppressedError) {
          return { platform, success: true, suppressed: true };
        }
        return {
          platform,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const platform of inputSilenced) {
    results.push({ platform, success: true, suppressed: true });
  }

  const unsuppressed = results.filter((r) => !r.suppressed);
  const allSuccess = results.length > 0 && unsuppressed.every((r) => r.success);

  return { results, allSuccess };
}

export function mapNotifyPriority(platform: "gotify" | "ntfy", priority: NotifyPriority): number {
  const mappings = {
    gotify: { low: 2, normal: 5, high: 8 },
    ntfy: { low: 2, normal: 3, high: 5 },
  } as const;
  return mappings[platform][priority];
}

async function sendToPlatform(platform: NotifyPlatform, title: string, message: string, config: NotifyConfig, priority?: NotifyPriority, eventType?: string): Promise<number | undefined> {
  switch (platform) {
    case "native":
      await sendNativeNotification(title, message, {
        windowsAppId: config.native.windowsAppId,
        suppressWhenFocused: config.native.suppressWhenFocused,
      });
      return undefined;
    case "gotify": {
      if (!config.gotify.serverUrl || !config.gotify.appToken) {
        throw new Error("Gotify: serverUrl and appToken are required");
      }
      const effective = priority ? mapNotifyPriority("gotify", priority) : config.gotify.priority;
      await sendGotifyNotification(config.gotify.serverUrl, config.gotify.appToken, title, message, effective);
      return effective;
    }
    case "telegram":
      if (!config.telegram.botToken || !config.telegram.chatId) {
        throw new Error("Telegram: botToken and chatId are required");
      }
      await sendTelegramNotification(config.telegram.botToken, config.telegram.chatId, title, message);
      return undefined;
    case "ntfy": {
      if (!config.ntfy.enabled) return undefined;
      if (!config.ntfy.serverUrl || !config.ntfy.topic) {
        throw new Error("ntfy: serverUrl and topic are required");
      }
      const effective = priority ? mapNotifyPriority("ntfy", priority) : config.ntfy.priority;
      await sendNtfyNotification(config.ntfy.serverUrl, config.ntfy.topic, title, message, effective, config.ntfy.token, eventType);
      return effective;
    }
  }
}

async function dispatchRunFinished(pi: ExtensionAPI, eventKey: "agent_end" | "agent_settled", platforms: NotifyPlatform[], config: NotifyConfig, payload: unknown, dispatch: DispatchNotification): Promise<void> {
  if (await hasPendingWakeTask(pi)) return;
  if (agentRunning) return;

  const sessionName = pi.getSessionName?.();
  const title = `Pi — ${BUILTIN_EVENTS[eventKey].label}`;

  if (config.recap.enabled) {
    const lastText = extractLastAssistantText(payload) ?? extractLastAssistantTextFromSession();
    if (lastText && sessionCtx?.modelRegistry) {
      const provider = extractProvider(config.recap.model);
      const modelId = extractModelId(config.recap.model);
      const model = sessionCtx.modelRegistry.find(provider, modelId);
      if (model) {
        sessionCtx.modelRegistry
          .getApiKeyAndHeaders(model)
          .then((apiKeyResult) => {
            const apiKey = apiKeyResult.ok ? (apiKeyResult as { apiKey?: string }).apiKey : undefined;
            if (apiKey) {
              return summarizeLastMessage(lastText, apiKey, model.baseUrl, model.api, modelId, {
                disableThinking: config.recap.disableThinking,
              }).then((recap) => (sessionName ? `${sessionName}: ${recap}` : recap));
            }
            return buildAgentLifecycleMessage(eventKey, sessionName);
          })
          .catch(() => buildAgentLifecycleMessage(eventKey, sessionName))
          .then((message) => reportDispatchOutcome(dispatch(pi, title, message, platforms, eventKey, config, "low")));
        return;
      }
    }
  }

  const message = buildAgentLifecycleMessage(eventKey, sessionName);
  reportDispatchOutcome(dispatch(pi, title, message, platforms, eventKey, config, "low"));
}

function buildAgentLifecycleMessage(eventKey: "agent_end" | "agent_settled", sessionName: string | undefined): string {
  const status = eventKey === "agent_end" ? "Agent run is complete" : "Agent is complete";
  return sessionName ? `${sessionName} - ${status}` : status;
}

function extractLastAssistantTextFromSession(): string | null {
  const entries = sessionCtx?.sessionManager.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || !entry.message) continue;
    const text = extractAssistantText(entry.message);
    if (text) return text;
  }
  return null;
}

function extractLastAssistantText(payload: unknown): string | null {
  const p = payload as { messages?: Array<{ role?: string; content?: unknown }> };
  if (!p?.messages || !Array.isArray(p.messages)) return null;

  for (let i = p.messages.length - 1; i >= 0; i--) {
    const msg = p.messages[i];
    if (msg?.role !== "assistant") continue;
    const text = extractAssistantText(msg);
    if (text) return text;
  }

  return null;
}

function extractAssistantText(message: { role?: string; content?: unknown }): string | null {
  if (message.role !== "assistant") return null;

  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        }
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }

  return null;
}

function extractProvider(modelRef: string): string {
  const slashIdx = modelRef.indexOf("/");
  return slashIdx > 0 ? modelRef.slice(0, slashIdx) : modelRef;
}

function extractModelId(modelRef: string): string {
  const slashIdx = modelRef.indexOf("/");
  return slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
}
