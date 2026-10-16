package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func run() error {
	config, err := loadConfig(os.LookupEnv)
	if err != nil {
		return err
	}
	credentials, err := loadCredentials(config.TokenFile)
	if err != nil {
		return err
	}
	gateway := newGateway(config, credentials)
	listener, err := net.Listen("tcp", net.JoinHostPort(config.Host, strconv.Itoa(config.Port)))
	if err != nil {
		return errors.New("Cannot start gateway. Check configuration and listening address.")
	}
	server := &http.Server{Handler: gateway, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		gateway.close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	logEvent("server.started", Message{"host": config.Host, "port": listener.Addr().(*net.TCPAddr).Port})
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return errors.New("Gateway HTTP server stopped unexpectedly.")
}
func main() {
	log.SetFlags(0)
	if err := run(); err != nil {
		logEvent("server.startup_failed", Message{"message": err.Error()})
		os.Exit(1)
	}
}
