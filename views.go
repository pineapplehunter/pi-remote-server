package main

import (
	"bytes"
	"embed"
	"html/template"
	"sort"
)

//go:embed public/app.js public/style.css public/favicon.svg templates/views.html
var assets embed.FS
var views = template.Must(template.ParseFS(assets, "templates/views.html"))

type RenderItem struct {
	Order                                                  uint64
	Kind, Role, Content, Code, Status, ToolCallID, Summary string
	Streaming                                              bool
}
type SelectedView struct {
	Session Session
	History HistorySnapshot
	Items   []RenderItem
}

func selectedView(session Session, history HistorySnapshot) *SelectedView {
	view := &SelectedView{Session: session, History: history}
	for _, item := range history.Items {
		view.Items = append(view.Items, RenderItem{Order: item["order"].(uint64), Kind: stringValue(item, "kind"), Role: stringValue(item, "role"), Content: stringValue(item, "content"), Code: stringValue(item, "code"), Status: stringValue(item, "status"), ToolCallID: stringValue(item, "tool_call_id"), Summary: stringValue(item, "summary")})
	}
	if history.Draft != nil {
		view.Items = append(view.Items, RenderItem{Order: history.Draft.Order, Kind: "message", Role: "assistant", Content: history.Draft.Content, Streaming: true})
	}
	sort.SliceStable(view.Items, func(i, j int) bool { return view.Items[i].Order < view.Items[j].Order })
	return view
}
func render(name string, data any) (string, error) {
	var b bytes.Buffer
	err := views.ExecuteTemplate(&b, name, data)
	return b.String(), err
}
