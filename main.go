package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

type App struct {
	Name               string `json:"name"`
	Namespace          string `json:"namespace"`
	Repository         string `json:"repository"`
	URL                string `json:"url"`
	DeploymentWorkflow string `json:"deploymentWorkflow,omitempty"`
}
type Config struct {
	Environment string `json:"environment"`
	Apps        []App  `json:"apps"`
}
type Workload struct {
	Name    string   `json:"name"`
	Images  []string `json:"images"`
	Ready   int      `json:"ready"`
	Desired int      `json:"desired"`
	Status  string   `json:"status"`
}
type Result struct {
	App
	Health         string          `json:"health"`
	Workloads      []Workload      `json:"workloads"`
	RepositoryData *RepositoryData `json:"repositoryData"`
	Errors         []string        `json:"errors"`
}
type Snapshot struct {
	Environment string    `json:"environment"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Apps        []Result  `json:"apps"`
}
type Dashboard struct {
	config        Config
	kubeURL       string
	kubeTokenFile string
	kube          *http.Client
	github        *http.Client
	githubURL     string
	githubToken   string
	mu            sync.RWMutex
	snapshot      Snapshot
}

func getJSON(ctx context.Context, client *http.Client, url, token string, target any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upstream unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(target)
}

func (d *Dashboard) collect(ctx context.Context) {
	results := make([]Result, len(d.config.Apps))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for i, app := range d.config.Apps {
		wg.Add(1)
		go func(i int, app App) {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			r := Result{App: app, Health: "unknown", Workloads: []Workload{}, Errors: []string{}}
			if err := d.cluster(ctx, &r); err != nil {
				r.Errors = append(r.Errors, "Kubernetes: "+err.Error())
			}
			if app.Repository != "" {
				data, err := d.repository(ctx, app.Repository, app.DeploymentWorkflow)
				if err != nil {
					r.Errors = append(r.Errors, "GitHub: "+err.Error())
				} else {
					r.RepositoryData = data
				}
			}
			results[i] = r
		}(i, app)
	}
	wg.Wait()
	d.mu.Lock()
	defer d.mu.Unlock()
	d.snapshot = Snapshot{Environment: d.config.Environment, UpdatedAt: time.Now().UTC(), Apps: results}
}

func (d *Dashboard) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/apps", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		d.mu.RLock()
		defer d.mu.RUnlock()
		if d.snapshot.UpdatedAt.IsZero() {
			http.Error(w, `{"error":"Initial collection in progress"}`, 503)
			return
		}
		json.NewEncoder(w).Encode(d.snapshot)
	})
	web, _ := fs.Sub(assets, "web")
	mux.Handle("GET /", http.FileServer(http.FS(web)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}

func loadConfig(path string) (Config, error) {
	var config Config
	data, err := os.ReadFile(path)
	if err != nil {
		return config, err
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return config, err
	}
	slug := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	repo := regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	seen := map[string]bool{}
	if config.Environment == "" || len(config.Apps) == 0 {
		return config, fmt.Errorf("environment and apps are required")
	}
	for _, app := range config.Apps {
		if app.Name == "" || !slug.MatchString(app.Namespace) || seen[app.Namespace] || (app.Repository != "" && !repo.MatchString(app.Repository)) || !strings.HasPrefix(app.URL, "https://") {
			return config, fmt.Errorf("invalid app configuration: %q", app.Name)
		}
		seen[app.Namespace] = true
	}
	return config, nil
}

func main() {
	path := os.Getenv("CONFIG_FILE")
	if path == "" {
		path = "config.json"
	}
	config, err := loadConfig(path)
	if err != nil {
		log.Fatal(err)
	}
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	d := &Dashboard{config: config, github: client, githubURL: "https://api.github.com", githubToken: os.Getenv("GITHUB_TOKEN"), kubeURL: "https://kubernetes.default.svc", kubeTokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token"}
	ca, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err == nil {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(ca) {
			log.Fatal("invalid Kubernetes CA")
		}
		d.kube = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}, CheckRedirect: client.CheckRedirect}
	} else if !os.IsNotExist(err) {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		for {
			poll, cancel := context.WithTimeout(ctx, 50*time.Second)
			d.collect(poll)
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(60 * time.Second):
			}
		}
	}()
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: addr, Handler: d.handler(), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Printf("Observatory listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
