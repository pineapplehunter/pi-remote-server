package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hiddeco/sshsig"
	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/ssh"
)

const (
	hostNamespace  = "pi-remote-host-v1"
	agentNamespace = "pi-remote-agent-v1"
	authTTL        = 60 * time.Second
)

var errAuth = errors.New("invalid or expired credential")

type authHost struct {
	ID, Name string
	Enabled  bool
}
type authStore struct {
	db  *sql.DB
	now func() time.Time
}

func openAuthStore(path string) (*authStore, error) {
	if path == "" {
		return nil, errors.New("missing auth database path")
	}
	dsn := path
	if path != ":memory:" {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(abs, os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
		u := url.URL{Scheme: "file", Path: abs}
		dsn = u.String()
	}
	db, err := sql.Open("sqlite3", dsn+"?_txlock=immediate&_busy_timeout=3000")
	if err != nil {
		return nil, err
	}
	// Keep :memory: on one connection. BEGIN IMMEDIATE (above) also
	// serializes consumers that open the same on-disk DB independently.
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL, pubkey TEXT NOT NULL, enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY,host TEXT NOT NULL,agent TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS challenges_host ON challenges(host);
 CREATE TABLE IF NOT EXISTS tickets (digest BLOB PRIMARY KEY,host TEXT NOT NULL,agent TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS tickets_expiry ON tickets(expires);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &authStore{db, time.Now}, nil
}
func (s *authStore) Close() error { return s.db.Close() }

func parseAuthKey(key string) (ssh.PublicKey, error) {
	const prefix = "ssh-ed25519 "
	if len(key) > 128 || !strings.HasPrefix(key, prefix) {
		return nil, errAuth
	}
	blob, err := base64.StdEncoding.DecodeString(key[len(prefix):])
	if err != nil {
		return nil, errAuth
	}
	pub, err := ssh.ParsePublicKey(blob)
	if err != nil || pub.Type() != ssh.KeyAlgoED25519 || prefix+base64.StdEncoding.EncodeToString(pub.Marshal()) != key {
		return nil, errAuth
	}
	return pub, nil
}
func (s *authStore) AddHost(name, key string) (string, error) {
	if _, err := parseAuthKey(key); err != nil {
		return "", err
	}
	if strings.TrimSpace(name) == "" || len(name) > 256 {
		return "", errors.New("invalid host name")
	}
	id := uuid()
	_, err := s.db.Exec(`INSERT INTO hosts VALUES(?,?,?,1)`, id, name, key)
	if err != nil {
		return "", err
	}
	return id, nil
}
func (s *authStore) Hosts() ([]authHost, error) {
	rows, err := s.db.Query(`SELECT id,name,enabled FROM hosts ORDER BY name,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hosts := []authHost{}
	for rows.Next() {
		var h authHost
		if err := rows.Scan(&h.ID, &h.Name, &h.Enabled); err != nil {
			return nil, err
		}
		hosts = append(hosts, h)
	}
	return hosts, rows.Err()
}
func requireOne(r sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errAuth
	}
	return nil
}
func (s *authStore) DisableHost(id string) error {
	return requireOne(s.db.Exec(`UPDATE hosts SET enabled=0 WHERE id=?`, id))
}
func authNonce() string {
	var b [32]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func validAuthNonce(s string) bool {
	if len(s) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return err == nil && len(b) == 32
}
func ticketDigest(ticket string) []byte { sum := sha256.Sum256([]byte(ticket)); return sum[:] }
func (s *authStore) Challenge(id, key string) (string, error) {
	if _, err := parseAuthKey(key); err != nil {
		return "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	now := s.now()
	if _, err := tx.Exec(`DELETE FROM challenges WHERE expires<=?`, now.UnixMilli()); err != nil {
		return "", err
	}
	nonce := authNonce()
	err = requireOne(tx.Exec(`INSERT INTO challenges (nonce,host,agent,expires)
		SELECT ?,id,?,? FROM hosts WHERE id=? AND enabled=1
		AND (SELECT count(*) FROM challenges WHERE host=?) < 64
		AND (SELECT count(*) FROM challenges) < 4096`, nonce, key, now.Add(authTTL).UnixMilli(), id, id))
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return nonce, nil
}
func verifyAuthSig(key, signature, namespace, msg string) error {
	if len(signature) > 2048 {
		return errAuth
	}
	pub, err := parseAuthKey(key)
	if err != nil {
		return err
	}
	sig, err := sshsig.Unarmor([]byte(signature))
	if err != nil {
		return errAuth
	}
	if sshsig.Verify(strings.NewReader(msg), sig, pub, sig.HashAlgorithm, namespace) != nil {
		return errAuth
	}
	return nil
}
func (s *authStore) Ticket(id, key, nonce, signature string) (string, error) {
	if !validAuthNonce(nonce) {
		return "", errAuth
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var pub string
	err = tx.QueryRow(`SELECT h.pubkey FROM challenges c JOIN hosts h ON h.id=c.host
		WHERE h.enabled=1 AND h.id=? AND c.nonce=? AND c.agent=? AND c.expires>?`, id, nonce, key, s.now().UnixMilli()).Scan(&pub)
	if err != nil {
		return "", err
	}
	if err := verifyAuthSig(pub, signature, hostNamespace, hostNamespace+"\n"+id+"\n"+key+"\n"+nonce+"\n"); err != nil {
		return "", err
	}
	now := s.now()
	if err := requireOne(tx.Exec(`DELETE FROM challenges WHERE nonce=? AND expires>?`, nonce, now.UnixMilli())); err != nil {
		return "", err
	}
	if _, err := tx.Exec(`DELETE FROM tickets WHERE expires<=?`, now.UnixMilli()); err != nil {
		return "", err
	}
	ticket := authNonce()
	if _, err := tx.Exec(`INSERT INTO tickets VALUES(?,?,?,?)`, ticketDigest(ticket), id, key, now.Add(authTTL).UnixMilli()); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return ticket, nil
}

const selectTicket = `SELECT host,agent FROM tickets JOIN hosts ON hosts.id=tickets.host
	WHERE digest=? AND expires>? AND enabled=1`

func (s *authStore) Lookup(ticket string) (string, error) {
	if !validAuthNonce(ticket) {
		return "", errAuth
	}
	var id, key string
	err := s.db.QueryRow(selectTicket, ticketDigest(ticket), s.now().UnixMilli()).Scan(&id, &key)
	return key, err
}
func (s *authStore) Redeem(ticket, nonce, signature string) (string, error) {
	if !validAuthNonce(ticket) || !validAuthNonce(nonce) {
		return "", errAuth
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var id, key string
	digest := ticketDigest(ticket)
	if err := tx.QueryRow(selectTicket, digest, s.now().UnixMilli()).Scan(&id, &key); err != nil {
		return "", err
	}
	if err := verifyAuthSig(key, signature, agentNamespace, agentNamespace+"\n"+nonce+"\n"); err != nil {
		return "", err
	}
	if err := requireOne(tx.Exec(`DELETE FROM tickets WHERE digest=? AND expires>?`, digest, s.now().UnixMilli())); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return id, nil
}
