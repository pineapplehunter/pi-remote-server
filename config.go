package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Config struct {
	Host                    string
	Port                    int
	TokenFile, PublicOrigin string
}

func loadConfig(getenv func(string) (string, bool)) (Config, error) {
	c := Config{Host: "127.0.0.1", Port: 3000}
	if v, ok := getenv("HOST"); ok {
		c.Host = trimSpace(v)
	}
	if v, ok := getenv("PORT"); ok {
		p, err := strconv.Atoi(v)
		if err != nil {
			return c, errors.New("Invalid configuration: invalid PORT.")
		}
		c.Port = p
	}
	c.TokenFile, _ = getenv("PI_REMOTE_TOKEN_FILE")
	c.TokenFile = trimSpace(c.TokenFile)
	if c.Host == "" || c.Port < 1 || c.Port > 65535 || c.TokenFile == "" {
		return c, errors.New("Invalid configuration: set PI_REMOTE_TOKEN_FILE and valid HOST/PORT.")
	}
	if v, ok := getenv("PUBLIC_ORIGIN"); ok {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(v, "#") {
			return c, errors.New("PUBLIC_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.")
		}
		host := strings.ToLower(u.Host)
		if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
			host = strings.TrimSuffix(host, ":"+u.Port())
		}
		c.PublicOrigin = u.Scheme + "://" + host
	}
	return c, nil
}

func originAllowed(r *http.Request, publicOrigin string) bool {
	if publicOrigin == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		publicOrigin = scheme + "://" + r.Host
	}
	return r.Header.Get("Origin") != "" && r.Header.Get("Origin") == publicOrigin
}

type Credentials map[[32]byte]string

var hostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var bearerPattern = regexp.MustCompile(`(?i)^Bearer ([\x21-\x7e]+)$`)

func parseCredentials(data []byte) (Credentials, error) {
	var entries []map[string]json.RawMessage
	if json.Unmarshal(data, &entries) != nil || len(entries) == 0 {
		return nil, errors.New("Invalid credential file entries.")
	}
	credentials := Credentials{}
	hosts := map[string]bool{}
	for _, entry := range entries {
		var host, token string
		if len(entry) != 2 || json.Unmarshal(entry["host_id"], &host) != nil || json.Unmarshal(entry["token"], &token) != nil || !hostPattern.MatchString(host) || len(token) < 1 || len(token) > 8192 {
			return nil, errors.New("Invalid credential file entries.")
		}
		for _, b := range []byte(token) {
			if b < 0x21 || b > 0x7e {
				return nil, errors.New("Invalid credential file entries.")
			}
		}
		digest := sha256.Sum256([]byte(token))
		if hosts[host] || credentials[digest] != "" {
			return nil, errors.New("Duplicate host ID or token in credential file.")
		}
		hosts[host] = true
		credentials[digest] = host
	}
	return credentials, nil
}
func loadCredentials(path string) (Credentials, error) {
	data, err := os.ReadFile(path)
	if err != nil || !json.Valid(data) {
		return nil, errors.New("Cannot read or parse credential file.")
	}
	return parseCredentials(data)
}
func (c Credentials) authenticate(header string) string {
	match := bearerPattern.FindStringSubmatch(header)
	if match == nil || len(match[1]) > 8192 {
		return ""
	}
	return c[sha256.Sum256([]byte(match[1]))]
}
