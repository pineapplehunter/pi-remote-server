package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type gatewayStore interface {
	AddHost(name, key string) (string, error)
	Hosts() ([]authHost, error)
	DisableHost(id string) error
	Challenge(hostID, agentKey string) (string, error)
	Ticket(hostID, agentKey, challenge, signature string) (string, error)
	Lookup(ticket string) (string, error)
	Redeem(ticket, challenge, signature string) (string, error)
}

const authBodyLimit = 8192

func decodeAuthJSON(r io.Reader, dst any) bool {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	return d.Decode(dst) == nil && d.Decode(new(any)) == io.EOF
}

// Only the private Unix listener serves these routes. No proxy header is a credential.
func (g *Gateway) agentHandler(w http.ResponseWriter, r *http.Request) {
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	path := r.URL.EscapedPath()
	method := "POST"
	switch path {
	case "/agent/ws":
		method = "GET"
	case "/agent/challenge", "/agent/ticket":
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != method {
		w.Header().Set("Allow", method)
		http.Error(w, "Method not allowed", 405)
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		http.Error(w, "Query not allowed", 400)
		return
	}
	select {
	case g.pending <- struct{}{}:
	default:
		http.Error(w, "Too many pending requests", 429)
		return
	}
	// Release the admission slot as soon as authentication finishes, not on disconnect.
	if path == "/agent/ws" {
		socket := g.authenticateAgent(w, r)
		<-g.pending
		if socket != nil {
			g.serveSocket(socket)
		}
		return
	}
	defer func() { <-g.pending }()
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		http.Error(w, "Expected application/json", 415)
		return
	}
	body := http.MaxBytesReader(w, r.Body, authBodyLimit)
	var req struct {
		HostID    string `json:"host_id"`
		AgentKey  string `json:"agent_key"`
		Challenge string `json:"challenge"`
		Signature string `json:"signature"`
	}
	if !decodeAuthJSON(body, &req) || req.HostID == "" || req.AgentKey == "" {
		http.Error(w, "Invalid request", 400)
		return
	}
	var result string
	var err error
	var key string
	if path == "/agent/challenge" {
		if req.Challenge != "" || req.Signature != "" {
			http.Error(w, "Invalid request", 400)
			return
		}
		key = "challenge"
		result, err = g.store.Challenge(req.HostID, req.AgentKey)
	} else {
		if req.Challenge == "" || req.Signature == "" {
			http.Error(w, "Missing proof", 400)
			return
		}
		key = "ticket"
		result, err = g.store.Ticket(req.HostID, req.AgentKey, req.Challenge, req.Signature)
	}
	if err != nil {
		http.Error(w, "Authorization failed", 403)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(Message{key: result})
}

func (g *Gateway) authenticateAgent(w http.ResponseWriter, r *http.Request) *Socket {
	hdr := r.Header.Values("Authorization")
	if len(hdr) != 1 || !strings.HasPrefix(hdr[0], "Bearer ") {
		http.Error(w, "Unauthorized", 401)
		return nil
	}
	ticket := strings.TrimPrefix(hdr[0], "Bearer ")
	if _, err := g.store.Lookup(ticket); err != nil {
		http.Error(w, "Unauthorized", 401)
		return nil
	}
	conn := upgrade(w, r)
	if conn == nil {
		return nil
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		conn.Close()
		return nil
	}
	challenge := base64.RawURLEncoding.EncodeToString(nonce[:])
	deadline := time.Now().Add(10 * time.Second)
	conn.SetReadLimit(authBodyLimit)
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	if conn.WriteJSON(Message{"type": "auth.challenge", "challenge": challenge}) != nil {
		conn.Close()
		return nil
	}
	kind, payload, err := conn.ReadMessage()
	var proof struct {
		Type      string `json:"type"`
		Signature string `json:"signature"`
	}
	if err != nil || kind != websocket.TextMessage || !decodeAuthJSON(bytes.NewReader(payload), &proof) || proof.Type != "auth.proof" || proof.Signature == "" {
		conn.Close()
		return nil
	}
	// Redeem and publish together under the same lock used by disable-and-disconnect.
	reg := g.registry
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if g.closing {
		conn.Close()
		return nil
	}
	host, err := g.store.Redeem(ticket, challenge, proof.Signature)
	if err != nil || host == "" {
		conn.Close()
		return nil
	}
	socket := newSocket(conn, host)
	reg.agents[socket] = true
	socket.send(Message{"type": "auth.ok"})
	logEvent("host.connected", nil)
	return socket
}
