package main

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
	"slices"
	"time"
)

const agentCertificateHeader = "X-Pi-Remote-Client-Cert"

type enrollment struct {
	HostID       string `json:"host_id"`
	Intermediate string `json:"intermediate"`
}

type agentTrust struct {
	roots, intermediates *x509.CertPool
	hostByKey            map[string]string
	revoked              map[string]bool
}

func readCertificate(data []byte) (*x509.Certificate, error) {
	data = bytes.TrimSpace(data)
	block, rest := pem.Decode(data)
	if !bytes.HasPrefix(data, []byte("-----BEGIN CERTIFICATE-----\n")) || block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("expected one PEM certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}

func loadAgentTrust(rootPath, enrollPath string) (*agentTrust, error) {
	rootPEM, err := os.ReadFile(rootPath)
	if err != nil {
		return nil, errors.New("cannot read Pi Remote root CA")
	}
	root, err := readCertificate(rootPEM)
	if err != nil || !root.IsCA || !bytes.Equal(root.RawSubject, root.RawIssuer) || root.CheckSignatureFrom(root) != nil || time.Now().Before(root.NotBefore) || !time.Now().Before(root.NotAfter) {
		return nil, errors.New("invalid Pi Remote root CA")
	}
	data, err := os.ReadFile(enrollPath)
	if err != nil {
		return nil, errors.New("cannot read agent enrollments")
	}
	var file struct {
		Hosts        []enrollment `json:"hosts"`
		RevokedHosts []string     `json:"revoked_hosts"`
	}
	if json.Unmarshal(data, &file) != nil || file.Hosts == nil {
		return nil, errors.New("invalid agent enrollments")
	}
	trust := &agentTrust{x509.NewCertPool(), x509.NewCertPool(), map[string]string{}, map[string]bool{}}
	trust.roots.AddCert(root)
	ids := make(map[string]bool)
	for _, host := range file.Hosts {
		if !hostPattern.MatchString(host.HostID) || ids[host.HostID] {
			return nil, errors.New("invalid or duplicate enrolled host ID")
		}
		cert, err := readCertificate([]byte(host.Intermediate))
		if err != nil || !cert.IsCA || !cert.MaxPathLenZero || cert.KeyUsage&x509.KeyUsageCertSign == 0 ||
			!bytes.Equal(cert.RawIssuer, root.RawSubject) || cert.CheckSignatureFrom(root) != nil || bytes.Equal(cert.RawSubjectPublicKeyInfo, root.RawSubjectPublicKeyInfo) {
			return nil, errors.New("host intermediate must be a direct pathLen=0 issuer under the Pi Remote root")
		}
		key := string(cert.RawSubjectPublicKeyInfo)
		if trust.hostByKey[key] != "" {
			return nil, errors.New("an intermediate key can be enrolled under only one host ID")
		}
		ids[host.HostID] = true
		trust.hostByKey[key] = host.HostID
		trust.intermediates.AddCert(cert)
	}
	for _, id := range file.RevokedHosts {
		if !hostPattern.MatchString(id) {
			return nil, errors.New("invalid revoked host ID")
		}
		trust.revoked[id] = true
	}
	return trust, nil
}

func (t *agentTrust) authorize(header string) string {
	if len(header) == 0 || len(header) > 16*1024 {
		return ""
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(header)
	if err != nil {
		return ""
	}
	leaf, err := x509.ParseCertificate(raw)
	if err != nil || leaf.IsCA || !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) || leaf.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return ""
	}
	chains, err := leaf.Verify(x509.VerifyOptions{Roots: t.roots, Intermediates: t.intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}})
	if err != nil || len(chains) != 1 || len(chains[0]) != 3 {
		return ""
	}
	id := t.hostByKey[string(chains[0][1].RawSubjectPublicKeyInfo)]
	if t.revoked[id] {
		return ""
	}
	return id
}

// Only the permission-restricted Unix listener serves this handler. Its peer
// is trusted to assert certificate possession; the forwarded leaf is public.
func (g *Gateway) agentHandler(w http.ResponseWriter, r *http.Request) {
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	if r.URL.EscapedPath() != "/agent/ws" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		http.Error(w, "Query not allowed", http.StatusBadRequest)
		return
	}
	values := r.Header.Values(agentCertificateHeader)
	if len(values) == 1 && g.trust != nil {
		if host := g.trust.authorize(values[0]); host != "" {
			g.websocket(w, r, host)
			return
		}
	}
	logEvent("agent.authentication_rejected", nil)
	http.Error(w, "Unauthorized", http.StatusUnauthorized)
}
