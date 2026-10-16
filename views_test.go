package main

import (
	"strings"
	"testing"
)

func TestViews(t *testing.T) {
	attack := `"><img src=x onerror=alert(1)>&'`
	session := Session{RegistrationID: attack, SessionID: attack, HostID: attack, Cwd: attack, Name: &attack, PID: 1234567}
	var history SessionHistory
	history.record(Message{"type": "message.completed", "role": "user", "content": attack})
	history.record(Message{"type": "message.delta", "delta": attack})
	history.record(Message{"type": "activity.started", "activity": Message{"tool": "read", "tool_call_id": attack, "args": Message{"path": attack}}})
	for _, name := range []string{"sessions", "selected"} {
		var data any = []Session{session}
		if name == "selected" {
			data = selectedView(session, history.snapshot())
		}
		html, err := render(name, data)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(html, "<img") || !strings.Contains(html, "&lt;img") {
			t.Fatal("unescaped metadata/history")
		}
		if !strings.Contains(html, "PID 1234567") {
			t.Fatal("PID must not use scientific notation")
		}
	}
}
