(() => {
  "use strict";
  const app = document.getElementById("app");
  const connection = document.getElementById("connection");
  if (!window.htmx || !window.marked || !window.DOMPurify?.isSupported) {
    connection.textContent = "Browser libraries could not load. Allow cdn.jsdelivr.net and reload.";
    return;
  }
  let socket, retry, selected, draft, lastSubmission;
  let delay = 1000;
  let available = false;
  let awaitingHistory = false;
  let sequence = 0;
  let firstHistory = true;
  const activities = new Map();
  const MAX_ITEMS = 400;

  function refreshSessions() { window.htmx.trigger(document.getElementById("sessions"), "sessions-changed"); }
  function syncSend() {
    const button = document.querySelector("#compose button");
    if (button) button.disabled = !available || socket?.readyState !== WebSocket.OPEN;
  }
  function showError(text) {
    const error = document.getElementById("chat-error");
    if (error) error.textContent = text;
    else connection.textContent = text;
  }
  function markdown(body, text) {
    // Parse Markdown, then insert only a sanitized DOM fragment. Raw model HTML
    // never reaches innerHTML; no images, SVG, forms or HTMX/data attributes.
    const safe = window.DOMPurify.sanitize(window.marked.parse(text, { async: false, gfm: true }), {
      RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, USE_PROFILES: { html: true },
      FORBID_TAGS: ["img", "svg", "math", "style", "iframe", "form", "input", "button", "textarea", "select", "option"],
      FORBID_ATTR: ["style", "id", "name", "class"],
    });
    body.replaceChildren(safe);
    body.classList.add("rendered");
  }
  function updateMetadata(session) {
    if (session.registration_id !== selected?.registrationId) return;
    document.getElementById("session-name").textContent = session.name ?? session.session_id;
    document.getElementById("session-status").textContent = session.status ?? "connecting";
    available = true;
    syncSend();
  }
  function offline() {
    available = false;
    const status = document.getElementById("session-status");
    if (status) status.textContent = "offline";
    if (draft) { draft.classList.remove("streaming"); draft.querySelector("strong").textContent = "Pi (interrupted)"; }
    syncSend();
  }
  function requestHistory() {
    if (!selected || !available || socket?.readyState !== WebSocket.OPEN) return;
    awaitingHistory = true;
    socket.send(JSON.stringify({ version: 1, type: "session.history", registration_id: selected.registrationId, session_id: selected.sessionId }));
  }
  function activate() {
    const element = document.querySelector(".conversation");
    selected = element ? { registrationId: element.dataset.registrationId, sessionId: element.dataset.sessionId } : undefined;
    sequence = Number(element?.dataset.sequence ?? 0);
    awaitingHistory = false;
    firstHistory = true;
    draft = element?.querySelector(".streaming");
    activities.clear();
    element?.querySelectorAll(".activity").forEach(item => activities.set(item.dataset.callId, item));
    element?.querySelectorAll(".message:not(.streaming) .message-body").forEach(body => markdown(body, body.textContent));
    available = !!selected;
    app.classList.toggle("chat-open", !!selected);
    const feed = document.querySelector(".feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
    syncSend();
    requestHistory();
  }
  function prune() {
    const parent = document.getElementById("messages");
    while (parent.children.length > MAX_ITEMS + (draft ? 1 : 0)) {
      const oldest = [...parent.children].find(item => item !== draft);
      if (!oldest) break;
      if (oldest.dataset.callId) activities.delete(oldest.dataset.callId);
      oldest.remove();
    }
  }
  function addMessage(role, content, order, streaming = false) {
    const element = document.createElement("article");
    element.className = `message ${role}${streaming ? " streaming" : ""}`;
    element.dataset.order = order;
    const label = document.createElement("strong");
    label.textContent = role === "user" ? "You" : "Pi";
    const body = document.createElement("div");
    body.className = "message-body";
    if (streaming) body.textContent = content;
    else markdown(body, content);
    element.append(label, body);
    document.getElementById("messages").append(element);
    return element;
  }
  function notice(code, content, order) {
    const element = document.createElement("article");
    element.className = "notice";
    element.dataset.order = order;
    element.setAttribute("role", "alert");
    const label = document.createElement("strong");
    label.textContent = `Pi: ${code}`;
    const body = document.createElement("p");
    body.textContent = content;
    element.append(label, body);
    document.getElementById("messages").append(element);
  }
  function setActivity(data, order) {
    let item = activities.get(data.tool_call_id);
    if (!item) {
      item = document.createElement("div");
      item.dataset.callId = data.tool_call_id;
      item.dataset.order = order;
      document.getElementById("messages").append(item);
      activities.set(data.tool_call_id, item);
    }
    item.dataset.summary = data.summary;
    item.textContent = `${data.summary} — ${data.status}`;
    item.className = `activity ${data.status}`;
  }
  function activity(event) {
    const data = event.activity;
    let summary = activities.get(data.tool_call_id)?.dataset.summary ?? data.tool.slice(0, 100);
    if (event.type === "activity.started") {
      const args = data.args && typeof data.args === "object" ? data.args : {};
      const detail = [args.path, args.file_path, args.command].find(value => typeof value === "string");
      summary = `${data.tool.slice(0, 100)}${detail ? `: ${detail.slice(0, 180)}` : ""}${data.args_omitted ? " (arguments omitted)" : ""}`;
    }
    setActivity({ tool_call_id: data.tool_call_id, summary,
      status: event.type === "activity.started" ? "running" : data.is_error ? "failed" : "done" }, event.sequence);
  }
  function restoreHistory(history) {
    const feed = document.querySelector(".feed");
    const parent = document.getElementById("messages");
    const follow = firstHistory || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
    const anchor = [...parent.children].find(item => item.offsetTop + item.offsetHeight >= feed.scrollTop);
    const order = anchor?.dataset.order;
    const offset = anchor ? anchor.offsetTop - feed.scrollTop : 0;
    parent.replaceChildren();
    draft = undefined;
    activities.clear();
    const items = [...history.items];
    if (history.draft) items.push({ kind: "draft", ...history.draft });
    items.sort((a, b) => a.order - b.order);
    for (const item of items) {
      if (item.kind === "message") addMessage(item.role, item.content, item.order);
      else if (item.kind === "draft") draft = addMessage("assistant", item.content, item.order, true);
      else if (item.kind === "notice") notice(item.code, item.content, item.order);
      else setActivity(item, item.order);
    }
    document.getElementById("history-info").textContent = history.truncated
      ? "Recent buffered output; older entries or long text have been trimmed."
      : "Recent output captured while this Pi connection stays online. No earlier Pi history is loaded.";
    if (follow) feed.scrollTop = feed.scrollHeight;
    else {
      const restored = [...parent.children].find(item => item.dataset.order === order);
      if (restored) feed.scrollTop = restored.offsetTop - offset;
    }
    firstHistory = false;
    sequence = history.sequence;
    awaitingHistory = false;
  }
  function receive(event) {
    if (event.version !== 1) return;
    if (event.type === "sessions.snapshot") {
      refreshSessions();
      if (selected) {
        const current = event.sessions.find(session => session.registration_id === selected.registrationId);
        if (current) { updateMetadata(current); requestHistory(); }
        else offline();
      }
      return;
    }
    if (["session.added", "session.updated", "session.removed", "session.status"].includes(event.type)) {
      refreshSessions();
      if (event.session) {
        updateMetadata(event.session);
        if (event.reset && event.session.registration_id === selected?.registrationId) requestHistory();
      } else if (event.registration_id === selected?.registrationId) {
        if (event.type === "session.removed") { awaitingHistory = false; offline(); }
        else document.getElementById("session-status").textContent = event.status;
      }
      return;
    }
    if (event.type === "gateway.error") {
      if (!event.registration_id || event.registration_id === selected?.registrationId) { awaitingHistory = false; showError(event.message); }
      else connection.textContent = event.message;
      if (event.request_id === lastSubmission?.requestId && selected?.registrationId === lastSubmission.registrationId) {
        const text = document.getElementById("text");
        if (!text.value) text.value = lastSubmission.text;
      }
      return;
    }
    if (event.registration_id !== selected?.registrationId) return;
    if (event.type === "session.history") {
      if (event.history.sequence >= sequence) restoreHistory(event.history);
      return;
    }
    if (awaitingHistory || (event.sequence !== undefined && event.sequence <= sequence)) return;
    if (event.sequence !== undefined) sequence = event.sequence;
    const feed = document.querySelector(".feed");
    const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
    if (event.type === "message.delta") {
      if (!draft) draft = addMessage("assistant", "", event.sequence, true);
      draft.querySelector("strong").textContent = "Pi";
      draft.classList.add("streaming");
      draft.querySelector(".message-body").append(document.createTextNode(event.delta));
    } else if (event.type === "message.completed") {
      if (event.role === "assistant" && draft) {
        markdown(draft.querySelector(".message-body"), event.content);
        draft.querySelector("strong").textContent = "Pi";
        draft.classList.remove("streaming");
        draft = undefined;
      } else addMessage(event.role, event.content, event.sequence);
      if (event.role === "user") showError("");
    } else if (event.type === "activity.started" || event.type === "activity.completed") activity(event);
    else if (event.type === "error") notice(event.code, event.message, event.sequence);
    prune();
    if (follow) feed.scrollTop = feed.scrollHeight;
  }
  function connect() {
    clearTimeout(retry);
    available = false;
    syncSend();
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    socket.addEventListener("open", () => { delay = 1000; connection.textContent = "Live"; syncSend(); });
    socket.addEventListener("message", event => {
      try { receive(JSON.parse(event.data)); }
      catch { showError("Could not read a gateway event. Reload to reconnect."); }
    });
    socket.addEventListener("error", () => { connection.textContent = "Connection error"; });
    socket.addEventListener("close", () => {
      connection.textContent = "Disconnected; reconnecting. Recent output will be restored if Pi stays online.";
      offline();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    });
  }
  document.addEventListener("htmx:afterSwap", event => { if (event.detail.target.id === "detail") activate(); });
  document.addEventListener("htmx:responseError", () => showError("This view is no longer available. Select a live session."));
  document.addEventListener("htmx:sendError", () => showError("Cannot load sessions. Check your connection or proxy login."));
  document.addEventListener("submit", event => {
    if (event.target.id !== "compose") return;
    event.preventDefault();
    const text = document.getElementById("text");
    if (!selected || !available || socket?.readyState !== WebSocket.OPEN) { showError("Not connected. Your message was not sent."); return; }
    if (!text.value.trim()) return;
    if (new TextEncoder().encode(text.value).length > 102400) { showError("Message exceeds 100 KiB UTF-8."); return; }
    const requestId = crypto.randomUUID();
    try {
      socket.send(JSON.stringify({ version: 1, type: "message.send", registration_id: selected.registrationId,
        session_id: selected.sessionId, text: text.value, request_id: requestId }));
      lastSubmission = { requestId, registrationId: selected.registrationId, text: text.value };
      text.value = "";
      showError("Forwarding; wait for Pi's user echo. Delivery is not guaranteed.");
    } catch { showError("Send failed. Your message was not sent."); }
  });
  activate();
  connect();
})();
