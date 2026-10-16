package main

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Exactly one writer per socket. Bounded queued bytes include the in-flight write.
type Socket struct {
	conn   *websocket.Conn
	queue  chan []byte
	done   chan struct{}
	mu     sync.Mutex
	queued int
	closed bool
	hostID string
}

func newSocket(conn *websocket.Conn, hostID string) *Socket {
	return &Socket{conn: conn, queue: make(chan []byte, 256), done: make(chan struct{}), hostID: hostID}
}
func (s *Socket) close(code int, reason string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	s.mu.Unlock()
	// Never hold the registry lock while waiting for a network write.
	go func() {
		_ = s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
		_ = s.conn.Close()
	}()
}
func (s *Socket) send(value any) bool {
	payload := jsonBytes(value)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	if s.queued+len(payload) > 2*maxFrameBytes {
		s.mu.Unlock()
		s.close(1013, "Slow connection; reconnect.")
		return false
	}
	select {
	case s.queue <- payload:
		s.queued += len(payload)
		s.mu.Unlock()
		return true
	default:
		s.mu.Unlock()
		s.close(1013, "Slow connection; reconnect.")
		return false
	}
}
func (s *Socket) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	defer s.close(1001, "Connection closed.")
	for {
		select {
		case <-s.done:
			return
		case payload := <-s.queue:
			_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if s.conn.WriteMessage(websocket.TextMessage, payload) != nil {
				return
			}
			s.mu.Lock()
			s.queued -= len(payload)
			s.mu.Unlock()
		case <-ticker.C:
			if s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
				return
			}
		}
	}
}
