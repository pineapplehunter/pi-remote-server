import type { Session } from "./registry.ts";
import { SessionHistory, type HistorySnapshot, type HistoryItem } from "./history.ts";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export function sessionList(sessions: Session[]): string {
  return `<h1>Sessions</h1><p class="hint">Running Pi processes. Start new sessions on your host.</p>
    <nav aria-label="Pi sessions">${sessions.length ? sessions.map(session => {
      const url = `/ui/sessions/${encodeURIComponent(session.registration_id)}`;
      return `<a class="session-link" href="/?session=${encodeURIComponent(session.registration_id)}" hx-get="${url}" hx-target="#detail" hx-swap="innerHTML" data-registration-id="${escapeHtml(session.registration_id)}">
        <span class="dot ${session.status ?? "unknown"}" aria-hidden="true"></span><span>
        <strong>${escapeHtml(session.name ?? session.session_id)}</strong>
        <small>${escapeHtml(session.host_id)} · PID ${session.pid} · ${session.status ?? "connecting"}</small>
        <small>${escapeHtml(session.cwd)}</small></span></a>`;
    }).join("") : `<p class="empty">No Pi sessions connected. Enable the remote extension on a running Pi process.</p>`}</nav>`;
}
export function emptyDetail(): string {
  return `<div class="welcome"><h2>Pi remote</h2><p>Select a running session to chat.</p><p class="hint">Recent output is buffered while Pi stays connected. Full history stays in Pi.</p></div>`;
}
function message(role: string, content: string, order: number, streaming = false): string {
  return `<article class="message ${role}${streaming ? " streaming" : ""}" data-order="${order}"><strong>${role === "user" ? "You" : "Pi"}</strong><div class="message-body">${escapeHtml(content)}</div></article>`;
}
function historyItem(item: HistoryItem): string {
  if (item.kind === "message") return message(item.role, item.content, item.order);
  if (item.kind === "notice") return `<article class="notice" data-order="${item.order}"><strong>Pi: ${escapeHtml(item.code)}</strong><p>${escapeHtml(item.content)}</p></article>`;
  return `<div class="activity ${item.status}" data-order="${item.order}" data-call-id="${escapeHtml(item.tool_call_id)}" data-summary="${escapeHtml(item.summary)}">${escapeHtml(item.summary)} — ${item.status}</div>`;
}
export function selectedSession(session: Session, history: HistorySnapshot = new SessionHistory().snapshot()): string {
  const items = history.items.map(item => ({ order: item.order, html: historyItem(item) }));
  if (history.draft) items.push({ order: history.draft.order, html: message("assistant", history.draft.content, history.draft.order, true) });
  items.sort((a, b) => a.order - b.order);
  return `<section class="conversation" data-registration-id="${escapeHtml(session.registration_id)}" data-session-id="${escapeHtml(session.session_id)}" data-sequence="${history.sequence}">
    <header class="chat-header"><button class="back" hx-get="/ui/empty" hx-target="#detail">‹ Sessions</button><div>
      <h2 id="session-name">${escapeHtml(session.name ?? session.session_id)}</h2>
      <p class="hint">${escapeHtml(session.host_id)} · PID ${session.pid} · <span id="session-status">${session.status ?? "connecting"}</span></p></div></header>
    <div class="feed"><p id="history-info" class="hint">${history.truncated ? "Recent buffered output; older entries or long text have been trimmed." : "Recent output captured while this Pi connection stays online. No earlier Pi history is loaded."}</p>
      <div id="messages" role="log" aria-label="Conversation and activity">${items.map(item => item.html).join("")}</div>
    </div>
    <p id="chat-error" class="error" role="alert"></p>
    <form id="compose"><label class="sr-only" for="text">Message Pi</label><textarea id="text" name="text" rows="2" placeholder="Message Pi…" required></textarea><button type="submit" disabled>Send</button></form>
    <p class="hint delivery">Input is literal text. Busy Pi queues follow-ups. No delivery guarantee; do not automatically retry.</p>
  </section>`;
}
export function page(sessions: Session[], selected?: Session, history?: HistorySnapshot): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="htmx-config" content='{"allowEval":false,"allowScriptTags":false,"includeIndicatorStyles":false,"historyCacheSize":0}'>
    <title>Pi remote</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/public/style.css"><script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js" integrity="sha384-/TgkGk7p307TH7EXJDuUlgG3Ce1UVolAOFopFekQkkXihi5u/6OCvVKyz1W+idaz" crossorigin="anonymous" defer></script><script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.umd.js" integrity="sha384-fGlgqlm/GUgiVEyV6lvBJbxjprBPT1g0VoE9o/FjCWntEwOQYGqANQdFeFlqbObP" crossorigin="anonymous" defer></script><script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.3/dist/purify.min.js" integrity="sha384-pcBjnGbkyKeOXaoFkmJiuR9E08/6gkmus6/Strimnxtl3uk0Hx23v345pWyC/MMr" crossorigin="anonymous" defer></script><script src="/public/app.js" defer></script>
    </head><body><div class="connection-bar"><span>Pi remote</span><span id="connection" role="status">Connecting…</span></div>
    <main id="app"><aside id="sessions" hx-get="/ui/sessions" hx-trigger="sessions-changed" hx-swap="innerHTML" hx-sync="this:replace">${sessionList(sessions)}</aside>
    <div id="detail">${selected ? selectedSession(selected, history) : emptyDetail()}</div></main><noscript>Enable JavaScript for live chat.</noscript></body></html>`;
}
