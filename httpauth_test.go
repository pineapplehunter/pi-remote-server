package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func (s *testStore) Challenge(id, key string) (string, error) {
	if id == "host" && key == "key" {
		return "nonce", nil
	}
	return "", errors.New("invalid")
}
func (s *testStore) Ticket(id, key, c, sig string) (string, error) {
	if id == "host" && key == "key" && c == "nonce" && sig == "signed" {
		return "synthetic", nil
	}
	return "", errors.New("invalid")
}

func TestAuthRoutes(t *testing.T) {
	g := newGateway(Config{}, &testStore{})
	for _, tc := range []struct {
		method, path, body string
		public             bool
		code               int
		field, value       string
	}{
		{"POST", "/agent/challenge", `{"host_id":"host","agent_key":"key"}`, false, 200, "challenge", "nonce"},
		{"POST", "/agent/ticket", `{"host_id":"host","agent_key":"key","challenge":"nonce","signature":"signed"}`, false, 200, "ticket", "synthetic"},
		{"POST", "/agent/ticket", "{}", true, 404, "", ""}, {"POST", "/agent/challenge", "{}", true, 404, "", ""}, {"GET", "/admin/hosts", "", false, 404, "", ""},
		{"POST", "/agent/challenge", strings.Repeat(" ", authBodyLimit) + "{}", false, 400, "", ""}, {"GET", "/agent/ws?ticket=synthetic", "", false, 400, "", ""},
		{"GET", "/agent/ws", "", false, 401, "", ""}, {"GET", "/admin/hosts", "", true, 200, "", ""},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Pi-Remote-Host", "old-header")
		w := httptest.NewRecorder()
		if tc.public {
			g.ServeHTTP(w, req)
		} else {
			g.agentHandler(w, req)
		}
		if w.Code != tc.code {
			t.Errorf("%s: %d want %d", tc.path, w.Code, tc.code)
		}
		if tc.field != "" {
			var fields map[string]string
			if json.Unmarshal(w.Body.Bytes(), &fields) != nil || fields[tc.field] != tc.value {
				t.Errorf("%s missing response field", tc.path)
			}
		}
	}
	for _, origin := range []string{"", "https://foreign"} {
		req := httptest.NewRequest("POST", "http://localhost/admin/hosts", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("admin POST with Origin %q: %d", origin, w.Code)
		}
	}
}

func TestDeleteTrustedHost(t *testing.T) {
	s := testAuthStore(t, ":memory:")
	g := newGateway(Config{}, s)
	for _, disabled := range []bool{false, true} {
		key := newStoreKey(t).pub
		id, err := s.AddHost("laptop", key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Challenge(id, key); err != nil {
			t.Fatal(err)
		}
		if disabled {
			if err := s.DisableHost(id); err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest("POST", "http://localhost/admin/hosts", strings.NewReader("action=delete&id="+id))
		req.Header.Set("Origin", "http://localhost")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		if w.Code != http.StatusSeeOther {
			t.Fatal(w.Code)
		}
		hosts, err := s.Hosts()
		if err != nil || len(hosts) != 0 {
			t.Fatal(hosts, err)
		}
		if _, err := s.Challenge(id, key); err == nil {
			t.Fatal("deleted host admitted")
		}
	}
}

func TestPendingAgentDisable(t *testing.T) {
	g := newGateway(Config{}, &testStore{})
	g.pending = make(chan struct{}, 1)
	s := httptest.NewServer(http.HandlerFunc(g.agentHandler))
	defer s.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/agent/ws", http.Header{"Authorization": []string{"Bearer synthetic"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var m Message
	if err := conn.ReadJSON(&m); err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	g.agentHandler(rr, httptest.NewRequest("POST", "/agent/challenge", nil))
	if rr.Code != 429 {
		t.Fatalf("pending proof did not occupy an admission slot: %d", rr.Code)
	}
	if err := g.revokeHost("test-host", g.store.DisableHost); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(Message{"type": "auth.proof", "signature": testProof(stringValue(m, "challenge"))}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("disabled host admitted via pending proof")
	}
}

func TestAgentRejectsFramesBeforeProof(t *testing.T) {
	g := newGateway(Config{}, &testStore{})
	s := httptest.NewServer(http.HandlerFunc(g.agentHandler))
	defer s.Close()
	for _, tc := range []struct {
		kind    int
		payload string
	}{{websocket.TextMessage, `{"type":"session.register"}`}, {websocket.BinaryMessage, `{"type":"auth.proof","signature":"no"}`}, {websocket.TextMessage, `{"type":"auth.proof","signature":"wrong"}`}} {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/agent/ws", http.Header{"Authorization": []string{"Bearer synthetic"}})
		if err != nil {
			t.Fatal(err)
		}
		conn.SetReadDeadline(time.Now().Add(time.Second))
		var m Message
		if conn.ReadJSON(&m) != nil || m["type"] != "auth.challenge" {
			t.Fatal("no challenge")
		}
		if err := conn.WriteMessage(tc.kind, []byte(tc.payload)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Fatal("unexpected authenticated reply")
		}
		conn.Close()
		g.registry.mu.Lock()
		n := len(g.registry.agents)
		g.registry.mu.Unlock()
		if n != 0 {
			t.Fatal("unauthenticated agent registered")
		}
	}
}
