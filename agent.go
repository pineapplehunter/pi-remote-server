package main

import (
	"net/http"
	"strings"
)

const agentHostHeader = "X-Pi-Remote-Host"

// Only the private Unix listener serves this handler. Caddy authenticates
// clients before proxying. The issuer label is for display, not authorization.
func (g *Gateway) agentHandler(w http.ResponseWriter, r *http.Request) {
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	if r.URL.EscapedPath() != "/agent/ws" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		http.Error(w, "Query not allowed", http.StatusBadRequest)
		return
	}
	host := "Pi agent"
	if values := r.Header.Values(agentHostHeader); len(values) == 1 {
		if label := strings.TrimSpace(values[0]); len(label) > 0 && len(label) <= 256 {
			host = label
		}
	}
	g.websocket(w, r, host)
}
