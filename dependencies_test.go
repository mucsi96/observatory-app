package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDependencyUpdate(t *testing.T) {
	const run = `{"status":"completed","conclusion":"success","html_url":"https://github.com/o/r/actions/runs/7","run_started_at":"2026-10-01T10:00:00Z","updated_at":"2026-10-01T10:10:00Z"}`
	pr := func(number int, branch, repo, created, updated, merged string) string {
		return fmt.Sprintf(`{"number":%d,"title":"Update dependencies","state":"closed","html_url":"https://github.com/o/r/pull/%d","created_at":%q,"updated_at":%q,"merged_at":%s,"head":{"ref":%q,"repo":{"full_name":%q}}}`, number, number, created, updated, merged, branch, repo)
	}
	for _, tc := range []struct {
		name, runs, prs, failPath, wantStatus string
		noWorkflow, paginate                  bool
		wantPR                                int
	}{
		{name: "merged PR retained", runs: run, prs: pr(4, "renovate/go", "o/r", "2026-10-01T10:05:00Z", "2026-10-02T11:00:00Z", `"2026-10-02T11:00:00Z"`), wantStatus: "success", wantPR: 4},
		{name: "PR from earlier run retained", runs: run, prs: pr(3, "renovate/go", "o/r", "2026-09-01T10:00:00Z", "2026-09-01T10:06:00Z", "null"), wantStatus: "success", wantPR: 3},
		{name: "newest matching PR, not unrelated or fork", runs: run, prs: strings.Join([]string{
			pr(9, "renovate/go", "fork/r", "2026-10-01T10:09:00Z", "2026-10-01T10:09:00Z", "null"),
			pr(8, "feature", "o/r", "2026-10-01T10:08:00Z", "2026-10-01T10:08:00Z", "null"),
			pr(7, "renovate/node", "o/r", "2026-10-01T10:07:00Z", "2026-10-01T10:07:00Z", "null"),
			pr(6, "renovate/go", "o/r", "2026-10-01T10:06:00Z", "2026-10-01T10:06:00Z", "null"),
		}, ","), wantStatus: "success", wantPR: 7},
		{name: "PR discovery independent of run timestamp", runs: run, prs: strings.Join([]string{
			pr(9, "renovate/go", "o/r", "2026-10-01T10:11:00Z", "2026-10-01T10:11:00Z", "null"),
			pr(8, "renovate/go", "o/r", "2026-10-01T09:59:00Z", "2026-10-01T09:59:00Z", "null"),
		}, ","), wantStatus: "success", wantPR: 9},
		{name: "workflow and PR pagination", runs: run, prs: pr(5, "renovate/go", "o/r", "2026-10-01T10:05:00Z", "2026-10-01T10:05:00Z", "null"), wantStatus: "success", wantPR: 5, paginate: true},
		{name: "failure", runs: strings.Replace(run, `"success"`, `"failure"`, 1), wantStatus: "failure"},
		{name: "cancelled", runs: strings.Replace(run, `"success"`, `"cancelled"`, 1), wantStatus: "cancelled"},
		{name: "running", runs: strings.Replace(run, `"completed"`, `"in_progress"`, 1), wantStatus: "in_progress"},
		{name: "no workflow", noWorkflow: true},
		{name: "no runs"},
		{name: "workflow API error", failPath: "/repos/o/r/actions/workflows"},
		{name: "run API error", failPath: "/repos/o/r/actions/workflows/12/runs"},
		{name: "PR error preserves run", runs: run, failPath: "/repos/o/r/pulls", wantStatus: "success"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer secret" {
					t.Error("missing server-side credential")
				}
				if r.URL.Path == tc.failPath {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				switch r.URL.Path {
				case "/repos/o/r/actions/workflows":
					if tc.noWorkflow {
						fmt.Fprint(w, `{"workflows":[]}`)
					} else if tc.paginate && r.URL.Query().Get("page") == "1" {
						fmt.Fprintf(w, `{"workflows":[%s]}`, strings.TrimSuffix(strings.Repeat(`{"id":1,"path":".github/workflows/pipeline.yml"},`, 100), ","))
					} else {
						fmt.Fprint(w, `{"workflows":[{"id":12,"path":".github/workflows/update_dependencies.yml"}]}`)
					}
				case "/repos/o/r/actions/workflows/12/runs":
					if r.URL.Query().Get("per_page") != "1" {
						t.Error("must request latest workflow run directly")
					}
					fmt.Fprintf(w, `{"workflow_runs":[%s]}`, tc.runs)
				case "/repos/o/r/pulls":
					if r.URL.Query().Get("state") != "all" || r.URL.Query().Get("sort") != "created" || r.URL.Query().Get("direction") != "desc" {
						t.Error("must include closed PRs ordered by newest creation")
					}
					if tc.paginate && r.URL.Query().Get("page") == "1" {
						other := pr(99, "feature", "o/r", "2026-10-01T10:09:00Z", "2026-10-01T10:09:00Z", "null")
						fmt.Fprintf(w, `[%s]`, strings.TrimSuffix(strings.Repeat(other+",", 100), ","))
					} else {
						fmt.Fprintf(w, `[%s]`, tc.prs)
					}
				default:
					t.Errorf("unexpected request: %s", r.URL)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			d := Dashboard{github: server.Client(), githubURL: server.URL, githubToken: "secret"}
			update, err := d.dependencyUpdate(context.Background(), "o/r")
			if (err != nil) != (tc.failPath != "") {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantStatus == "" {
				if update.Run != nil {
					t.Fatalf("unexpected run: %+v", update.Run)
				}
			} else if update.Run == nil || update.Run.Status != tc.wantStatus || update.Run.URL != "https://github.com/o/r/actions/runs/7" || update.Run.UpdatedAt != "2026-10-01T10:10:00Z" {
				t.Fatalf("incorrect run: %+v", update.Run)
			}
			if tc.wantPR == 0 {
				if update.MR != nil {
					t.Fatalf("unexpected PR: %+v", update.MR)
				}
			} else if update.MR == nil || update.MR.Number != tc.wantPR || update.MR.URL != fmt.Sprintf("https://github.com/o/r/pull/%d", tc.wantPR) {
				t.Fatalf("incorrect PR: %+v", update.MR)
			} else if tc.wantPR == 4 && update.MR.State != "merged" {
				t.Fatalf("merged PR shown as %s", update.MR.State)
			}
		})
	}
}

func TestDependencyFailurePreservesRepositorySignals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search/issues":
			fmt.Fprint(w, `{"total_count":3}`)
		case "/repos/o/r/pulls":
			fmt.Fprint(w, `[]`)
		case "/repos/o/r/actions/runs":
			fmt.Fprint(w, `{"workflow_runs":[]}`)
		case "/repos/o/r/actions/workflows":
			w.WriteHeader(http.StatusForbidden)
		default:
			t.Errorf("unexpected request: %s", r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	d := Dashboard{config: Config{Apps: []App{{Repository: "o/r"}}}, github: server.Client(), githubURL: server.URL, githubToken: "secret"}
	d.collect(context.Background())
	r := d.snapshot.Apps[0]
	if r.RepositoryData == nil || r.RepositoryData.Issues != 3 || r.RepositoryData.DependencyUpdate.Error == "" {
		t.Fatalf("dependency error hid repository signals: %+v", r)
	}
	found := false
	for _, err := range r.Errors {
		found = found || strings.HasPrefix(err, "Dependency updates:")
	}
	if !found {
		t.Fatal("dependency failure missing from application errors")
	}
	data, err := json.Marshal(d.snapshot)
	if err != nil || strings.Contains(string(data), "secret") {
		t.Fatal("snapshot must not contain credentials")
	}
}
