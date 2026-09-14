package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProductionReadiness(t *testing.T) {
	for _, tc := range []struct{ name, body, want string }{
		{"ready", `{"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"replicas":1,"updatedReplicas":1,"availableReplicas":1}}`, "healthy"},
		{"old pods still available", `{"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":1,"replicas":1,"updatedReplicas":1,"availableReplicas":1}}`, "deploying"},
		{"surge still rolling", `{"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"replicas":2,"updatedReplicas":1,"availableReplicas":2}}`, "deploying"},
		{"deadline exceeded", `{"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"conditions":[{"type":"Progressing","status":"False"}]}}`, "unhealthy"},
		{"scaled down", `{"spec":{"replicas":0}}`, "scaled down"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var item deployment
			if err := json.Unmarshal([]byte(tc.body), &item); err != nil {
				t.Fatal(err)
			}
			if got := workload(item).Status; got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestPipelineCombinesChecksAndLegacyStatus(t *testing.T) {
	for _, tc := range []struct{ name, status, checks, want string }{
		{"no checks is not success", `{"state":"pending","total_count":0}`, `{"check_runs":[]}`, "no checks"},
		{"running check", `{"state":"success","total_count":1}`, `{"check_runs":[{"status":"in_progress"}]}`, "running"},
		{"failure wins over running", `{"state":"failure","total_count":1}`, `{"check_runs":[{"status":"in_progress"}]}`, "failed"},
		{"cancelled check", `{"state":"success","total_count":1}`, `{"check_runs":[{"status":"completed","conclusion":"cancelled"}]}`, "failed"},
		{"passing", `{"state":"success","total_count":1}`, `{"check_runs":[{"status":"completed","conclusion":"success"}]}`, "passed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/status") {
					w.Write([]byte(tc.status))
				} else {
					w.Write([]byte(tc.checks))
				}
			}))
			defer server.Close()
			d := Dashboard{github: server.Client(), githubURL: server.URL}
			got, err := d.pipeline(context.Background(), "owner/repo", "sha")
			if err != nil || got != tc.want {
				t.Fatalf("got %s, %v; want %s", got, err, tc.want)
			}
		})
	}
}

func TestPartialFailureDoesNotHideHealthyApplication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Error("missing service account token")
		}
		if strings.Contains(r.URL.Path, "/broken/") {
			w.WriteHeader(403)
			return
		}
		w.Write([]byte(`{"items":[{"metadata":{"name":"server","generation":1},"spec":{"replicas":1,"template":{"spec":{"containers":[{"image":"app:prod-12"}]}}},"status":{"observedGeneration":1,"replicas":1,"updatedReplicas":1,"availableReplicas":1}}]}`))
	}))
	defer server.Close()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("token"), 0600); err != nil {
		t.Fatal(err)
	}
	d := Dashboard{config: Config{Environment: "p07", Apps: []App{{Namespace: "healthy"}, {Namespace: "broken"}}}, kube: server.Client(), kubeURL: server.URL, kubeTokenFile: token}
	d.collect(context.Background())
	if d.snapshot.Apps[0].Health != "healthy" || d.snapshot.Apps[0].Workloads[0].Images[0] != "app:prod-12" {
		t.Fatal("healthy deployment or production image lost")
	}
	if d.snapshot.Apps[1].Health != "unknown" || len(d.snapshot.Apps[1].Errors) != 1 {
		t.Fatal("failure must be visible as unknown")
	}
}

func TestAPIAndEmbeddedUI(t *testing.T) {
	d := Dashboard{}
	before := httptest.NewRecorder()
	d.handler().ServeHTTP(before, httptest.NewRequest("GET", "/api/apps", nil))
	if before.Code != 503 {
		t.Fatal("initial collection must not look like an empty fleet")
	}
	d.snapshot = Snapshot{Environment: "p07", UpdatedAt: time.Now(), Apps: []Result{}}
	for _, path := range []string{"/", "/app.js", "/style.css", "/api/apps", "/healthz"} {
		w := httptest.NewRecorder()
		d.handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("%s: missing resource or security headers", path)
		}
	}
}

func TestRepositorySeparatesIssuesAndFindsApplicationDeploy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-token" {
			t.Error("missing GitHub credential")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/search/issues":
			if !strings.Contains(r.URL.Query().Get("q"), "is:issue") {
				t.Error("must exclude PRs from issue count")
			}
			w.Write([]byte(`{"total_count":7}`))
		case "/repos/owner/repo/pulls":
			w.Write([]byte(`[{"number":12,"title":"A change","html_url":"https://github.com/owner/repo/pull/12","head":{"sha":"abc"}}]`))
		case "/repos/owner/repo/commits/abc/status":
			w.Write([]byte(`{"state":"pending","total_count":0}`))
		case "/repos/owner/repo/commits/abc/check-runs":
			w.Write([]byte(`{"check_runs":[{"status":"completed","conclusion":"failure"}]}`))
		case "/repos/owner/repo/actions/runs":
			w.Write([]byte(`{"workflow_runs":[{"id":2,"path":".github/workflows/pages.yml"},{"id":1,"path":".github/workflows/pipeline.yml","updated_at":"2026-09-14T10:00:00Z"}]}`))
		case "/repos/owner/repo/actions/runs/1/jobs":
			w.Write([]byte(`{"jobs":[{"name":"deploy","status":"completed","conclusion":"failure","html_url":"https://github.com/owner/repo/actions/runs/1"}]}`))
		default:
			t.Errorf("unexpected API request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	d := Dashboard{github: server.Client(), githubURL: server.URL, githubToken: "private-token"}
	result, err := d.repository(context.Background(), "owner/repo", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Issues != 7 || result.OpenMRs != 1 || result.MRs[0].Pipeline != "failed" || result.Deployment == nil || result.Deployment.Status != "failure" {
		t.Fatalf("incorrect repository signals: %+v", result)
	}
}

func TestCollectorDeadlineAndCredentialRedaction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	var data any
	err := getJSON(ctx, server.Client(), server.URL, "secret", &data)
	if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("unexpected error: %v", err)
	}
}
