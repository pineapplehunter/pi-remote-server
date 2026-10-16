package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCredentials(t *testing.T) {
	valid := []byte(`[{"host_id":"laptop","token":"long-random-secret"}]`)
	auth, err := parseCredentials(valid)
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []string{"Bearer long-random-secret", "bearer long-random-secret"} {
		if auth.authenticate(header) != "laptop" {
			t.Fatal("valid bearer rejected")
		}
	}
	for _, header := range []string{"", "Bearer wrong", "Basic long-random-secret", "Bearer", "Bearer long-random-secret extra", "Bearer  long-random-secret", "Bearer " + strings.Repeat("x", 8193)} {
		if auth.authenticate(header) != "" {
			t.Fatal("invalid bearer accepted")
		}
	}
	for _, input := range []string{`null`, `{}`, `[]`, `[{"host_id":"bad host","token":"SECRET"}]`, `[{"host_id":"host","token":"bad token"}]`, `[{"host_id":"host","token":"SECRET","extra":true}]`, `[{"host_id":"a","token":"SECRET"},{"host_id":"a","token":"other"}]`, `[{"host_id":"a","token":"SECRET"},{"host_id":"b","token":"SECRET"}]`} {
		_, err := parseCredentials([]byte(input))
		if err == nil || strings.Contains(err.Error(), "SECRET") {
			t.Fatal("invalid credential accepted or leaked")
		}
	}
	path := filepath.Join(t.TempDir(), "agents.json")
	if err := os.WriteFile(path, valid, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadCredentials(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	if loaded.authenticate("Bearer long-random-secret") != "laptop" {
		t.Fatal("credentials changed after load")
	}
	if _, err := loadCredentials(path); err == nil {
		t.Fatal("malformed file accepted")
	}
	if _, err := loadCredentials(path + "missing"); err == nil {
		t.Fatal("missing file accepted")
	}
}
func TestConfigAndOrigin(t *testing.T) {
	config := func(env map[string]string) (Config, error) {
		return loadConfig(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	}
	if _, err := config(nil); err == nil {
		t.Fatal("token file must be required")
	}
	c, err := config(map[string]string{"PI_REMOTE_TOKEN_FILE": "/test"})
	if err != nil || c.Host != "127.0.0.1" || c.Port != 3000 {
		t.Fatal(c, err)
	}
	for _, port := range []string{"", "x", "0", "65536", "1.5"} {
		if _, err := config(map[string]string{"PI_REMOTE_TOKEN_FILE": "/test", "PORT": port}); err == nil {
			t.Errorf("accepted port %q", port)
		}
	}
	for _, origin := range []string{"", "wss://host", "https://host/path", "https://user:pass@host", "https://host/?x=1", "https://host/?", "https://host/#"} {
		if _, err := config(map[string]string{"PI_REMOTE_TOKEN_FILE": "/test", "PUBLIC_ORIGIN": origin}); err == nil {
			t.Errorf("accepted origin %q", origin)
		}
	}
	c, err = config(map[string]string{"PI_REMOTE_TOKEN_FILE": "/test", "PUBLIC_ORIGIN": "https://PI.example:443/"})
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
