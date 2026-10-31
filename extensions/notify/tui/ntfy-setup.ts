/**
 * pi-plugins: notify — ntfy Setup TUI Component
 *
 * Interactive overlay for setting up ntfy push notifications.
 * Guides user through server URL, topic, optional token, and priority.
 * Tests connection before saving to ~/.pi/agent/notify.json.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { sendNtfyNotification } from "../platforms/ntfy.js";
import { loadConfig, updateConfig } from "../settings.js";
import { BracketedPasteBuffer, boxInnerWidth, OverlayTheme } from "./theme.js";

type SetupPhase = "instructions" | "server-url" | "topic" | "token" | "priority" | "testing" | "success" | "error" | "test-failed";

export class NtfySetupOverlay implements Component {
  private phase: SetupPhase = "instructions";
  private serverUrl = "";
  private topic = "";
  private token = "";
  private priority = "3";
  private error: string | null = null;
  private testError: string | null = null;
  private paste = new BracketedPasteBuffer();
  onClose?: () => void;
  requestRender?: () => void;
  private overlay = new OverlayTheme();

  constructor() {
    try {
      const config = loadConfig().ntfy;
      if (config.serverUrl) this.serverUrl = config.serverUrl;
      if (config.topic) this.topic = config.topic;
      if (config.token) this.token = config.token;
      if (config.priority) this.priority = String(config.priority);
    } catch (err) {
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  setTheme(theme: Theme): void {
    this.overlay.setTheme(theme);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    switch (this.phase) {
      case "instructions":
        if (data === "\r" || data === "\t" || data === " ") {
          this.phase = "server-url";
        } else if (matchesKey(data, "escape")) {
          this.onClose?.();
        }
        break;

      case "server-url":
        this.handleTextInput(data, "server-url", () => {
          if (!this.serverUrl) {
            this.serverUrl = "https://ntfy.sh";
          }
          this.phase = "topic";
        });
        break;

      case "topic":
        this.handleTextInput(data, "topic", () => {
          this.phase = "token";
        });
        break;

      case "token":
        this.handleTextInput(data, "token", () => {
          this.phase = "priority";
        });
        break;

      case "priority":
        if ((data === "\r" || data === "\t") && this.isValidPriority()) {
          this.testConnection();
        } else if (matchesKey(data, "escape")) {
          this.onClose?.();
        } else if (data === "\x7f" || data === "\b") {
          this.priority = this.priority.slice(0, -1);
        } else {
          const ch = data.replace(/[^\d]/g, "");
          if (ch && this.priority.length < 1) {
            this.priority += ch;
          }
        }
        break;

      case "testing":
        if (matchesKey(data, "escape")) {
          this.onClose?.();
        }
        break;

      case "success":
      case "error":
      case "test-failed":
        if (data === "\r" || data === "\t" || data === " " || matchesKey(data, "escape")) {
          this.onClose?.();
        }
        break;
    }
  }

  private handleTextInput(data: string, target: "server-url" | "topic" | "token", onEnter: () => void): void {
    this.paste.process(
      data,
      (pasteContent) => {
        const trimmed = pasteContent.trim();
        if (target === "server-url") {
          this.serverUrl = trimmed;
        } else if (target === "topic") {
          this.topic = trimmed;
        } else {
          this.token = trimmed;
        }
      },
      (chunk) => {
        if (chunk === "\r" || chunk === "\t") {
          onEnter();
        } else if (matchesKey(chunk, "escape")) {
          if (target === "token") {
            this.phase = "priority";
          } else {
            this.onClose?.();
          }
        } else if (chunk === "\x7f" || chunk === "\b") {
          if (target === "server-url") {
            this.serverUrl = this.serverUrl.slice(0, -1);
          } else if (target === "topic") {
            this.topic = this.topic.slice(0, -1);
          } else {
            this.token = this.token.slice(0, -1);
          }
        } else {
          if (chunk.startsWith("\x1b[")) return;
          if (target === "server-url") {
            this.serverUrl += chunk;
          } else if (target === "topic") {
            this.topic += chunk;
          } else {
            this.token += chunk;
          }
        }
      },
    );
  }

  private isValidPriority(): boolean {
    const num = Number.parseInt(this.priority, 10);
    return !Number.isNaN(num) && num >= 1 && num <= 5;
  }

  private async testConnection(): Promise<void> {
    this.phase = "testing";
    this.requestRender?.();

    try {
      await sendNtfyNotification(
        this.serverUrl.replace(/\/$/, ""),
        this.topic,
        "Pi — Setup Test",
        `ntfy configured successfully at ${new Date().toLocaleTimeString()}`,
        Number.parseInt(this.priority, 10) || 3,
        this.token || undefined,
      );
      this.saveConfig();
      this.phase = "success";
      this.requestRender?.();
      setTimeout(() => this.onClose?.(), 1500);
    } catch (err) {
      this.testError = err instanceof Error ? err.message : String(err);
      this.phase = "test-failed";
      this.requestRender?.();
    }
  }

  private saveConfig(): void {
    updateConfig({
      ntfy: {
        enabled: true,
        serverUrl: this.serverUrl.replace(/\/$/, ""),
        topic: this.topic,
        token: this.token || undefined,
        priority: Number.parseInt(this.priority, 10) || 3,
      },
    });
  }

  private maskToken(token: string): string {
    if (token.length <= 8) return token;
    return `${token.slice(0, 4)}${"•".repeat(token.length - 8)}${token.slice(-4)}`;
  }

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines: string[] = [];

    lines.push(this.overlay.borderLine(innerWidth, "top"));
    lines.push(this.overlay.frameLine(this.overlay.fg("accent", this.overlay.bold("📢 ntfy Setup")), innerWidth));
    lines.push(this.overlay.ruleLine(innerWidth));

    switch (this.phase) {
      case "instructions":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Set up ntfy push notifications:"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("1.")} ntfy is a simple HTTP-based notification service`, innerWidth));
        lines.push(this.overlay.frameLine(`     ${this.overlay.fg("dim", "Public: https://ntfy.sh | Self-hosted: any ntfy server")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("2.")} Choose a topic (acts as a channel name)`, innerWidth));
        lines.push(this.overlay.frameLine(`     ${this.overlay.fg("dim", "Subscribe to the topic in the ntfy app or web UI")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.bold("3.")} Optionally set an access token for private servers`, innerWidth));
        if (this.serverUrl) {
          lines.push(this.overlay.frameLine(`     ${this.overlay.fg("success", "✓")} Server URL pre-filled from existing config`, innerWidth));
        }
        if (this.topic) {
          lines.push(this.overlay.frameLine(`     ${this.overlay.fg("success", "✓")} Topic pre-filled from existing config`, innerWidth));
        }
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "enter/tab continue · esc cancel"), innerWidth));
        break;

      case "server-url":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Enter ntfy server URL:"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("accent", this.overlay.bold(this.serverUrl || " "))}${this.overlay.fg("dim", "█")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Default: https://ntfy.sh (public)"), innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Leave empty and press Enter for default"), innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "enter/tab continue · esc cancel"), innerWidth));
        break;

      case "topic":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Enter topic name:"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("accent", this.overlay.bold(this.topic || " "))}${this.overlay.fg("dim", "█")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "e.g. my-pi-notifications, project-alerts"), innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Pick something unique if using public ntfy.sh"), innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "enter/tab continue · esc cancel"), innerWidth));
        break;

      case "token": {
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Enter access token (optional):"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        const displayToken = this.token ? this.overlay.fg("accent", this.overlay.bold(this.maskToken(this.token))) : " ";
        lines.push(this.overlay.frameLine(`  ${displayToken}${this.overlay.fg("dim", "█")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Only needed for private/authenticated ntfy servers"), innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "enter/tab continue · esc skip"), innerWidth));
        break;
      }

      case "priority":
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Set notification priority (1-5):"), innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("accent", this.overlay.bold(this.priority || " "))}${this.overlay.fg("dim", "█")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "1")} = min · ${this.overlay.fg("dim", "3")} = default · ${this.overlay.fg("dim", "5")} = max`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "enter/tab test · esc cancel"), innerWidth));
        break;

      case "testing":
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("accent", "⠋")} ${this.overlay.bold("Testing connection...")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Sending test to ${this.serverUrl}/${this.topic}`)}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Esc to cancel"), innerWidth));
        break;

      case "success":
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("success", "✓ ntfy configured successfully!")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Server: ${this.serverUrl}`)}`, innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Topic: ${this.topic}`)}`, innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", `Priority: ${this.priority}`)}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Closing..."), innerWidth));
        break;

      case "test-failed":
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("error", "✗ Connection test failed")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", this.testError || "Unknown error")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", "Check your server URL and topic")}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to close"), innerWidth));
        break;

      case "error":
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("error", "✗ Setup failed")}`, innerWidth));
        lines.push(this.overlay.frameLine("", innerWidth));
        lines.push(this.overlay.frameLine(`  ${this.overlay.fg("dim", this.error || "Unknown error")}`, innerWidth));
        lines.push(this.overlay.ruleLine(innerWidth));
        lines.push(this.overlay.frameLine(this.overlay.fg("dim", "Press Enter to close"), innerWidth));
        break;
    }

    lines.push(this.overlay.borderLine(innerWidth, "bottom"));
    return lines;
  }
}
