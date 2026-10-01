import type { AgentMessage } from "./protocol.ts";

export const MAX_HISTORY_ITEMS = 400;
export const MAX_HISTORY_BYTES = 512 * 1024;
export const MAX_HISTORY_TEXT = 64 * 1024; // UTF-16 units per message/draft
export type HistoryItem = { order: number } & (
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | { kind: "activity"; tool_call_id: string; summary: string; status: "running" | "done" | "failed" }
  | { kind: "notice"; code: string; content: string }
);
export interface HistorySnapshot {
  sequence: number;
  items: HistoryItem[];
  draft: { order: number; content: string } | null;
  truncated: boolean;
}

export function activitySummary(event: Extract<AgentMessage, { type: "activity.started" }>): string {
  const { tool, args, args_omitted } = event.activity;
  const values = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const detail = [values.path, values.file_path, values.command].find(value => typeof value === "string");
  return `${tool.slice(0, 100)}${detail ? `: ${detail.slice(0, 180)}` : ""}${args_omitted ? " (arguments omitted)" : ""}`;
}

/** A materialized recent view, not an event queue or a copy of Pi's session log. */
export class SessionHistory {
  private sequence = 0;
  private items: HistoryItem[] = [];
  private draft: HistorySnapshot["draft"] = null;
  private truncated = false;

  private text(content: string): string {
    if (content.length <= MAX_HISTORY_TEXT) return content;
    this.truncated = true;
    let end = MAX_HISTORY_TEXT;
    if (content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff) end--;
    return `${content.slice(0, end)}\n[History text truncated]`;
  }
  private trim(): void {
    this.items.sort((a, b) => a.order - b.order);
    while (this.items.length > MAX_HISTORY_ITEMS || Buffer.byteLength(JSON.stringify(this.items)) > MAX_HISTORY_BYTES) {
      this.items.shift();
      this.truncated = true;
    }
  }
  record(event: AgentMessage): number | undefined {
    if (!["message.delta", "message.completed", "activity.started", "activity.completed", "error"].includes(event.type)) return undefined;
    const sequence = ++this.sequence;
    if (event.type === "message.delta") {
      this.draft = { order: this.draft?.order ?? sequence, content: this.text((this.draft?.content ?? "") + event.delta) };
      return sequence;
    } else if (event.type === "message.completed") {
      this.items.push({ order: event.role === "assistant" ? this.draft?.order ?? sequence : sequence,
        kind: "message", role: event.role, content: this.text(event.content) });
      if (event.role === "assistant") this.draft = null;
    } else if (event.type === "activity.started" || event.type === "activity.completed") {
      const id = event.activity.tool_call_id;
      let item = this.items.find(item => item.kind === "activity" && item.tool_call_id === id);
      if (!item || item.kind !== "activity") {
        item = { order: sequence, kind: "activity", tool_call_id: id, summary: event.activity.tool.slice(0, 100), status: "running" };
        this.items.push(item);
      }
      if (event.type === "activity.started") { item.summary = activitySummary(event); item.status = "running"; }
      else item.status = event.activity.is_error ? "failed" : "done";
    } else if (event.type === "error") {
      this.items.push({ order: sequence, kind: "notice", code: event.code, content: this.text(event.message) });
    }
    this.trim();
    return sequence;
  }
  resetTransient(): void {
    this.draft = null;
    this.items = this.items.filter(item => item.kind !== "activity");
    this.sequence++;
  }
  snapshot(): HistorySnapshot {
    return { sequence: this.sequence, items: this.items.map(item => ({ ...item })),
      draft: this.draft ? { ...this.draft } : null, truncated: this.truncated };
  }
}
