package main

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSocketBackpressure(t *testing.T) {
	for _, byteLimit := range []bool{true, false} {
		t.Run(map[bool]string{true: "bytes", false: "frames"}[byteLimit], func(t *testing.T) {
			accepted := make(chan *Socket, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				accepted <- newSocket(conn, "")
			}))
			defer server.Close()
			peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			socket := <-accepted // No writer: simulate a connection that cannot drain.
			defer socket.close(1001, "Test finished.")
			if byteLimit {
				if socket.send(Message{"text": strings.Repeat("x", 2*maxFrameBytes)}) {
					t.Fatal("byte limit ignored")
				}
			} else {
				for i := 0; i < cap(socket.queue); i++ {
					if !socket.send(Message{"text": "x"}) {
						t.Fatal("early rejection")
					}
				}
				if socket.send(Message{"text": "overflow"}) {
					t.Fatal("frame limit ignored")
				}
			}
			_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := peer.ReadMessage(); !websocket.IsCloseError(err, 1013) {
				t.Fatalf("expected slow-client close, got %v", err)
			}
		})
	}
}

// The gateway tests exercise routing and socket admission independently of SSHSIG/SQLite.
type testStore struct {
	gatewayStore
	disabled bool
}

func (s *testStore) Lookup(ticket string) (string, error) {
	if ticket != "synthetic" {
		return "", errors.New("no ticket")
	}
	return "key", nil
}
func testProof(challenge string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(challenge))) }
func (s *testStore) Redeem(ticket, challenge, sig string) (string, error) {
	b, err := base64.RawURLEncoding.DecodeString(challenge)
	if s.disabled || err != nil || len(b) != 32 || sig != testProof(challenge) {
		return "", errors.New("invalid")
	}
	return "test-host", nil
}
func (s *testStore) DisableHost(id string) error {
	if id != "test-host" {
		return errors.New("no host")
	}
	s.disabled = true
	return nil
}
func (s *testStore) Hosts() ([]authHost, error) {
	return []authHost{{ID: "test-host", Name: "unit test", Enabled: !s.disabled}}, nil
}

func TestConcurrentConnections(t *testing.T) {
	gateway := newGateway(Config{}, &testStore{})
	server := httptest.NewServer(gateway)
	defer server.Close()
	private := httptest.NewServer(http.HandlerFunc(gateway.agentHandler))
	defer private.Close()
	agentURL := "ws" + strings.TrimPrefix(private.URL, "http") + "/agent/ws"
	defer gateway.close()
	base := "ws" + strings.TrimPrefix(server.URL, "http")
	browser, _, err := websocket.DefaultDialer.Dial(base+"/ws", http.Header{"Origin": []string{server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	_ = browser.SetReadDeadline(time.Now().Add(10 * time.Second))
	var first Message
	if err := browser.ReadJSON(&first); err != nil {
		t.Fatal(err)
	}
	if first["type"] != "sessions.snapshot" {
		t.Fatal(first)
	}
	res, err := http.Get(server.URL + "/agent/ws")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("browser agent route: %d", res.StatusCode)
	}
	const count = 8
	var wg sync.WaitGroup
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(pid int) {
			defer wg.Done()
			agent, _, err := websocket.DefaultDialer.Dial(agentURL, http.Header{"Authorization": []string{"Bearer synthetic"}})
			if err != nil {
				t.Error(err)
				return
			}
			defer agent.Close()
			var challenge, ok Message
			if agent.ReadJSON(&challenge) != nil || challenge["type"] != "auth.challenge" || agent.WriteJSON(Message{"type": "auth.proof", "signature": testProof(stringValue(challenge, "challenge"))}) != nil || agent.ReadJSON(&ok) != nil || ok["type"] != "auth.ok" {
				t.Error("failed socket proof")
				return
			}
			if err := agent.WriteMessage(websocket.TextMessage, envelope(Message{"type": "session.register", "cwd": "/", "name": nil, "pid": pid + 1})); err != nil {
				t.Error(err)
				return
			}
			if err := agent.WriteMessage(websocket.TextMessage, envelope(Message{"type": "message.delta", "delta": "partial"})); err != nil {
				t.Error(err)
				return
			}
			<-release
		}(i)
	}
	added, deltas := 0, 0
	ids := map[string]bool{}
	for added < count || deltas < count {
		var event Message
		if err := browser.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		switch event["type"] {
		case "session.added":
			added++
			s := event["session"].(map[string]any)
			ids[stringValue(s, "registration_id")] = true
		case "message.delta":
			deltas++
		}
	}
	if len(ids) != count {
		t.Fatal("colliding Pi IDs were merged")
	}
	gateway.registry.mu.Lock()
	sessions := gateway.registry.list()
	gateway.registry.mu.Unlock()
	if len(sessions) != count {
		t.Fatal("registrations lost")
	}
	// Disabling the host removes all its sessions before any more frames can dispatch.
	req := httptest.NewRequest("POST", server.URL+"/admin/hosts", strings.NewReader("action=disable&id=test-host"))
	req.Header.Set("Origin", server.URL)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rr := httptest.NewRecorder()
	gateway.ServeHTTP(rr, req)
	if rr.Code != 303 {
		t.Fatalf("disable: %d", rr.Code)
	}
	for removed := 0; removed < count; {
		var event Message
		if err := browser.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "session.removed" {
			removed++
		}
	}
	close(release)
	wg.Wait()
}
