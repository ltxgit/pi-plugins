/**
 * pi-plugins: notify — Configuration management
 *
 * Loads, saves, and validates notification config from ~/.pi/agent/notify.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeSilenceAfterInput } from "./activity.js";
import type { EventNotifyConfig, NotifyConfig, NotifyEventKey, RenotifyConfig } from "./types.js";

/** Global notify config path: ~/.pi/agent/notify.json */
export const NOTIFY_CONFIG_PATH = join(homedir(), ".pi", "agent", "notify.json");

export function getNotifyConfigPath(): string {
  return process.env.PI_NOTIFY_CONFIG_PATH || NOTIFY_CONFIG_PATH;
}

export class NotifyConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, detail: string) {
    super(`Invalid notify config at ${configPath}: ${detail}`);
    this.name = "NotifyConfigError";
    this.configPath = configPath;
  }
}

/** Default configuration — native enabled, completion & blocking input events enabled */
export const DEFAULT_CONFIG: NotifyConfig = {
  defaultPlatforms: ["native"],
  events: {
    agent_settled: { enabled: true, platforms: [] },
    agent_end: { enabled: false, platforms: [] },
    input_needed: { enabled: true, platforms: [] },
    ask_user_prompt: { enabled: true, platforms: [] },
    permission_request: { enabled: true, platforms: [] },
    session_shutdown: { enabled: false, platforms: [] },
  },
  native: {
    enabled: true,
    suppressWhenFocused: false,
  },
  gotify: {
    enabled: false,
    priority: 5,
  },
  telegram: {
    enabled: false,
  },
  ntfy: {
    enabled: false,
    serverUrl: "https://ntfy.sh",
    priority: 3,
  },
  recap: {
    enabled: false,
    model: "openrouter/openai/gpt-oss-20b",
    disableThinking: false,
  },
  silenceAfterInput: {
    enabled: false,
    windowMs: 10000,
    platforms: ["native"],
  },
  renotify: {
    enabled: true,
    intervalMs: 120000,
    maxRepeats: 3,
  },
};

export const KNOWN_EVENT_KEYS = Object.keys(DEFAULT_CONFIG.events) as NotifyEventKey[];

export function isNotifyEventKey(key: string): key is NotifyEventKey {
  return key in DEFAULT_CONFIG.events;
}

function readAndParseConfigFile(configPath: string): Partial<NotifyConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new NotifyConfigError(configPath, err instanceof Error ? err.message : String(err));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NotifyConfigError(configPath, err instanceof Error ? err.message : String(err));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotifyConfigError(configPath, "root value must be a JSON object");
  }
  return parsed as Partial<NotifyConfig>;
}

/** Load config from ~/.pi/agent/notify.json, returning defaults if missing and throwing NotifyConfigError if corrupted */
export function loadConfig(configPath = getNotifyConfigPath()): NotifyConfig {
  const parsed = readAndParseConfigFile(configPath);
  if (!parsed) {
    return structuredClone(DEFAULT_CONFIG);
  }
  return mergeWithDefaults(parsed);
}

/** Save config to ~/.pi/agent/notify.json. Refuses to overwrite an existing corrupted config file. */
export function saveConfig(config: NotifyConfig, configPath = getNotifyConfigPath()): void {
  readAndParseConfigFile(configPath);
  const normalized = mergeWithDefaults(config);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

/** Update config with partial changes */
export function updateConfig(partial: Partial<NotifyConfig>, configPath = getNotifyConfigPath()): NotifyConfig {
  const current = loadConfig(configPath);
  const updated = mergeWithDefaults({
    ...current,
    ...partial,
    events: partial.events ? { ...current.events, ...partial.events } : current.events,
    native: partial.native ? { ...current.native, ...partial.native } : current.native,
    gotify: partial.gotify ? { ...current.gotify, ...partial.gotify } : current.gotify,
    telegram: partial.telegram ? { ...current.telegram, ...partial.telegram } : current.telegram,
    ntfy: partial.ntfy ? { ...current.ntfy, ...partial.ntfy } : current.ntfy,
    recap: partial.recap ? { ...current.recap, ...partial.recap } : current.recap,
    silenceAfterInput: partial.silenceAfterInput ? { ...current.silenceAfterInput, ...partial.silenceAfterInput } : current.silenceAfterInput,
    renotify: partial.renotify ? { ...current.renotify, ...partial.renotify } : current.renotify,
  });
  saveConfig(updated, configPath);
  return updated;
}

/** Merge loaded config with defaults to ensure all fields exist */
function mergeWithDefaults(loaded: Partial<NotifyConfig>): NotifyConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  const loadedEvents = (loaded.events ?? {}) as Partial<Record<NotifyEventKey, Partial<EventNotifyConfig>>>;
  const events = { ...base.events };
  for (const key of KNOWN_EVENT_KEYS) {
    const item = loadedEvents[key];
    if (item && typeof item === "object") {
      events[key] = {
        enabled: typeof item.enabled === "boolean" ? item.enabled : base.events[key].enabled,
        platforms: Array.isArray(item.platforms) ? item.platforms : base.events[key].platforms,
      };
    }
  }

  return {
    defaultPlatforms: Array.isArray(loaded.defaultPlatforms) ? loaded.defaultPlatforms : base.defaultPlatforms,
    events,
    native: { ...base.native, ...loaded.native },
    gotify: { ...base.gotify, ...loaded.gotify },
    telegram: { ...base.telegram, ...loaded.telegram },
    ntfy: {
      ...base.ntfy,
      ...loaded.ntfy,
      serverUrl: loaded.ntfy?.serverUrl || base.ntfy.serverUrl,
      priority: typeof loaded.ntfy?.priority === "number" && loaded.ntfy.priority >= 1 && loaded.ntfy.priority <= 5 ? loaded.ntfy.priority : base.ntfy.priority,
    },
    recap: { ...base.recap, ...loaded.recap },
    silenceAfterInput: mergeSilenceAfterInput(loaded.silenceAfterInput, base.silenceAfterInput),
    renotify: mergeRenotify(loaded.renotify, base.renotify),
  };
}

/** Merge the renotify block, falling back per-field on invalid scalars. */
function mergeRenotify(loaded: Partial<RenotifyConfig> | undefined, defaults: RenotifyConfig): RenotifyConfig {
  const intervalMs = typeof loaded?.intervalMs === "number" && Number.isFinite(loaded.intervalMs) && loaded.intervalMs >= 10000 ? loaded.intervalMs : defaults.intervalMs;
  const maxRepeats = typeof loaded?.maxRepeats === "number" && Number.isInteger(loaded.maxRepeats) && loaded.maxRepeats >= 0 ? loaded.maxRepeats : defaults.maxRepeats;
  return {
    enabled: loaded?.enabled ?? defaults.enabled,
    intervalMs,
    maxRepeats,
  };
}
