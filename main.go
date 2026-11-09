package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type TechnologyStack struct {
	Frontend *string `json:"frontend"`
	Backend  *string `json:"backend"`
}
type App struct {
	Name               string          `json:"name"`
	Namespace          string          `json:"namespace"`
	Repository         string          `json:"repository"`
	URL                string          `json:"url"`
	DeploymentWorkflow string          `json:"deploymentWorkflow,omitempty"`
	Stack              TechnologyStack `json:"stack"`
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
	auth          *Auth
	refresh       chan chan Snapshot
	stackMu       sync.Mutex
	stackCache    map[string]packageStack
}

func getJSON(ctx context.Context, client *http.Client, url, token string, target any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "observatory")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("collection deadline exceeded")
		}
		return fmt.Errorf("upstream unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if err != nil || len(data) > 8<<20 {
		return fmt.Errorf("upstream response too large or incomplete")
	}
	if json.Unmarshal(data, target) != nil {
		return fmt.Errorf("invalid upstream response")
	}
	return nil
}

func (d *Dashboard) collect(ctx context.Context) {
	results := make([]Result, len(d.config.Apps))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for i, app := range d.config.Apps {
		limit <- struct{}{}
		wg.Add(1)
		go func(i int, app App) {
			defer wg.Done()
			defer func() { <-limit }()
			r := Result{App: app, Health: "unknown", Workloads: []Workload{}, Errors: []string{}}
			var signals sync.WaitGroup
			var clusterError, stackError error
			signals.Add(2)
			go func() { defer signals.Done(); clusterError = d.cluster(ctx, &r) }()
			go func() {
				defer signals.Done()
				if app.Repository != "" && (app.Stack.Frontend == nil || app.Stack.Backend == nil) {
					stackError = d.technology(ctx, app.Repository, &r.Stack)
				}
			}()
			if app.Repository != "" {
				data, err := d.repository(ctx, app.Repository, app.DeploymentWorkflow)
				if err != nil {
					r.Errors = append(r.Errors, "GitHub: "+err.Error())
				} else {
					r.RepositoryData = data
					update, err := d.dependencyUpdate(ctx, app.Repository)
					data.DependencyUpdate = update
					if err != nil {
						update.Error = "Dependency updates: " + err.Error()
						r.Errors = append(r.Errors, update.Error)
					}
				}
			}
			signals.Wait()
			if clusterError != nil {
				r.Errors = append(r.Errors, "Kubernetes: "+clusterError.Error())
			}
			if stackError != nil {
				r.Errors = append(r.Errors, "Technology stack: "+stackError.Error())
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
	mux.Handle("GET /api/apps", d.authorize(false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		d.mu.RLock()
		defer d.mu.RUnlock()
		if d.snapshot.UpdatedAt.IsZero() {
			jsonError(w, 503, "Initial collection in progress")
			return
		}
		json.NewEncoder(w).Encode(d.snapshot)
	})))
	mux.Handle("POST /api/apps/refresh", d.authorize(false, http.HandlerFunc(d.refreshApps)))
	mux.Handle("POST /api/issues", d.authorize(true, http.HandlerFunc(d.createIssue)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
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
	repositories := map[string]bool{}
	workflow := regexp.MustCompile(`^[A-Za-z0-9_.-]+\.ya?ml$`)
	if config.Environment == "" || len(config.Apps) == 0 {
		return config, fmt.Errorf("environment and apps are required")
	}
	for _, app := range config.Apps {
		u, urlErr := url.Parse(app.URL)
		invalidNamespace := app.Namespace != "" && (len(app.Namespace) > 63 || !slug.MatchString(app.Namespace) || seen[app.Namespace])
		invalidRepositoryOnly := app.Namespace == "" && (app.Repository == "" || repositories[app.Repository])
		invalidStack := false
		for _, label := range []*string{app.Stack.Frontend, app.Stack.Backend} {
			if label != nil && (strings.TrimSpace(*label) == "" || len(*label) > 120) {
				invalidStack = true
			}
		}
		if strings.TrimSpace(app.Name) == "" || invalidNamespace || invalidRepositoryOnly || invalidStack || (app.Repository != "" && !repo.MatchString(app.Repository)) || (app.DeploymentWorkflow != "" && !workflow.MatchString(app.DeploymentWorkflow)) || urlErr != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return config, fmt.Errorf("invalid app configuration: %q", app.Name)
		}
		seen[app.Namespace] = true
		if app.Namespace == "" {
			repositories[app.Repository] = true
		}
	}
	return config, nil
}

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		fmt.Println("Observatory Go server\nConfiguration: CONFIG_FILE, OIDC_ISSUER, API_CLIENT_ID, LISTEN_ADDR, GITHUB_TOKEN_FILE")
		return
	}
	if len(os.Args) != 1 {
		log.Fatal("unexpected arguments; use --help")
	}
	if strings.TrimSpace(os.Getenv("OIDC_ISSUER")) == "" {
		log.Fatal("OIDC_ISSUER is required")
	}
	if strings.TrimSpace(os.Getenv("API_CLIENT_ID")) == "" {
		log.Fatal("API_CLIENT_ID is required")
	}
	addr := envDefault("LISTEN_ADDR", "127.0.0.1:8080")
	if _, _, err := net.SplitHostPort(addr); err != nil {
		log.Fatal("LISTEN_ADDR must contain a host and port")
	}
	if !httpsEndpoint(envDefault("GITHUB_API_URL", "https://api.github.com")) {
		log.Fatal("upstream endpoints must use HTTPS")
	}
	path := os.Getenv("CONFIG_FILE")
	if path == "" {
		path = "config.json"
	}
	config, err := loadConfig(path)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	client, err := upstreamClient(os.Getenv("GITHUB_CA_FILE"))
	if err != nil {
		log.Fatal(err)
	}
	d := &Dashboard{config: config, github: client, githubURL: envDefault("GITHUB_API_URL", "https://api.github.com"), githubToken: os.Getenv("GITHUB_TOKEN"), kubeURL: envDefault("KUBERNETES_API_URL", "https://kubernetes.default.svc"), kubeTokenFile: envDefault("KUBERNETES_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"), refresh: make(chan chan Snapshot, 32)}
	if !httpsEndpoint(d.githubURL) || !httpsEndpoint(d.kubeURL) {
		log.Fatal("upstream endpoints require HTTPS without credentials, query or fragment")
	}
	if file := os.Getenv("GITHUB_TOKEN_FILE"); file != "" {
		token, err := os.ReadFile(file)
		if err != nil {
			log.Fatal("read GitHub token file: ", err)
		}
		d.githubToken = string(token)
	}
	d.githubToken = strings.TrimSpace(d.githubToken)
	kubeCA := envDefault("KUBERNETES_CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if _, err := os.Stat(kubeCA); err == nil {
		d.kube, err = upstreamClient(kubeCA)
		if err != nil {
			log.Fatal(err)
		}
	} else if !os.IsNotExist(err) || os.Getenv("KUBERNETES_CA_FILE") != "" {
		log.Fatal(err)
	}
	d.auth, err = newAuth(ctx, os.Getenv("OIDC_ISSUER"), os.Getenv("API_CLIENT_ID"))
	if err != nil {
		log.Fatal(err)
	}
	go d.runCollector(ctx)
	server := &http.Server{Addr: addr, Handler: d.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 65 * time.Second, IdleTimeout: 60 * time.Second}
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

func envDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func httpsEndpoint(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

func upstreamClient(caFile string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caFile != "" {
		ca, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			return nil, err
		}
		if !pool.AppendCertsFromPEM(ca) {
			return nil, fmt.Errorf("invalid upstream CA")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return &http.Client{Timeout: 12 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func (d *Dashboard) runCollector(ctx context.Context) {
	var waiting chan Snapshot
	for {
		poll, cancel := context.WithTimeout(ctx, 50*time.Second)
		d.collect(poll)
		cancel()
		if ctx.Err() != nil {
			return
		}
		d.mu.RLock()
		snapshot := d.snapshot
		d.mu.RUnlock()
		if waiting != nil {
			waiting <- snapshot
		}
		draining := true
		for draining {
			select {
			case request := <-d.refresh:
				request <- snapshot
			default:
				draining = false
			}
		}
		timer := time.NewTimer(60 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case waiting = <-d.refresh:
			timer.Stop()
		case <-timer.C:
			waiting = nil
		}
	}
}

func jsonError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func sameOriginRequest(r *http.Request, action string) bool {
	return r.Header.Get("X-Observatory-Request") == action && (r.Header.Get("Sec-Fetch-Site") == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin")
}

func (d *Dashboard) refreshApps(w http.ResponseWriter, r *http.Request) {
	if !sameOriginRequest(r, "refresh") {
		jsonError(w, 403, "Refresh requires a same-origin dashboard request.")
		return
	}
	reply := make(chan Snapshot, 1)
	select {
	case d.refresh <- reply:
	default:
		jsonError(w, 503, "Collector is unavailable or busy. Try again shortly.")
		return
	}
	select {
	case snapshot := <-reply:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(snapshot)
	case <-r.Context().Done():
		return
	case <-time.After(60 * time.Second):
		jsonError(w, 503, "Collector stopped. Try again shortly.")
	}
}
