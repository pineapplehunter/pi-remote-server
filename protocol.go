package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf16"
)

const maxFrameBytes = 1024 * 1024
const maxTextBytes = 100 * 1024
const maxToolArgsBytes = 16 * 1024

type Message = map[string]any
type ProtocolError struct{ Code, Message string }

func (e *ProtocolError) Error() string                  { return e.Message }
func protocolError(code, message string) *ProtocolError { return &ProtocolError{code, message} }
func stringValue(m Message, k string) string            { s, _ := m[k].(string); return s }
func isString(m Message, k string) bool                 { _, ok := m[k].(string); return ok }
func nonempty(m Message, k string) bool                 { return isString(m, k) && stringValue(m, k) != "" }
func oneOf(v string, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// Match JavaScript String.trim(), used by the browser and the previous gateway.
func trimSpace(s string) string {
	return strings.Trim(s, "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func jsonBytes(value any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(value)
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}

// Validate only explicitly supported fields, dropping unknown properties before forwarding.
func parseMessage(raw []byte, textFrame, agent bool) (Message, *ProtocolError) {
	if !textFrame {
		return nil, protocolError("invalid_message", "Expected a JSON text frame.")
	}
	if len(raw) > maxFrameBytes {
		return nil, protocolError("invalid_message", "Frame exceeds 1 MiB.")
	}
	if !json.Valid(raw) {
		return nil, protocolError("invalid_json", "Expected JSON.")
	}
	var data Message
	if json.Unmarshal(raw, &data) != nil || data == nil {
		return nil, protocolError("invalid_message", "Expected an object.")
	}
	if data["version"] != float64(1) {
		return nil, protocolError("unsupported_version", "Expected protocol version 1.")
	}
	typ := stringValue(data, "type")
	fields := []string{"version", "type", "session_id"}
	valid := nonempty(data, "session_id")
	if agent {
		switch typ {
		case "session.register":
			fields = append(fields, "host_id", "cwd", "name", "pid")
			pid, ok := data["pid"].(float64)
			name, exists := data["name"]
			valid = valid && nonempty(data, "host_id") && isString(data, "cwd") && exists && (name == nil || isString(data, "name")) && ok && pid > 0 && pid <= 1<<53-1 && math.Trunc(pid) == pid
		case "session.updated":
			fields = append(fields, "name")
			name, exists := data["name"]
			valid = valid && exists && (name == nil || isString(data, "name"))
		case "session.unregister":
			fields = append(fields, "reason")
			valid = valid && oneOf(stringValue(data, "reason"), "quit", "reload", "new", "resume", "fork")
		case "session.status":
			fields = append(fields, "status")
			valid = valid && oneOf(stringValue(data, "status"), "idle", "working")
		case "message.delta":
			fields = append(fields, "delta")
			valid = valid && isString(data, "delta")
		case "message.completed":
			fields = append(fields, "role", "content")
			valid = valid && oneOf(stringValue(data, "role"), "user", "assistant") && isString(data, "content")
		case "activity.started", "activity.completed":
			fields = append(fields, "activity")
			a, ok := data["activity"].(map[string]any)
			valid = valid && ok && a["kind"] == "tool" && nonempty(a, "tool_call_id") && nonempty(a, "tool")
			clean := Message{"kind": a["kind"], "tool_call_id": a["tool_call_id"], "tool": a["tool"]}
			if typ == "activity.started" {
				args, exists := a["args"]
				valid = valid && exists && len(jsonBytes(args)) <= maxToolArgsBytes
				clean["args"] = args
				if omitted, exists := a["args_omitted"]; exists {
					valid = valid && omitted == true
					clean["args_omitted"] = omitted
				}
			} else {
				_, ok := a["is_error"].(bool)
				valid = valid && ok
				clean["is_error"] = a["is_error"]
			}
			data["activity"] = clean
		case "error":
			fields = append(fields, "code", "message")
			valid = valid && isString(data, "message") && oneOf(stringValue(data, "code"), "invalid_json", "invalid_message", "unsupported_version", "unsupported_type", "text_too_large", "wrong_session", "injection_failed", "usage_limit_reached")
		default:
			return nil, protocolError("unsupported_type", "Unsupported agent message type.")
		}
	} else {
		if typ != "message.send" && typ != "session.history" {
			return nil, protocolError("unsupported_type", "Unsupported browser message type.")
		}
		fields = append(fields, "registration_id", "request_id")
		valid = valid && nonempty(data, "registration_id")
		if _, ok := data["request_id"]; ok {
			valid = valid && nonempty(data, "request_id") && utf16Len(stringValue(data, "request_id")) <= 128
		}
		if typ == "message.send" {
			fields = append(fields, "text", "delivery")
			valid = valid && isString(data, "text") && trimSpace(stringValue(data, "text")) != ""
			if _, ok := data["delivery"]; ok {
				valid = valid && oneOf(stringValue(data, "delivery"), "steer", "followUp")
			}
		}
	}
	if !valid {
		return nil, protocolError("invalid_message", "Invalid message fields.")
	}
	if !agent && typ == "message.send" && len(stringValue(data, "text")) > maxTextBytes {
		return nil, protocolError("text_too_large", "Text exceeds 100 KiB UTF-8.")
	}
	clean := Message{}
	for _, key := range fields {
		if v, ok := data[key]; ok {
			clean[key] = v
		}
	}
	return clean, nil
}
