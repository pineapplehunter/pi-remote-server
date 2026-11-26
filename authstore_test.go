package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hiddeco/sshsig"
	"golang.org/x/crypto/ssh"
)

type storeTestKey struct {
	pub    string
	signer ssh.Signer
}

func newStoreKey(t *testing.T) storeTestKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return storeTestKey{strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), signer}
}
func (k storeTestKey) sign(t *testing.T, ns, msg string) string {
	t.Helper()
	sig, err := sshsig.Sign(strings.NewReader(msg), k.signer, sshsig.HashSHA512, ns)
	if err != nil {
		t.Fatal(err)
	}
	return string(sshsig.Armor(sig))
}
func testAuthStore(t *testing.T, path string) *authStore {
	t.Helper()
	s, err := openAuthStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestStoreProofs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.sqlite")
	s := testAuthStore(t, path)
	other := testAuthStore(t, path)
	host, agent := newStoreKey(t), newStoreKey(t)
	id, err := s.AddHost("sample", host.pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{agent.pub + " comment", agent.pub + "\n", " " + agent.pub, "ssh-ed25519 AAAA"} {
		if _, err := s.Challenge(id, bad); err == nil {
			t.Fatal("accepted noncanonical key")
		}
	}
	c, err := s.Challenge(id, agent.pub)
	if err != nil {
		t.Fatal(err)
	}
	msg := "pi-remote-host-v1\n" + id + "\n" + agent.pub + "\n" + c + "\n"
	sig := host.sign(t, "pi-remote-host-v1", msg)
	for _, bad := range []string{host.sign(t, "different", msg), host.sign(t, "pi-remote-host-v1", strings.TrimSpace(msg)), agent.sign(t, "pi-remote-host-v1", msg)} {
		if _, err := s.Ticket(id, agent.pub, c, bad); err == nil {
			t.Fatal("issued ticket with incorrect proof")
		}
	}
	if _, err = s.Ticket(id, host.pub, c, sig); err == nil {
		t.Fatal("issued ticket for different key")
	}
	ticket, err := s.Ticket(id, agent.pub, c, sig)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Ticket(id, agent.pub, c, sig); err == nil {
		t.Fatal("reused challenge")
	}
	if got, err := other.Lookup(ticket); err != nil || got != agent.pub {
		t.Fatalf("lookup: %s, %v", got, err)
	}
	var digest []byte
	if err := s.db.QueryRow(`select digest from tickets`).Scan(&digest); err != nil || !bytes.Equal(digest, ticketDigest(ticket)) {
		t.Fatal("not stored as digest", err)
	}
	c = authNonce()
	proof := agent.sign(t, "pi-remote-agent-v1", "pi-remote-agent-v1\n"+c+"\n")
	if _, err := s.Redeem(ticket, authNonce(), proof); err == nil {
		t.Fatal("replayed socket proof")
	}
	if _, err := s.Redeem(ticket, c, host.sign(t, agentNamespace, "pi-remote-agent-v1\n"+c+"\n")); err == nil {
		t.Fatal("host signed agent proof")
	}
	start := make(chan struct{})
	res := make(chan string, 2)
	for _, db := range []*authStore{s, other} {
		go func() { <-start; got, _ := db.Redeem(ticket, c, proof); res <- got }()
	}
	close(start)
	a, b := <-res, <-res
	if !((a == id && b == "") || (a == "" && b == id)) {
		t.Fatalf("atomic redemption: %q, %q", a, b)
	}
	if _, err := s.Lookup(ticket); err == nil {
		t.Fatal("spent ticket still live")
	}
}
func TestStoreExpiryLimitsAndDisable(t *testing.T) {
	s := testAuthStore(t, ":memory:")
	now := time.Now()
	s.now = func() time.Time { return now }
	host, agent := newStoreKey(t), newStoreKey(t)
	id, err := s.AddHost("test", host.pub)
	if err != nil {
		t.Fatal(err)
	}
	challenge := func() string {
		t.Helper()
		c, err := s.Challenge(id, agent.pub)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	issue := func(c string) (string, error) {
		sig := host.sign(t, hostNamespace, hostNamespace+"\n"+id+"\n"+agent.pub+"\n"+c+"\n")
		return s.Ticket(id, agent.pub, c, sig)
	}
	for range 63 {
		challenge()
	}
	last := challenge()
	if _, err := s.Challenge(id, agent.pub); err == nil {
		t.Fatal("challenge count not capped")
	}
	now = now.Add(time.Minute)
	if _, err := issue(last); err == nil {
		t.Fatal("expired challenge accepted")
	}
	for _, disable := range []bool{false, true} {
		c := challenge()
		ticket, err := issue(c)
		if err != nil {
			t.Fatal(err)
		}
		pending := challenge()
		if disable {
			if err := s.DisableHost(id); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Challenge(id, agent.pub); err == nil {
				t.Fatal("disabled host challenged")
			}
			hosts, err := s.Hosts()
			if err != nil || len(hosts) != 1 || hosts[0] != (authHost{id, "test", false}) {
				t.Fatal(hosts, err)
			}
		} else {
			now = now.Add(time.Minute)
		}
		if _, err := issue(pending); err == nil {
			t.Fatal("stale challenge issued ticket")
		}
		if _, err := s.Lookup(ticket); err == nil {
			t.Fatal("stale ticket lookup")
		}
		nonce := authNonce()
		if _, err := s.Redeem(ticket, nonce, agent.sign(t, agentNamespace, agentNamespace+"\n"+nonce+"\n")); err == nil {
			t.Fatal("stale ticket redeemed")
		}
	}
}
func TestStoreOpenSSH(t *testing.T) {
	bin, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("OpenSSH unavailable")
	}
	path := filepath.Join(t.TempDir(), "synthetic")
	if out, err := exec.Command(bin, "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", path).CombinedOutput(); err != nil {
		t.Fatal(string(out), err)
	}
	pub, err := os.ReadFile(path + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	msg := "pi-remote-agent-v1\n" + authNonce() + "\n"
	cmd := exec.Command(bin, "-Y", "sign", "-n", "pi-remote-agent-v1", "-f", path)
	cmd.Stdin = strings.NewReader(msg)
	signature, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyAuthSig(strings.TrimSpace(string(pub)), string(signature), agentNamespace, msg); err != nil {
		t.Fatal(err)
	}
}
