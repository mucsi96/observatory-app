package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/mucsi96/observatory-app/internal/auth"
	"github.com/mucsi96/observatory-app/internal/config"
	"github.com/mucsi96/observatory-app/internal/dashboard"
	"github.com/mucsi96/observatory-app/internal/httpapi"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		port := os.Getenv("MANAGEMENT_PORT")
		if port == "" {
			port = "8082"
		}
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:" + port + "/health/readiness")
		if err != nil {
			os.Exit(1)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	c, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	verifier := auth.NewVerifier(ctx, c.Auth)
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var kube *http.Client
	if c.KubernetesCAFile != "none" {
		ca, err := os.ReadFile(c.KubernetesCAFile)
		if err == nil {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(ca) {
				return fmt.Errorf("invalid Kubernetes CA")
			}
			kube = &http.Client{Timeout: 10 * time.Second, CheckRedirect: client.CheckRedirect, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
		} else if !os.IsNotExist(err) {
			return err
		}
	} else if os.Getenv("APP_ENV") == "test" {
		kube = client
	} else {
		return fmt.Errorf("Kubernetes CA can only be disabled for tests")
	}
	collector := dashboard.NewCollector(dashboard.CollectorOptions{Environment: c.Environment, Apps: c.Apps, GitHubURL: c.GitHubURL, GitHubToken: c.GitHubToken, GitHubClient: client, KubernetesURL: c.KubernetesURL, KubernetesTokenFile: c.KubernetesTokenFile, KubernetesClient: kube})
	cache := &dashboard.Cache{}
	collectorDone := make(chan struct{})
	go func() {
		defer close(collectorDone)
		for {
			poll, cancel := context.WithTimeout(ctx, 50*time.Second)
			snapshot := collector.Collect(poll)
			cancel()
			if ctx.Err() != nil {
				return
			}
			cache.Publish(snapshot)
			select {
			case <-ctx.Done():
				return
			case <-time.After(c.PollInterval):
			}
		}
	}()
	gin.SetMode(gin.ReleaseMode)
	server := &http.Server{Addr: c.ListenAddress, Handler: httpapi.NewRouter(cache, c.Auth, verifier, c.BasePath), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second}
	management := &http.Server{Addr: c.ManagementAddress, Handler: httpapi.NewManagementRouter(cache), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	serverErrors := make(chan error, 2)
	go func() { serverErrors <- server.ListenAndServe() }()
	go func() { serverErrors <- management.ListenAndServe() }()
	slog.Info("Observatory listening", "address", c.ListenAddress, "management", c.ManagementAddress)
	select {
	case <-ctx.Done():
	case err = <-serverErrors:
		stop()
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	shutdownErr := errors.Join(server.Shutdown(shutdown), management.Shutdown(shutdown))
	<-collectorDone
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return shutdownErr
}
