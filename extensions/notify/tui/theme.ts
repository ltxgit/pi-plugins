import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const OVERLAY_OPTIONS = {
  overlay: true,
} as const;

export function boxInnerWidth(width: number): number {
  return Math.max(1, Math.floor(width) - 2);
}

function safeRepeat(char: string, count: number): string {
  return char.repeat(Math.max(0, Math.floor(count)));
}

const FALLBACK_COLORS: Record<string, string> = {
  accent: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  dim: "\x1b[2m",
  borderMuted: "\x1b[90m",
};

export class OverlayTheme {
  private theme: Theme | null = null;
  private unsupportedKeys = new Set<string>();

  setTheme(theme: Theme | null): void {
    this.theme = theme;
  }

  fg(color: string, text: string): string {
    if (this.theme && !this.unsupportedKeys.has(color)) {
      try {
        const rendered = this.theme.fg(color as never, text);
        const body = rendered.endsWith("\x1b[0m") ? rendered.slice(0, -4) : rendered;
        return `${body}\x1b[39m`;
      } catch {
        this.unsupportedKeys.add(color);
      }
    }
    return `${FALLBACK_COLORS[color] ?? ""}${text}\x1b[39m`;
  }

  bold(text: string): string {
    if (this.theme) {
      try {
        const rendered = this.theme.bold(text);
        const body = rendered.endsWith("\x1b[0m") ? rendered.slice(0, -4) : rendered;
        return `${body}\x1b[22m`;
      } catch {}
    }
    return `\x1b[1m${text}\x1b[22m`;
  }

  frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.fg("borderMuted", "│")}${truncated}${safeRepeat(" ", padding)}${this.fg("borderMuted", "│")}`;
  }

  ruleLine(innerWidth: number): string {
    return this.fg("borderMuted", `├${safeRepeat("─", innerWidth)}┤`);
  }

  borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${safeRepeat("─", innerWidth)}${right}`);
  }
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Stateful bracketed-paste parser that handles single-chunk and multi-chunk pastes
 * as well as normal keystrokes before or after paste markers.
 */
export class BracketedPasteBuffer {
  private active = false;
  private buffer = "";

  process(data: string, onPaste: (content: string) => void, onNormal: (chunk: string) => void): void {
    let remaining = data;
    while (remaining.length > 0) {
      if (this.active) {
        const endIdx = remaining.indexOf(PASTE_END);
        if (endIdx === -1) {
          this.buffer += remaining;
          return;
        }
        this.buffer += remaining.slice(0, endIdx);
        const pasted = this.buffer;
        this.buffer = "";
        this.active = false;
        onPaste(pasted);
        remaining = remaining.slice(endIdx + PASTE_END.length);
      } else {
        const startIdx = remaining.indexOf(PASTE_START);
        if (startIdx === -1) {
          onNormal(remaining);
          return;
        }
        if (startIdx > 0) {
          onNormal(remaining.slice(0, startIdx));
        }
        this.active = true;
        this.buffer = "";
        remaining = remaining.slice(startIdx + PASTE_START.length);
      }
    }
  }
}
