(() => {
  "use strict";
  const app = document.getElementById("app");
  const connection = document.getElementById("connection");
  let socket;
  let retry;
  let delay = 1000;
  let selected;
  let draft;
  let available = false;
  let lastSubmission;
  const activities = new Map();
  const MAX_ITEMS = 200;

  function refreshSessions() {
    window.htmx.trigger(document.getElementById("sessions"), "sessions-changed");
  }
  function syncSend() {
    const button = document.querySelector("#compose button");
    if (button) button.disabled = !available || socket?.readyState !== WebSocket.OPEN;
  }
  function showError(text) {
    const error = document.getElementById("chat-error");
    if (error) error.textContent = text;
    else connection.textContent = text;
  }
  function resetTransient() {
    if (draft) draft.remove();
    draft = undefined;
    activities.clear();
    document.getElementById("activity")?.replaceChildren();
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
    if (draft) {
      draft.classList.remove("streaming");
      draft.querySelector("strong").textContent = "Pi (interrupted)";
      // Retain the draft across browser reconnects so a final can replace it.
    }
    syncSend();
  }
  function activate() {
    const element = document.querySelector(".conversation");
    selected = element ? { registrationId: element.dataset.registrationId, sessionId: element.dataset.sessionId } : undefined;
    draft = undefined;
    activities.clear();
    available = !!selected;
    app.classList.toggle("chat-open", !!selected);
    syncSend();
  }
  function prune(parent) {
    while (parent.children.length > MAX_ITEMS) parent.firstElementChild.remove();
  }
  function addMessage(role, content) {
    const parent = document.getElementById("messages");
    const element = document.createElement("article");
    element.className = `message ${role}`;
    const label = document.createElement("strong");
    label.textContent = role === "user" ? "You" : "Pi";
    const body = document.createElement("p");
    body.textContent = content;
    element.append(label, body);
    parent.append(element);
    prune(parent);
    return element;
  }
  function activity(event) {
    const data = event.activity;
    const parent = document.getElementById("activity");
    let item = activities.get(data.tool_call_id);
    if (!item) {
      item = document.createElement("li");
      parent.append(item);
      activities.set(data.tool_call_id, item);
      if (activities.size > MAX_ITEMS) {
        const oldest = activities.keys().next().value;
        activities.get(oldest).remove();
        activities.delete(oldest);
      }
    }
    if (event.type === "activity.started") {
      const args = data.args && typeof data.args === "object" ? data.args : {};
      const detail = [args.path, args.file_path, args.command].find(value => typeof value === "string");
      item.dataset.summary = `${data.tool.slice(0, 100)}${detail ? `: ${detail.slice(0, 180)}` : ""}${data.args_omitted ? " (arguments omitted)" : ""}`;
      item.textContent = `${item.dataset.summary} — running`;
      item.className = "running";
    } else {
      item.textContent = `${item.dataset.summary ?? data.tool.slice(0, 100)} — ${data.is_error ? "failed" : "done"}`;
      item.className = data.is_error ? "failed" : "done";
    }
  }
  function receive(event) {
    if (event.version !== 1) return;
    if (event.type === "sessions.snapshot") {
      refreshSessions();
      if (selected) {
        const current = event.sessions.find(session => session.registration_id === selected.registrationId);
        if (current) updateMetadata(current);
        else offline();
      }
      return;
    }
    if (["session.added", "session.updated", "session.removed", "session.status"].includes(event.type)) {
      refreshSessions();
      if (event.session) {
        updateMetadata(event.session);
        if (event.reset && event.session.registration_id === selected?.registrationId) resetTransient();
      } else if (event.registration_id === selected?.registrationId) {
        if (event.type === "session.removed") { offline(); resetTransient(); }
        else document.getElementById("session-status").textContent = event.status;
      }
      return;
    }
    if (event.type === "gateway.error") {
      if (!event.registration_id || event.registration_id === selected?.registrationId) showError(event.message);
      else connection.textContent = event.message;
      if (event.request_id === lastSubmission?.requestId && selected?.registrationId === lastSubmission.registrationId) {
        const text = document.getElementById("text");
        if (!text.value) text.value = lastSubmission.text;
      }
      return;
    }
    if (event.registration_id !== selected?.registrationId) return;
    const feed = document.querySelector(".feed");
    const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
    if (event.type === "message.delta") {
      if (!draft) {
        draft = addMessage("assistant", "");
        draft.classList.add("streaming");
      }
      draft.querySelector("strong").textContent = "Pi";
      draft.classList.add("streaming");
      draft.querySelector("p").append(document.createTextNode(event.delta));
    } else if (event.type === "message.completed") {
      if (event.role === "assistant" && draft) {
        draft.querySelector("p").textContent = event.content;
        draft.querySelector("strong").textContent = "Pi";
        draft.classList.remove("streaming");
        draft = undefined;
      } else addMessage(event.role, event.content);
      if (event.role === "user") showError("");
    } else if (event.type === "activity.started" || event.type === "activity.completed") activity(event);
    else if (event.type === "error") showError(`Pi: ${event.code} — ${event.message}`);
    if (follow) feed.scrollTop = feed.scrollHeight;
  }
  function connect() {
    clearTimeout(retry);
    available = false;
    syncSend();
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    socket.addEventListener("open", () => {
      delay = 1000;
      connection.textContent = "Live";
      // Enable sending only once the authoritative snapshot confirms the selection.
      syncSend();
    });
    socket.addEventListener("message", event => {
      try { receive(JSON.parse(event.data)); }
      catch { showError("Could not read a gateway event. Reload to reconnect."); }
    });
    socket.addEventListener("error", () => { connection.textContent = "Connection error"; });
    socket.addEventListener("close", () => {
      connection.textContent = "Disconnected; reconnecting. Events may have been missed.";
      offline();
      activities.clear();
      document.getElementById("activity")?.replaceChildren();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    });
  }
  document.addEventListener("htmx:afterSwap", event => {
    if (event.detail.target.id === "detail") activate();
  });
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
