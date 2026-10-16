package main

import (
	"sort"
	"unicode/utf16"
)

const maxHistoryItems = 400
const maxHistoryBytes = 512 * 1024
const maxHistoryText = 64 * 1024

type Draft struct {
	Order   uint64 `json:"order"`
	Content string `json:"content"`
}
type HistorySnapshot struct {
	Sequence  uint64    `json:"sequence"`
	Items     []Message `json:"items"`
	Draft     *Draft    `json:"draft"`
	Truncated bool      `json:"truncated"`
}
type SessionHistory struct {
	sequence  uint64
	items     []Message
	draft     *Draft
	truncated bool
}

func clipText(s string, limit int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= limit {
		return s
	}
	if limit > 0 && units[limit-1] >= 0xd800 && units[limit-1] <= 0xdbff {
		limit--
	}
	return string(utf16.Decode(units[:limit]))
}
func (h *SessionHistory) text(s string) string {
	if utf16Len(s) <= maxHistoryText {
		return s
	}
	h.truncated = true
	return clipText(s, maxHistoryText) + "\n[History text truncated]"
}
func activitySummary(event Message) string {
	a := event["activity"].(map[string]any)
	args, _ := a["args"].(map[string]any)
	detail := ""
	for _, key := range []string{"path", "file_path", "command"} {
		if v, ok := args[key].(string); ok {
			detail = v
			break
		}
	}
	result := clipText(stringValue(a, "tool"), 100)
	if detail != "" {
		result += ": " + clipText(detail, 180)
	}
	if a["args_omitted"] == true {
		result += " (arguments omitted)"
	}
	return result
}
func (h *SessionHistory) record(event Message) uint64 {
	typ := stringValue(event, "type")
	if !oneOf(typ, "message.delta", "message.completed", "activity.started", "activity.completed", "error") {
		return 0
	}
	h.sequence++
	seq := h.sequence
	switch typ {
	case "message.delta":
		if h.draft == nil {
			h.draft = &Draft{Order: seq}
		}
		h.draft.Content = h.text(h.draft.Content + stringValue(event, "delta"))
		return seq
	case "message.completed":
		order := seq
		if event["role"] == "assistant" && h.draft != nil {
			order = h.draft.Order
		}
		h.items = append(h.items, Message{"order": order, "kind": "message", "role": event["role"], "content": h.text(stringValue(event, "content"))})
		if event["role"] == "assistant" {
			h.draft = nil
		}
	case "activity.started", "activity.completed":
		a := event["activity"].(map[string]any)
		var item Message
		for _, candidate := range h.items {
			if candidate["kind"] == "activity" && candidate["tool_call_id"] == a["tool_call_id"] {
				item = candidate
				break
			}
		}
		if item == nil {
			item = Message{"order": seq, "kind": "activity", "tool_call_id": a["tool_call_id"], "summary": clipText(stringValue(a, "tool"), 100), "status": "running"}
			h.items = append(h.items, item)
		}
		if typ == "activity.started" {
			item["summary"] = activitySummary(event)
			item["status"] = "running"
		} else if a["is_error"] == true {
			item["status"] = "failed"
		} else {
			item["status"] = "done"
		}
	case "error":
		h.items = append(h.items, Message{"order": seq, "kind": "notice", "code": event["code"], "content": h.text(stringValue(event, "message"))})
	}
	sort.SliceStable(h.items, func(i, j int) bool { return h.items[i]["order"].(uint64) < h.items[j]["order"].(uint64) })
	for len(h.items) > maxHistoryItems || len(jsonBytes(h.items)) > maxHistoryBytes {
		h.items[0] = nil
		h.items = h.items[1:]
		h.truncated = true
	}
	return seq
}
func (h *SessionHistory) resetTransient() {
	h.draft = nil
	items := []Message{}
	for _, item := range h.items {
		if item["kind"] != "activity" {
			items = append(items, item)
		}
	}
	h.items = items
	h.sequence++
}
func (h *SessionHistory) snapshot() HistorySnapshot {
	items := make([]Message, 0, len(h.items))
	for _, item := range h.items {
		copy := Message{}
		for k, v := range item {
			copy[k] = v
		}
		items = append(items, copy)
	}
	var draft *Draft
	if h.draft != nil {
		d := *h.draft
		draft = &d
	}
	return HistorySnapshot{h.sequence, items, draft, h.truncated}
}
