package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func envelope(fields Message) []byte {
	m := Message{"version": 1, "session_id": "s1"}
	for k, v := range fields {
		m[k] = v
	}
	return jsonBytes(m)
}
func TestAgentProtocol(t *testing.T) {
	for _, fields := range []Message{
		{"type": "session.register", "host_id": "laptop", "cwd": "/work", "name": nil, "pid": 123},
		{"type": "session.updated", "name": "Debug tests"}, {"type": "session.updated", "name": nil},
		{"type": "session.unregister", "reason": "quit"}, {"type": "session.status", "status": "working"}, {"type": "session.status", "status": "idle"},
		{"type": "message.delta", "delta": "text"}, {"type": "message.completed", "role": "user", "content": "hello"}, {"type": "message.completed", "role": "assistant", "content": ""},
		{"type": "activity.started", "activity": Message{"kind": "tool", "tool_call_id": "c1", "tool": "bash", "args": Message{"command": "test"}}},
		{"type": "activity.started", "activity": Message{"kind": "tool", "tool_call_id": "c2", "tool": "read", "args": nil, "args_omitted": true}},
		{"type": "activity.completed", "activity": Message{"kind": "tool", "tool_call_id": "c1", "tool": "bash", "is_error": false}},
		{"type": "error", "code": "usage_limit_reached", "message": "Usage exhausted"},
	} {
		m, err := parseMessage(envelope(fields), true, true)
		if err != nil || m["type"] != fields["type"] {
			t.Fatalf("%v: %v", fields["type"], err)
		}
	}
	for _, fields := range []Message{
		{"type": "session.status", "status": "online"}, {"type": "session.status", "session_id": "", "status": "idle"},
		{"type": "session.register", "host_id": "laptop", "cwd": "/", "name": nil, "pid": -1},
		{"type": "session.register", "host_id": "laptop", "cwd": "/", "name": nil, "pid": 1e30},
		{"type": "session.register", "host_id": "laptop", "cwd": "/", "pid": 1},
		{"type": "message.completed", "role": "system", "content": "text"}, {"type": "message.delta", "delta": Message{}},
		{"type": "activity.completed", "activity": Message{"kind": "tool", "tool_call_id": "c", "tool": "bash", "is_error": "false"}},
		{"type": "activity.started", "activity": Message{"kind": "tool", "tool_call_id": "c", "tool": "bash", "args": strings.Repeat("x", 16385)}},
		{"type": "activity.started", "activity": Message{"kind": "tool", "tool_call_id": "c", "tool": "bash"}},
	} {
		_, err := parseMessage(envelope(fields), true, true)
		if err == nil || err.Code != "invalid_message" {
			t.Fatalf("invalid fields accepted: %v (%v)", fields["type"], err)
		}
	}
	for _, tc := range []struct {
		raw  string
		text bool
		code string
	}{
		{"{", true, "invalid_json"}, {"{}", false, "invalid_message"}, {"null", true, "invalid_message"}, {"[]", true, "invalid_message"}, {"42", true, "invalid_message"},
		{`{"version":"1"}`, true, "unsupported_version"}, {`{"version":2}`, true, "unsupported_version"}, {`{"version":1,"type":"toString"}`, true, "unsupported_type"},
		{strings.Repeat(" ", maxFrameBytes+1), true, "invalid_message"},
	} {
		_, err := parseMessage([]byte(tc.raw), tc.text, true)
		if err == nil || err.Code != tc.code {
			t.Fatalf("expected %s, got %v", tc.code, err)
		}
	}
	m, err := parseMessage(envelope(Message{"type": "message.delta", "delta": "hi", "secret": "hidden"}), true, true)
	if err != nil || len(m) != 4 || m["secret"] != nil {
		t.Fatal("unknown fields forwarded")
	}
}
func TestBrowserProtocol(t *testing.T) {
	input := Message{"version": 1, "type": "message.send", "registration_id": "r1", "session_id": "s1", "text": "  hello\n"}
	m, err := parseMessage(jsonBytes(input), true, false)
	if err != nil || m["text"] != input["text"] {
		t.Fatal("whitespace not preserved", err)
	}
	for _, delivery := range []string{"steer", "followUp"} {
		input["delivery"] = delivery
		if _, err := parseMessage(jsonBytes(input), true, false); err != nil {
			t.Fatal(err)
		}
	}
	for _, delivery := range []any{"followup", "abort", nil, 3} {
		input["delivery"] = delivery
		if _, err := parseMessage(jsonBytes(input), true, false); err == nil {
			t.Fatal("invalid delivery accepted")
		}
	}
	delete(input, "delivery")
	for _, tc := range []struct{ text, code string }{{strings.Repeat("x", maxTextBytes), ""}, {strings.Repeat("é", maxTextBytes/2+1), "text_too_large"}, {" \n", "invalid_message"}, {"\ufeff", "invalid_message"}, {"\u0085", ""}} {
		input["text"] = tc.text
		_, err := parseMessage(jsonBytes(input), true, false)
		if (err == nil) != (tc.code == "") || (err != nil && err.Code != tc.code) {
			t.Fatal(tc.code, err)
		}
	}
	input["type"] = "session.history"
	delete(input, "text")
	if _, err := parseMessage(jsonBytes(input), true, false); err != nil {
		t.Fatal(err)
	}
	for _, requestID := range []any{"", strings.Repeat("💬", 65), nil} {
		input["request_id"] = requestID
		if _, err := parseMessage(jsonBytes(input), true, false); err == nil {
			t.Fatal("invalid request ID accepted")
		}
	}
	// Nested extras must not leak either.
	m, err = parseMessage(envelope(Message{"type": "activity.started", "activity": Message{"kind": "tool", "tool_call_id": "c", "tool": "read", "args": json.RawMessage(`{}`), "secret": "hidden"}}), true, true)
	if err != nil || len(m["activity"].(map[string]any)) != 4 {
		t.Fatal("nested fields not stripped", err)
	}
}
