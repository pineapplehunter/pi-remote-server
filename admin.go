package main

import (
	"net/http"
	"strings"
)

func (g *Gateway) admin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		hosts, err := g.store.Hosts()
		if err != nil {
			http.Error(w, "Cannot list hosts", 500)
			return
		}
		body, err := render("hosts", hosts)
		if err != nil {
			http.Error(w, "Cannot display hosts", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(body))
	case "POST":
		if !originAllowed(r, g.config.PublicOrigin) {
			http.Error(w, "Forbidden origin", 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, authBodyLimit)
		if r.ParseForm() != nil {
			http.Error(w, "Invalid form", 400)
			return
		}
		switch r.PostForm.Get("action") {
		case "add":
			name := strings.TrimSpace(r.PostForm.Get("name"))
			if name == "" || len(name) > 128 {
				http.Error(w, "Invalid name", 400)
				return
			}
			// OpenSSH .pub files usually end with a user/host comment.
			line := strings.TrimSpace(r.PostForm.Get("key"))
			fields := strings.Fields(line)
			if len(fields) < 2 || strings.ContainsAny(line, "\r\n") {
				http.Error(w, "Expected one OpenSSH public key", 400)
				return
			}
			if _, err := g.store.AddHost(name, strings.Join(fields[:2], " ")); err != nil {
				http.Error(w, "Cannot add host", 400)
				return
			}
		case "disable":
			if err := g.disableHost(r.PostForm.Get("id")); err != nil {
				http.Error(w, "Cannot disable host", 400)
				return
			}
		default:
			http.Error(w, "Unknown action", 400)
			return
		}
		http.Redirect(w, r, "/admin/hosts", http.StatusSeeOther)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "Method not allowed", 405)
	}
}
func (g *Gateway) disableHost(id string) error {
	reg := g.registry
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if err := g.store.DisableHost(id); err != nil {
		return err
	}
	for socket := range reg.agents {
		if socket.hostID == id {
			reg.disconnect(socket)
			socket.close(1008, "Host disabled.")
		}
	}
	return nil
}
