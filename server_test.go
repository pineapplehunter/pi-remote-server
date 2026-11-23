package main

import (
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

func TestConcurrentConnections(t *testing.T) {
	gateway := newGateway(Config{})
	trust, leaf, _ := agentTestTrust(t, false)
	gateway.trust = trust
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
			agent, _, err := websocket.DefaultDialer.Dial(agentURL, http.Header{agentCertificateHeader: []string{leaf}})
			if err != nil {
				t.Error(err)
				return
			}
			defer agent.Close()
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
	// Release writers and wait for disconnect cleanup through the browser stream.
	close(release)
	wg.Wait()
	for removed := 0; removed < count; {
		var event Message
		if err := browser.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event["type"] == "session.removed" {
			removed++
		}
	}
}
