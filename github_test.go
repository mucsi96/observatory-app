package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRepositoryDeploymentWorkflows(t *testing.T) {
	for _, tc := range []struct {
		name, workflow, runs, jobStatus, conclusion, wantStatus string
		wantRun                                                 int
		jobsFail                                                bool
	}{
		{name: "legacy training log workflow", runs: `[{"id":1,"path":".github/workflows/build.yml"}]`, jobStatus: "completed", conclusion: "success", wantStatus: "success", wantRun: 1},
		{name: "latest delivery wins during migration", runs: `[{"id":2,"path":".github/workflows/build.yml"},{"id":1,"path":".github/workflows/pipeline.yml"}]`, jobStatus: "completed", conclusion: "failure", wantStatus: "failure", wantRun: 2},
		{name: "pipeline remains supported", runs: `[{"id":2,"path":".github/workflows/pipeline.yml"},{"id":1,"path":".github/workflows/build.yml"}]`, jobStatus: "in_progress", wantStatus: "in_progress", wantRun: 2},
		{name: "unrelated workflows excluded", runs: `[{"id":3,"path":".github/workflows/pages.yml"},{"id":2,"path":".github/workflows/update_dependencies.yml"}]`},
		{name: "explicit pipeline excludes legacy", workflow: "pipeline.yml", runs: `[{"id":2,"path":".github/workflows/build.yml"},{"id":1,"path":".github/workflows/pipeline.yml"}]`, jobStatus: "completed", conclusion: "success", wantStatus: "success", wantRun: 1},
		{name: "custom override", workflow: "release.yml", runs: `[{"id":3,"path":".github/workflows/pipeline.yml"},{"id":2,"path":".github/workflows/build.yml"},{"id":1,"path":".github/workflows/release.yml"}]`, jobStatus: "completed", conclusion: "success", wantStatus: "success", wantRun: 1},
		{name: "no deploy job", runs: `[{"id":1,"path":".github/workflows/build.yml"}]`, wantRun: 1},
		{name: "legacy API failure remains visible", runs: `[{"id":1,"path":".github/workflows/build.yml"}]`, wantRun: 1, jobsFail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobRequests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/search/issues":
					fmt.Fprint(w, `{"total_count":0}`)
				case "/repos/owner/repo/pulls":
					fmt.Fprint(w, `[]`)
				case "/repos/owner/repo/actions/runs":
					if r.URL.Query().Get("branch") != "main" || r.URL.Query().Get("per_page") != "20" {
						t.Error("must retain main branch and bounded run history")
					}
					fmt.Fprintf(w, `{"workflow_runs":%s}`, tc.runs)
				case fmt.Sprintf("/repos/owner/repo/actions/runs/%d/jobs", tc.wantRun):
					jobRequests++
					if tc.jobsFail {
						w.WriteHeader(http.StatusForbidden)
					} else if tc.jobStatus == "" {
						fmt.Fprint(w, `{"jobs":[{"name":"test","status":"completed","conclusion":"success"}]}`)
					} else {
						fmt.Fprintf(w, `{"jobs":[{"name":"deploy","status":%q,"conclusion":%q,"html_url":"https://github.com/owner/repo/actions/runs/%d/job/10"}]}`, tc.jobStatus, tc.conclusion, tc.wantRun)
					}
				default:
					t.Errorf("unexpected API request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			d := Dashboard{github: server.Client(), githubURL: server.URL, githubToken: "token"}
			result, err := d.repository(context.Background(), "owner/repo", tc.workflow)
			if tc.wantRun != 0 && jobRequests != 1 {
				t.Fatalf("got %d job requests, want 1", jobRequests)
			}
			if tc.jobsFail {
				if err == nil {
					t.Fatal("API failure must not look like missing deployment data")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantStatus == "" {
				if result.Deployment != nil {
					t.Fatalf("unexpected deployment: %+v", result.Deployment)
				}
				return
			}
			wantURL := fmt.Sprintf("https://github.com/owner/repo/actions/runs/%d/job/10", tc.wantRun)
			if result.Deployment == nil || result.Deployment.Status != tc.wantStatus || result.Deployment.URL != wantURL {
				t.Fatalf("incorrect deployment: %+v", result.Deployment)
			}
		})
	}
}
