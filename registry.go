package main

import (
	"crypto/rand"
	"fmt"
	"log"
	"sync"
	"time"
)

type Session struct {
	RegistrationID string  `json:"registration_id"`
	SessionID      string  `json:"session_id"`
	HostID         string  `json:"host_id"`
	Cwd            string  `json:"cwd"`
	Name           *string `json:"name"`
	PID            int64   `json:"pid"`
	Status         *string `json:"status"`
	ConnectedAt    int64   `json:"connected_at"`
	LastSeen       int64   `json:"last_seen"`
}

func (s Session) Title() string {
	if s.Name != nil {
		return *s.Name
	}
	return s.SessionID
}
func (s Session) StatusText() string {
	if s.Status != nil {
		return *s.Status
	}
	return "connecting"
}

type LiveSession struct {
	Session
	socket  *Socket
	history SessionHistory
}
type Registry struct {
	mu           sync.Mutex // All registry/session/history operations are serialized, including enqueue order.
	sessions     map[string]*LiveSession
	order        []string
	byConnection map[*Socket]string
	agents       map[*Socket]bool
	browsers     map[*Socket]bool
}

func newRegistry() *Registry {
	return &Registry{sessions: map[string]*LiveSession{}, byConnection: map[*Socket]string{}, agents: map[*Socket]bool{}, browsers: map[*Socket]bool{}}
}
func logEvent(event string, fields Message) {
	if fields == nil {
		fields = Message{}
	}
	fields["event"] = event
	log.Print(string(jsonBytes(fields)))
}
func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("cannot generate registration ID")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func (r *Registry) list() []Session {
	result := make([]Session, 0, len(r.sessions))
	for _, id := range r.order {
		result = append(result, r.sessions[id].Session)
	}
	return result
}
func (r *Registry) broadcast(event Message) {
	for b := range r.browsers {
		if !b.send(event) {
			delete(r.browsers, b)
		}
	}
}
func (r *Registry) remove(socket *Socket) {
	id := r.byConnection[socket]
	session := r.sessions[id]
	if session == nil {
		return
	}
	delete(r.byConnection, socket)
	delete(r.sessions, id)
	for i, key := range r.order {
		if key == id {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	r.broadcast(Message{"version": 1, "type": "session.removed", "registration_id": id, "session_id": session.SessionID})
	logEvent("session.unregistered", Message{"registration_id": id})
}
func (r *Registry) disconnect(socket *Socket) {
	r.remove(socket)
	if r.agents[socket] {
		delete(r.agents, socket)
		logEvent("host.disconnected", nil)
	}
}
func (r *Registry) register(socket *Socket, m Message) {
	session := r.sessions[r.byConnection[socket]]
	if session != nil && (session.SessionID != m["session_id"] || session.PID != int64(m["pid"].(float64))) {
		r.remove(socket)
		session = nil
	}
	existing := session != nil
	now := time.Now().UnixMilli()
	var name *string
	if v, ok := m["name"].(string); ok {
		name = &v
	}
	if session == nil {
		session = &LiveSession{Session: Session{RegistrationID: uuid(), SessionID: stringValue(m, "session_id"), HostID: socket.hostID, Cwd: stringValue(m, "cwd"), Name: name, PID: int64(m["pid"].(float64)), ConnectedAt: now, LastSeen: now}, socket: socket}
		r.sessions[session.RegistrationID] = session
		r.order = append(r.order, session.RegistrationID)
		r.byConnection[socket] = session.RegistrationID
	} else {
		session.Cwd = stringValue(m, "cwd")
		session.Name = name
		session.LastSeen = now
		session.history.resetTransient()
	}
	typ := "session.added"
	if existing {
		typ = "session.updated"
	}
	r.broadcast(Message{"version": 1, "type": typ, "session": session.Session, "reset": true})
	logEvent("session.registered", Message{"registration_id": session.RegistrationID})
}
func (r *Registry) agentMessage(socket *Socket, raw []byte, text bool) {
	m, err := parseMessage(raw, text, true)
	if err == nil && m["type"] == "session.register" {
		if m["host_id"] != socket.hostID {
			err = protocolError("wrong_host", "Authenticated host does not match registration.")
		} else {
			r.register(socket, m)
			return
		}
	}
	if err == nil {
		session := r.sessions[r.byConnection[socket]]
		if session == nil || session.SessionID != m["session_id"] {
			err = protocolError("wrong_session", "Session is not registered on this socket.")
		} else {
			session.LastSeen = time.Now().UnixMilli()
			switch m["type"] {
			case "session.unregister":
				r.remove(socket)
				return
			case "session.updated":
				session.Name = nil
				if name, ok := m["name"].(string); ok {
					session.Name = &name
				}
				r.broadcast(Message{"version": 1, "type": "session.updated", "session": session.Session})
				return
			case "session.status":
				status := stringValue(m, "status")
				session.Status = &status
			}
			seq := session.history.record(m)
			m["registration_id"] = session.RegistrationID
			if seq != 0 {
				m["sequence"] = seq
			}
			r.broadcast(m)
			return
		}
	}
	logEvent("agent.rejected", Message{"code": err.Code})
	r.disconnect(socket)
	socket.close(1008, "Invalid agent protocol message.")
}
func (r *Registry) browserMessage(socket *Socket, raw []byte, text bool) {
	m, err := parseMessage(raw, text, false)
	if err == nil {
		session := r.sessions[stringValue(m, "registration_id")]
		switch {
		case session == nil:
			err = protocolError("unknown_session", "This Pi connection is gone. Select a live session; the message was not forwarded.")
		case session.SessionID != m["session_id"]:
			err = protocolError("wrong_session", "Session ID does not match this live registration.")
		case m["type"] == "session.history":
			socket.send(Message{"version": 1, "type": "session.history", "registration_id": session.RegistrationID, "session_id": session.SessionID, "history": session.history.snapshot()})
			return
		default:
			outgoing := Message{"version": 1, "type": "message.send", "session_id": session.SessionID, "text": m["text"]}
			if v, ok := m["delivery"]; ok {
				outgoing["delivery"] = v
			}
			if session.socket.send(outgoing) {
				return
			}
			r.disconnect(session.socket)
			err = protocolError("session_unavailable", "Pi is disconnected. The message was not forwarded.")
		}
	}
	reply := Message{"version": 1, "type": "gateway.error", "code": err.Code, "message": err.Message}
	if m != nil {
		reply["registration_id"] = m["registration_id"]
		if v, ok := m["request_id"]; ok {
			reply["request_id"] = v
		}
	}
	socket.send(reply)
}
