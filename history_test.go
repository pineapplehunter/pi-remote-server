package main

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestHistory(t *testing.T) {
	var h SessionHistory
	h.record(Message{"type": "message.completed", "role": "user", "content": "prompt"})
	h.record(Message{"type": "message.delta", "delta": "partial"})
	h.record(Message{"type": "activity.started", "activity": Message{"tool_call_id": "c", "tool": "read", "args": Message{"path": "/work/file"}}})
	h.record(Message{"type": "activity.completed", "activity": Message{"tool_call_id": "c", "tool": "read", "is_error": false}})
	h.record(Message{"type": "message.completed", "role": "assistant", "content": "final"})
	snapshot := h.snapshot()
	if snapshot.Draft != nil || len(snapshot.Items) != 3 || snapshot.Items[1]["content"] != "final" || snapshot.Items[2]["summary"] != "read: /work/file" || snapshot.Items[2]["status"] != "done" {
		t.Fatal(snapshot)
	}
	snapshot.Items[0]["content"] = "mutated"
	if h.snapshot().Items[0]["content"] != "prompt" {
		t.Fatal("snapshot not isolated")
	}
	for i := 0; i < maxHistoryItems+10; i++ {
		h.record(Message{"type": "message.completed", "role": "user", "content": fmt.Sprint(i)})
	}
	snapshot = h.snapshot()
	if len(snapshot.Items) != maxHistoryItems || !snapshot.Truncated || snapshot.Items[0]["content"] != "10" {
		t.Fatal("item limit not enforced")
	}
	for i := 0; i < 20; i++ {
		h.record(Message{"type": "message.completed", "role": "assistant", "content": strings.Repeat("💬", maxHistoryText)})
	}
	h.record(Message{"type": "message.delta", "delta": strings.Repeat("x", maxHistoryText*2)})
	snapshot = h.snapshot()
	if len(jsonBytes(snapshot.Items)) > maxHistoryBytes || len(jsonBytes(snapshot)) >= maxFrameBytes || utf16Len(snapshot.Draft.Content) >= maxHistoryText+50 {
		t.Fatal("history budget exceeded")
	}
	h.resetTransient()
	if h.snapshot().Sequence <= snapshot.Sequence || h.snapshot().Draft != nil || len(h.snapshot().Items) == 0 {
		t.Fatal("reset lost completed history")
	}
	if clipped := clipText("x"+strings.Repeat("💬", 4), 4); clipped != "x💬" || !utf8.ValidString(clipped) {
		t.Fatalf("surrogate split: %q", clipped)
	}
}

func TestStaleSocket(t *testing.T) {
	r := newRegistry()
	agent := &Socket{closed: true, hostID: "laptop"}
	browser := &Socket{queue: make(chan []byte, 2), done: make(chan struct{})}
	r.agents[agent] = true
	r.register(agent, Message{"session_id": "s1", "pid": float64(1), "cwd": "/", "name": nil})
	id := r.list()[0].RegistrationID
	r.browserMessage(browser, envelope(Message{"type": "message.send", "registration_id": id, "text": "test"}), true)
	reply := string(<-browser.queue)
	if !strings.Contains(reply, `"code":"session_unavailable"`) || len(r.sessions) != 0 {
		t.Fatal(reply)
	}
	// A closed socket cannot accept or retain any outbound payload.
	if agent.send(Message{"text": "not queued"}) {
		t.Fatal("closed socket accepted data")
	}
}
