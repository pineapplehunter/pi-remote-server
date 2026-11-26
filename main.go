package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func run() error {
	config, err := loadConfig(os.LookupEnv)
	if err != nil {
		return err
	}
	store, err := openAuthStore(config.DBPath)
	if err != nil {
		return errors.New("Cannot open host authorization database.")
	}
	defer store.Close()
	gateway := newGateway(config, store)
	listener, err := net.Listen("tcp", net.JoinHostPort(config.Host, strconv.Itoa(config.Port)))
	if err != nil {
		return errors.New("Cannot start gateway. Check configuration and listening address.")
	}
	defer listener.Close()
	agentListener, lock, err := listenAgent(config.AgentSocket)
	if err != nil {
		return errors.New("Cannot start private agent socket. Check its path, permissions, and owner.")
	}
	defer lock.Close()
	defer agentListener.Close()
	server := &http.Server{Handler: gateway, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024}
	agentServer := &http.Server{Handler: http.HandlerFunc(gateway.agentHandler), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErrors := make(chan error, 2)
	go func() { serveErrors <- agentServer.Serve(agentListener) }()
	go func() { serveErrors <- server.Serve(listener) }()
	logEvent("server.started", Message{"host": config.Host, "port": listener.Addr().(*net.TCPAddr).Port})
	select {
	case <-ctx.Done():
	case <-serveErrors:
		err = errors.New("Gateway listener stopped unexpectedly.")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = agentServer.Shutdown(shutdown)
	_ = server.Shutdown(shutdown)
	gateway.close()
	return err
}

// Serialize gateway instances on the shared socket directory. After a crash,
// remove a stale socket, but never replace a file or someone else's listener.
func listenAgent(path string) (*net.UnixListener, *os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, nil, errors.New("agent socket path is not absolute")
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (*net.UnixListener, *os.File, error) {
		lock.Close()
		return nil, nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fail(errors.New("agent socket path is occupied by a non-socket"))
		}
		conn, dialErr := net.DialTimeout("unix", path, 200*time.Millisecond)
		if conn != nil {
			conn.Close()
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return fail(errors.New("agent socket path is occupied"))
		}
		if err := os.Remove(path); err != nil {
			return fail(err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	socket, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return fail(err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		socket.Close()
		return fail(err)
	}
	return socket, lock, nil
}
func main() {
	log.SetFlags(0)
	if err := run(); err != nil {
		logEvent("server.startup_failed", Message{"message": err.Error()})
		os.Exit(1)
	}
}
