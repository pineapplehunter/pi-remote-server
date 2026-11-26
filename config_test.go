package main

import (
	"net/http/httptest"
	"testing"
)

func mergeConfig(a, b map[string]string) map[string]string {
	c := map[string]string{}
	for k, v := range a {
		c[k] = v
	}
	for k, v := range b {
		c[k] = v
	}
	return c
}
func TestConfigAndOrigin(t *testing.T) {
	config := func(env map[string]string) (Config, error) {
		return loadConfig(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	}
	if _, err := config(nil); err == nil {
		t.Fatal("private agent socket must be required")
	}
	base := map[string]string{"PI_REMOTE_TICKET_SOCKET": "/tmp/agent.sock", "PI_REMOTE_DB": "/tmp/auth.db"}
	c, err := config(base)
	if err != nil || c.Host != "127.0.0.1" || c.Port != 3000 {
		t.Fatal(c, err)
	}
	for _, port := range []string{"", "x", "0", "65536", "1.5"} {
		if _, err := config(mergeConfig(base, map[string]string{"PORT": port})); err == nil {
			t.Errorf("accepted port %q", port)
		}
	}
	for _, origin := range []string{"", "wss://host", "https://host/path", "https://user:pass@host", "https://host/?x=1", "https://host/?", "https://host/#"} {
		if _, err := config(mergeConfig(base, map[string]string{"PUBLIC_ORIGIN": origin})); err == nil {
			t.Errorf("accepted origin %q", origin)
		}
	}
	c, err = config(mergeConfig(base, map[string]string{"PUBLIC_ORIGIN": "https://PI.example:443/"}))
	if err != nil || c.PublicOrigin != "https://pi.example" {
		t.Fatal(c, err)
	}
	request := httptest.NewRequest("GET", "http://localhost:3000/ws", nil)
	if originAllowed(request, "") {
		t.Fatal("missing Origin accepted")
	}
	request.Header.Set("Origin", "http://localhost:3000")
	if !originAllowed(request, "") {
		t.Fatal("direct Origin rejected")
	}
	request.Header.Set("Origin", "https://evil")
	request.Header.Set("X-Forwarded-Host", "evil")
	if originAllowed(request, "") {
		t.Fatal("forwarded host trusted")
	}
	request.Header.Set("Origin", "https://pi.example")
	if !originAllowed(request, "https://pi.example") {
		t.Fatal("public Origin rejected")
	}
}
