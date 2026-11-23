package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func agentTestTrust(t *testing.T, revoke bool) (*agentTrust, string, string) {
	t.Helper()
	now := time.Now()
	serial := int64(0)
	makeCert := func(name string, parent *x509.Certificate, issuer *ecdsa.PrivateKey, ca, root bool, eku x509.ExtKeyUsage, expired bool) (*x509.Certificate, *ecdsa.PrivateKey) {
		t.Helper()
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		serial++
		cert := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name},
			NotBefore: now.Add(-2 * time.Hour), NotAfter: now.Add(2 * time.Hour), BasicConstraintsValid: true, IsCA: ca,
			KeyUsage: x509.KeyUsageDigitalSignature}
		if ca {
			cert.KeyUsage = x509.KeyUsageCertSign
			cert.MaxPathLenZero = !root
		}
		if !ca {
			cert.ExtKeyUsage = []x509.ExtKeyUsage{eku}
		}
		if expired {
			cert.NotAfter = now.Add(-time.Hour)
		}
		if parent == nil {
			parent, issuer = cert, key
		}
		der, err := x509.CreateCertificate(rand.Reader, cert, parent, &key.PublicKey, issuer)
		if err != nil {
			t.Fatal(err)
		}
		out, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		return out, key
	}
	root, key := makeCert("root", nil, nil, true, true, 0, false)
	issuer, issuerKey := makeCert("host issuer", root, key, true, false, 0, false)
	leaf, _ := makeCert("untrusted subject", issuer, issuerKey, false, false, x509.ExtKeyUsageClientAuth, false)
	wrong, _ := makeCert("wrong usage", issuer, issuerKey, false, false, x509.ExtKeyUsageServerAuth, false)
	expired, _ := makeCert("expired", issuer, issuerKey, false, false, x509.ExtKeyUsageClientAuth, true)
	encode := func(c *x509.Certificate) string {
		return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw}))
	}
	dir := t.TempDir()
	rootPath, enrolledPath := filepath.Join(dir, "root.pem"), filepath.Join(dir, "enrollments.json")
	if err := os.WriteFile(rootPath, []byte(encode(root)), 0600); err != nil {
		t.Fatal(err)
	}
	var revoked []string
	if revoke {
		revoked = []string{"laptop"}
	}
	doc, err := json.Marshal(map[string]any{"hosts": []enrollment{{HostID: "laptop", Intermediate: encode(issuer)}}, "revoked_hosts": revoked})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(enrolledPath, doc, 0600); err != nil {
		t.Fatal(err)
	}
	trust, err := loadAgentTrust(rootPath, enrolledPath)
	if err != nil {
		t.Fatal(err)
	}
	if trust.authorize(base64.StdEncoding.EncodeToString(expired.Raw)) != "" {
		t.Fatal("accepted expired client")
	}
	return trust, base64.StdEncoding.EncodeToString(leaf.Raw), base64.StdEncoding.EncodeToString(wrong.Raw)
}

func TestAgentTrust(t *testing.T) {
	trust, leaf, wrong := agentTestTrust(t, false)
	if trust.authorize(leaf) != "laptop" || trust.authorize(wrong) != "" || trust.authorize("not a certificate") != "" {
		t.Fatal("unexpected certificate authorization")
	}
	revoked, revokedLeaf, _ := agentTestTrust(t, true)
	if revoked.authorize(revokedLeaf) != "" {
		t.Fatal("accepted revoked client")
	}
}
