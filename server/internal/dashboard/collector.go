package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type CollectorOptions struct {
	Environment         string
	Apps                []App
	KubernetesURL       string
	KubernetesTokenFile string
	KubernetesClient    *http.Client
	GitHubURL           string
	GitHubToken         string
	GitHubClient        *http.Client
}

// Collector reads upstream systems; snapshot caching and HTTP handlers are separate.
type Collector struct {
	environment   string
	apps          []App
	kubeURL       string
	kubeTokenFile string
	kube          *http.Client
	github        *http.Client
	githubURL     string
	githubToken   string
}

func NewCollector(o CollectorOptions) *Collector {
	return &Collector{environment: o.Environment, apps: o.Apps, kubeURL: o.KubernetesURL,
		kubeTokenFile: o.KubernetesTokenFile, kube: o.KubernetesClient,
		github: o.GitHubClient, githubURL: o.GitHubURL, githubToken: o.GitHubToken}
}

func (d *Collector) Collect(ctx context.Context) Snapshot {
	results := make([]Result, len(d.apps))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for i, app := range d.apps {
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
	return Snapshot{Environment: d.environment, UpdatedAt: time.Now().UTC(), Apps: results}
}

func getJSON(ctx context.Context, client *http.Client, url, token string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
