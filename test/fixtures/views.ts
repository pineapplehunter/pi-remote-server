// Render browser fixtures through the real Go HTTP server, never duplicate its templates.
import { harness, register } from "../helpers.ts";
import { SessionHistory } from "./history.ts";
import type { Session } from "./protocol.ts";

async function view(selected?: Session, history = new SessionHistory(), fragment = false) {
  const h = await harness();
  try {
    if (!selected) return await (await fetch(h.base)).text();
    const agent = await h.agent();
    const browser = await h.browser();
    register(agent, { session_id: selected.session_id, cwd: selected.cwd, name: selected.name, pid: selected.pid });
    const id = (await browser.take("session.added")).session.registration_id;
    if (selected.status) {
      agent.send({ version: 1, type: "session.status", session_id: selected.session_id, status: selected.status });
      await browser.take("session.status");
    }
    for (const event of history.events) { agent.send(event); await browser.take(event.type); }
    const url = fragment ? `/ui/sessions/${id}` : `/?session=${id}`;
    return (await (await fetch(h.base + url)).text()).replaceAll(id, selected.registration_id);
  } finally { h.stop(); }
}
export function page(_sessions: Session[], selected?: Session, history?: SessionHistory) { return view(selected, history); }
export function selectedSession(session: Session, history?: SessionHistory) { return view(session, history, true); }
