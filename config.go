package main

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type Config struct {
	Host                      string
	Port                      int
	AgentSocket, PublicOrigin string
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
	c.AgentSocket, _ = getenv("PI_REMOTE_AGENT_SOCKET")
	c.AgentSocket = trimSpace(c.AgentSocket)
	if c.Host == "" || c.Port < 1 || c.Port > 65535 || c.AgentSocket == "" {
		return c, errors.New("Invalid configuration: set PI_REMOTE_AGENT_SOCKET and valid HOST/PORT.")
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
