import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerNotifyCommands } from "../extensions/notify/commands";
import { clearSessionContext, disarmRenotify, hasPendingWakeTask, registerEventListeners, registerLifecycleHooks, setSessionContext, unregisterEventListeners } from "../extensions/notify/events";
import registerNotifyExtension from "../extensions/notify/index";
import { loadConfig, NotifyConfigError, saveConfig, updateConfig } from "../extensions/notify/settings";
import { registerNotifyTools } from "../extensions/notify/tools";
import { GotifySetupOverlay } from "../extensions/notify/tui/gotify-setup";
import { NtfySetupOverlay } from "../extensions/notify/tui/ntfy-setup";
import { TelegramSetupOverlay } from "../extensions/notify/tui/telegram-setup";

type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type LifecycleHandler = (payload: unknown, ctx: ExtensionContext) => Promise<void> | void;

function createTestHarness() {
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const bus = new Map<string, Set<(payload: unknown) => void>>();
  const commands = new Map<string, RegisteredCommandOptions>();
  const tools = new Map<string, ToolDefinition>();
  const uiMessages: Array<{ message: string; level?: string }> = [];

  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level?: "info" | "warning" | "error") {
        uiMessages.push({ message, level });
      },
      async custom() {
        return undefined as never;
      },
    },
    sessionManager: {
      getEntries() {
        return [];
      },
    },
  } as unknown as ExtensionContext & ExtensionCommandContext & ExtensionToolContext;

  const pi = {
    events: {
      on(channel: string, handler: (payload: unknown) => void) {
        const set = bus.get(channel) ?? new Set();
        set.add(handler);
        bus.set(channel, set);
        return () => {
          set.delete(handler);
        };
      },
      emit(channel: string, payload?: unknown) {
        for (const handler of bus.get(channel) ?? []) {
          handler(payload);
        }
      },
    },
    on(event: string, handler: LifecycleHandler) {
      const list = lifecycle.get(event) ?? [];
      list.push(handler);
      lifecycle.set(event, list);
    },
    registerCommand(name: string, options: RegisteredCommandOptions) {
      commands.set(name, options);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    ctx,
    commands,
    tools,
    uiMessages,
    async emitLifecycle(event: string, payload: unknown = {}) {
      for (const handler of lifecycle.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

let tempDir: string;
let configPath: string;
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-notify-test-"));
  configPath = join(tempDir, "notify.json");
  process.env.PI_NOTIFY_CONFIG_PATH = configPath;
  process.env.UNIPI_NOTIFY_FINISH_GRACE_MS = "10";
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  disarmRenotify();
  unregisterEventListeners();
  clearSessionContext();
  globalThis.fetch = originalFetch;
  delete process.env.PI_NOTIFY_CONFIG_PATH;
  delete process.env.UNIPI_NOTIFY_FINISH_GRACE_MS;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("notify", () => {
  test("notify_user awaits platform dispatch and surfaces delivery failures", async () => {
    saveConfig({
      ...loadConfig(),
      defaultPlatforms: ["gotify"],
      native: { enabled: false, suppressWhenFocused: false },
      gotify: { enabled: true, serverUrl: "https://gotify.example.com", appToken: "tok", priority: 5 },
    });

    globalThis.fetch = (async () => new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;

    const { pi, ctx, tools, uiMessages } = createTestHarness();
    registerNotifyTools(pi);
    const tool = tools.get("notify_user");
    if (!tool) throw new Error("notify_user tool not registered");

    const result = await tool.execute("call-1", { message: "deploy finished" }, undefined, undefined, ctx);
    const firstBlock = result.content[0];
    expect(firstBlock?.type === "text" ? firstBlock.text : "").toContain("Notification delivery failed (1/1 failed): gotify: failed (Gotify API error 503: Service Unavailable)");
    expect((result.details as { allSuccess?: boolean } | undefined)?.allSuccess).toBe(false);
    expect(uiMessages.some((m) => m.level === "error" && m.message.includes("503: Service Unavailable"))).toBe(true);
  });

  test("session_shutdown awaits delivery and surfaces errors before clearing session context", async () => {
    const cfg = loadConfig();
    cfg.native.enabled = false;
    cfg.gotify = { enabled: true, serverUrl: "https://gotify.example.com", appToken: "tok", priority: 5 };
    cfg.events.session_shutdown = { enabled: true, platforms: ["gotify"] };
    saveConfig(cfg);

    let fetchCompleted = false;
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 15));
      fetchCompleted = true;
      return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
    }) as unknown as typeof fetch;

    const { pi, uiMessages, emitLifecycle } = createTestHarness();
    registerNotifyExtension(pi);
    await emitLifecycle("session_start");
    await emitLifecycle("session_shutdown");

    expect(fetchCompleted).toBe(true);
    expect(uiMessages.some((m) => m.level === "warning" && m.message.includes("503: Service Unavailable"))).toBe(true);
  });

  test("refuses to silently reset or overwrite a corrupted notify.json", async () => {
    const brokenRaw = '{\n  "native": { "enabled": false }\n';
    writeFileSync(configPath, brokenRaw, "utf-8");

    expect(() => loadConfig()).toThrow(NotifyConfigError);
    expect(() => updateConfig({ renotify: { enabled: false, intervalMs: 60000, maxRepeats: 1 } })).toThrow(NotifyConfigError);

    const { pi, ctx, commands, uiMessages } = createTestHarness();
    registerNotifyCommands(pi);
    const eventCmd = commands.get("notify:event");
    if (!eventCmd) throw new Error("notify:event command not registered");
    await eventCmd.handler("agent_settled off", ctx);

    expect(uiMessages.some((m) => m.level === "error" && m.message.includes(configPath))).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(brokenRaw);
  });

  test("enforces 10s minimum renotify interval and stops timer when event or renotify is disabled", async () => {
    const normalized = updateConfig({
      renotify: { enabled: true, intervalMs: 15, maxRepeats: 5 },
    });
    expect(normalized.renotify.intervalMs).toBe(120000);

    const activeTimers = new Map<number, () => void>();
    let nextTimerId = 1;
    globalThis.setInterval = ((cb: () => void) => {
      const id = nextTimerId++;
      activeTimers.set(id, cb);
      return { id, unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((handle: { id?: number } | undefined) => {
      if (handle?.id !== undefined) activeTimers.delete(handle.id);
    }) as unknown as typeof clearInterval;

    const { pi, ctx, emitLifecycle } = createTestHarness();
    setSessionContext(ctx);
    const dispatched: string[] = [];
    const fakeDispatch = async (_pi: ExtensionAPI, title: string) => {
      dispatched.push(title);
      return { results: [{ platform: "native" as const, success: true }], allSuccess: true };
    };

    registerLifecycleHooks(pi, fakeDispatch);
    registerEventListeners(pi, fakeDispatch);

    await emitLifecycle("agent_start");
    pi.events.emit("rpiv:ask-user:prompt", { question: "Continue?" });
    expect(dispatched).toEqual(["Pi — Question Asked"]);
    expect(activeTimers.size).toBe(1);

    for (const tick of activeTimers.values()) tick();
    expect(dispatched).toEqual(["Pi — Question Asked", "Pi — Question Asked (still waiting)"]);

    const cfg = loadConfig();
    cfg.events.ask_user_prompt.enabled = false;
    cfg.renotify.enabled = false;
    saveConfig(cfg);

    for (const tick of activeTimers.values()) tick();
    expect(dispatched).toEqual(["Pi — Question Asked", "Pi — Question Asked (still waiting)"]);
    expect(activeTimers.size).toBe(0);
  });

  test("suppresses agent_settled only when a running background task has both notifyOnCompletion and triggerOnCompletion", async () => {
    const { pi, ctx, emitLifecycle } = createTestHarness();
    setSessionContext(ctx);

    let tasksState: Array<{ id: string; status: string; notifyOnCompletion: boolean; triggerOnCompletion: boolean }> = [{ id: "bg-1", status: "running", notifyOnCompletion: true, triggerOnCompletion: true }];
    pi.events.on("pi-background-tasks:request:v1", (raw) => {
      const req = raw as { request_id: string; operation: string };
      pi.events.emit("pi-background-tasks:response:v1", {
        schema_version: "pi-background-tasks.extension-response.v1",
        request_id: req.request_id,
        operation: req.operation,
        ok: true,
        result: { tasks: tasksState },
      });
    });

    expect(await hasPendingWakeTask(pi)).toBe(true);

    const dispatched: string[] = [];
    registerLifecycleHooks(pi, async (_pi, title) => {
      dispatched.push(title);
      return { results: [{ platform: "native" as const, success: true }], allSuccess: true };
    });

    await emitLifecycle("agent_settled", {});
    await new Promise((r) => setTimeout(r, 35));
    expect(dispatched).toEqual([]);

    // notifyOnCompletion: false does not wake the agent, so completion notification must fire
    tasksState = [{ id: "bg-1", status: "running", notifyOnCompletion: false, triggerOnCompletion: true }];
    expect(await hasPendingWakeTask(pi)).toBe(false);

    await emitLifecycle("agent_settled", {});
    await new Promise((r) => setTimeout(r, 35));
    expect(dispatched).toEqual(["Pi — Agent Complete"]);
  });

  test("handles single-chunk bracketed paste and subsequent Enter in all setup wizards", () => {
    const ntfy = new NtfySetupOverlay();
    ntfy.handleInput("\r");
    ntfy.handleInput("\x1b[200~https://ntfy.example.com\x1b[201~");
    expect(ntfy.render(80).join("\n")).toContain("https://ntfy.example.com");
    ntfy.handleInput("\r");
    expect(ntfy.render(80).join("\n")).toContain("Enter topic name:");

    const gotify = new GotifySetupOverlay();
    gotify.handleInput("\r");
    gotify.handleInput("\x1b[200~https://gotify.example.com\x1b[201~");
    expect(gotify.render(80).join("\n")).toContain("https://gotify.example.com");
    gotify.handleInput("\r");
    expect(gotify.render(80).join("\n")).toContain("Enter your app token:");

    const telegram = new TelegramSetupOverlay();
    telegram.handleInput("\r");
    telegram.handleInput("\x1b[200~123456:ABCDEF_token\x1b[201~");
    expect(telegram.render(80).join("\n")).toContain("123456:ABCDEF_token");
  });
});
