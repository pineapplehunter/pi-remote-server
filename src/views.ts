import type { Session } from "./registry.ts";

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
  return `<div class="welcome"><h2>Pi remote</h2><p>Select a running session to chat.</p><p class="hint">Live text only. Conversation history stays in Pi.</p></div>`;
}

export function selectedSession(session: Session): string {
  return `<section class="conversation" data-registration-id="${escapeHtml(session.registration_id)}" data-session-id="${escapeHtml(session.session_id)}">
    <header class="chat-header"><button class="back" hx-get="/ui/empty" hx-target="#detail">‹ Sessions</button><div>
      <h2 id="session-name">${escapeHtml(session.name ?? session.session_id)}</h2>
      <p class="hint">${escapeHtml(session.host_id)} · PID ${session.pid} · <span id="session-status">${session.status ?? "connecting"}</span></p></div></header>
    <div class="feed"><p class="hint">Live feed from when you select this session; no earlier messages are loaded.</p>
      <div id="messages" role="log" aria-label="Chat messages"></div>
      <aside class="activities"><h3>Activity</h3><ul id="activity" aria-label="Tool activity"></ul></aside>
    </div>
    <p id="chat-error" class="error" role="alert"></p>
    <form id="compose"><label class="sr-only" for="text">Message Pi</label><textarea id="text" name="text" rows="2" placeholder="Message Pi…" required></textarea><button type="submit" disabled>Send</button></form>
    <p class="hint delivery">Input is literal text. Busy Pi queues follow-ups. No delivery guarantee; do not automatically retry.</p>
  </section>`;
}

export function page(sessions: Session[], selected?: Session): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="htmx-config" content='{"allowEval":false,"allowScriptTags":false,"includeIndicatorStyles":false,"historyCacheSize":0}'>
    <title>Pi remote</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/public/style.css"><script src="/public/htmx.min.js" defer></script><script src="/public/app.js" defer></script>
    </head><body><div class="connection-bar"><span>Pi remote</span><span id="connection" role="status">Connecting…</span></div>
    <main id="app"><aside id="sessions" hx-get="/ui/sessions" hx-trigger="sessions-changed" hx-swap="innerHTML" hx-sync="this:replace">${sessionList(sessions)}</aside>
    <div id="detail">${selected ? selectedSession(selected) : emptyDetail()}</div></main><noscript>Enable JavaScript for live chat.</noscript></body></html>`;
}
