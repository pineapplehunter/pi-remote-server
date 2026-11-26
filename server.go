package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Gateway struct {
	config   Config
	registry *Registry
	store    gatewayStore
	pending  chan struct{}
	closing  bool // guarded by registry.mu
}

func newGateway(config Config, store gatewayStore) *Gateway {
	return &Gateway{config: config, registry: newRegistry(), store: store, pending: make(chan struct{}, 64)}
}

var securityHeaders = map[string]string{
	"Cache-Control":           "no-store",
	"X-Content-Type-Options":  "nosniff",
	"Referrer-Policy":         "same-origin",
	"Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	if r.URL.EscapedPath() == "/admin/hosts" {
		g.admin(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/agent/") {
		http.NotFound(w, r)
		return
	}
	if r.Method != "GET" {
		w.Header().Set("Allow", "GET")
		http.Error(w, "Method not allowed", 405)
		return
	}
	path := r.URL.Path
	if path == "/ws" {
		if !originAllowed(r, g.config.PublicOrigin) {
			http.Error(w, "Forbidden origin", 403)
			return
		}
		conn := upgrade(w, r)
		if conn != nil {
			g.serveSocket(newSocket(conn, ""))
		}
		return
	}
	file, contentType := "", ""
	switch path {
	case "/public/app.js":
		file = "public/app.js"
		contentType = "text/javascript; charset=utf-8"
	case "/public/style.css":
		file = "public/style.css"
		contentType = "text/css; charset=utf-8"
	case "/favicon.svg":
		file = "public/favicon.svg"
		contentType = "image/svg+xml"
	}
	if file != "" {
		data, _ := assets.ReadFile(file)
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(data)
		return
	}
	g.registry.mu.Lock()
	name := ""
	var data any
	status := 200
	switch {
	case path == "/":
		var selected *SelectedView
		if s := g.registry.sessions[r.URL.Query().Get("session")]; s != nil {
			selected = selectedView(s.Session, s.history.snapshot())
		}
		name = "page"
		data = struct {
			Sessions     []Session
			Selected     *SelectedView
			AdminEnabled bool
		}{g.registry.list(), selected, g.config.AdminToken != ""}
	case path == "/ui/sessions":
		name = "sessions"
		data = g.registry.list()
	case path == "/ui/empty":
		name = "empty"
	case strings.HasPrefix(path, "/ui/sessions/") && !strings.Contains(strings.TrimPrefix(path, "/ui/sessions/"), "/"):
		if s := g.registry.sessions[strings.TrimPrefix(path, "/ui/sessions/")]; s != nil {
			name = "selected"
			data = selectedView(s.Session, s.history.snapshot())
		} else {
			status = 404
		}
	}
	g.registry.mu.Unlock()
	if name == "" {
		if status == 404 {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(404)
			_, _ = fmt.Fprint(w, "<p>This Pi connection is no longer available. Select a live session.</p>")
			return
		}
		http.Error(w, "Not found", 404)
		return
	}
	body, err := render(name, data)
	if err != nil {
		logEvent("server.request_error", nil)
		http.Error(w, "Internal server error", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprint(w, body)
}
func upgrade(w http.ResponseWriter, r *http.Request) *websocket.Conn {
	if !websocket.IsWebSocketUpgrade(r) {
		http.Error(w, "WebSocket upgrade required", 426)
		return nil
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }, HandshakeTimeout: 10 * time.Second}
	// Auth/origin have already been checked; preserve security headers on upgrades too.
	conn, err := upgrader.Upgrade(w, r, w.Header())
	if err != nil {
		return nil
	}
	return conn
}
func (g *Gateway) serveSocket(socket *Socket) {
	conn, hostID := socket.conn, socket.hostID
	registry := g.registry
	registry.mu.Lock()
	if g.closing || (hostID != "" && !registry.agents[socket]) {
		if hostID != "" {
			registry.disconnect(socket)
		}
		registry.mu.Unlock()
		socket.close(1001, "Gateway shutting down.")
		return
	}
	if hostID == "" {
		registry.browsers[socket] = true
		socket.send(Message{"version": 1, "type": "sessions.snapshot", "sessions": registry.list()})
		logEvent("browser.connected", nil)
	}
	registry.mu.Unlock()
	go socket.writeLoop()
	defer func() {
		socket.close(1001, "Connection closed.")
		registry.mu.Lock()
		defer registry.mu.Unlock()
		if hostID != "" {
			registry.disconnect(socket)
		} else {
			delete(registry.browsers, socket)
			logEvent("browser.disconnected", nil)
		}
	}()
	conn.SetReadLimit(maxFrameBytes)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	for {
		kind, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		registry.mu.Lock()
		if hostID != "" {
			if !registry.agents[socket] {
				registry.mu.Unlock()
				return
			}
			registry.agentMessage(socket, payload, kind == websocket.TextMessage)
		} else {
			registry.browserMessage(socket, payload, kind == websocket.TextMessage)
		}
		registry.mu.Unlock()
		select {
		case <-socket.done:
			return
		default:
		}
	}
}
func (g *Gateway) close() {
	g.registry.mu.Lock()
	defer g.registry.mu.Unlock()
	g.closing = true
	for socket := range g.registry.agents {
		socket.close(1001, "Gateway shutting down.")
	}
	for socket := range g.registry.browsers {
		socket.close(1001, "Gateway shutting down.")
	}
}
