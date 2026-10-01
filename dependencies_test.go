package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func logArchive(t *testing.T, logs ...string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	w := zip.NewWriter(&buffer)
	for i, log := range logs {
		file, err := w.Create(fmt.Sprintf("%d_job.txt", i))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(log)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

const finishedLog = "2026-10-01T10:10:00Z  INFO: Repository finished (repository=o/r)\n"
const createdLog = "2026-10-01T10:05:00Z  INFO: PR created (repository=o/r, branch=renovate/all)\n2026-10-01T10:05:00Z        \"pr\": 42,\n"

func TestCreatedDependencyPRs(t *testing.T) {
	for _, tc := range []struct {
		name, log string
		want      int
		fail      bool
	}{
		{"creation", createdLog + finishedLog, 1, false},
		{"deduplicated", createdLog + createdLog + finishedLog, 1, false},
		{"different repository", strings.ReplaceAll(createdLog, "repository=o/r", "repository=other/r") + finishedLog, 0, false},
		{"updated PR is not created", strings.Replace(createdLog, "PR created", "PR updated", 1) + finishedLog, 0, false},
		{"dry run is not created", strings.Replace(createdLog, "PR created", "DRY-RUN: Would create PR", 1) + finishedLog, 0, false},
		{"cached PR mention is not created", "2026-10-01T10:05:00Z DEBUG: Found existing PR (repository=o/r)\n2026-10-01T10:05:00Z        \"pr\": 42,\n" + finishedLog, 0, false},
		{"green run with abort", "2026-10-01T10:05:00Z DEBUG: Caught error setting branch status - aborting (repository=o/r, branch=renovate/all)\n" + finishedLog, 0, false},
		{"missing completion", createdLog, 0, true},
		{"unrecognized format", "something unrelated", 0, true},
		{"incomplete creation record", "2026-10-01T10:05:00Z INFO: PR created (repository=o/r)\n" + finishedLog, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := createdDependencyPRs(logArchive(t, tc.log), "o/r")
			if (err != nil) != tc.fail || len(got) != tc.want {
				t.Fatalf("got %v, %v", got, err)
			}
			if tc.want > 0 && got[0] != 42 {
				t.Fatalf("wrong PR: %v", got)
			}
		})
	}
	got, err := createdDependencyPRs(logArchive(t, createdLog+finishedLog, strings.ReplaceAll(createdLog, `"pr": 42`, `"pr": 43`)), "o/r")
	if err != nil || len(got) != 2 {
		t.Fatalf("multiple PRs lost: %v, %v", got, err)
	}
	if _, err := createdDependencyPRs([]byte("not a zip"), "o/r"); err == nil {
		t.Fatal("invalid archive accepted")
	}
	if _, err := createdDependencyPRs(logArchive(t, strings.Repeat("x", dependencyLogLimit+1)), "o/r"); err == nil {
		t.Fatal("oversized decompressed archive accepted")
	}
}

func TestDependencyLogDownloadFailures(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		location  string
		oversized bool
	}{
		{name: "expired", status: http.StatusGone},
		{name: "insecure redirect", status: http.StatusFound, location: "http://example.com/private"},
		{name: "userinfo redirect", status: http.StatusFound, location: "https://secret@example.com/private"},
		{name: "oversized download", status: http.StatusOK, oversized: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", tc.location)
				w.WriteHeader(tc.status)
				if tc.oversized {
					fmt.Fprint(w, strings.Repeat("x", dependencyLogLimit+1))
				}
			}))
			defer server.Close()
			d := Dashboard{github: server.Client(), githubToken: "secret"}
			_, err := d.dependencyLogs(context.Background(), server.URL)
			if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("unsafe or missing download error: %v", err)
			}
		})
	}
}

func TestDependencyRunEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, status, logs, outcome, failPath string
		noRun, noWorkflow, paginate           bool
		wantPR                                bool
	}{
		{name: "exact created PR", logs: createdLog + finishedLog, outcome: "PR created", wantPR: true},
		{name: "workflow pagination", logs: createdLog + finishedLog, outcome: "PR created", wantPR: true, paginate: true},
		{name: "no created PR despite workflow success", logs: finishedLog, outcome: "no PR created"},
		{name: "running", status: "in_progress", outcome: "pending"},
		{name: "no runs never falls back to old PR", noRun: true, outcome: "unknown"},
		{name: "no workflow", noWorkflow: true, outcome: "unknown"},
		{name: "expired logs", failPath: "/repos/o/r/actions/runs/7/attempts/2/logs", outcome: "unknown"},
		{name: "PR lookup fails", logs: createdLog + finishedLog, failPath: "/repos/o/r/pulls/42", outcome: "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive := logArchive(t, tc.logs)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer secret" {
					t.Error("missing credential")
				}
				if r.URL.Path == tc.failPath {
					w.WriteHeader(410)
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
						t.Error("must query latest run")
					}
					if tc.noRun {
						fmt.Fprint(w, `{"workflow_runs":[]}`)
						return
					}
					status := tc.status
					if status == "" {
						status = "completed"
					}
					fmt.Fprintf(w, `{"workflow_runs":[{"id":7,"run_attempt":2,"status":%q,"conclusion":"success","html_url":"https://github.com/o/r/actions/runs/7","updated_at":"2026-10-01T10:10:00Z"}]}`, status)
				case "/repos/o/r/actions/runs/7/attempts/2/logs":
					w.Write(archive)
				case "/repos/o/r/pulls/42":
					fmt.Fprint(w, `{"title":"Update dependencies","state":"closed","merged_at":"2026-10-01T11:00:00Z"}`)
				default:
					t.Errorf("unexpected request (must not search unrelated PRs or prior attempts): %s", r.URL)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			d := Dashboard{github: server.Client(), githubURL: server.URL, githubToken: "secret"}
			update, err := d.dependencyUpdate(context.Background(), "o/r")
			if (err != nil) != (tc.failPath != "") || update.Outcome != tc.outcome {
				t.Fatalf("got %+v, %v", update, err)
			}
			if tc.wantPR {
				if len(update.MRs) != 1 || update.MRs[0].Number != 42 || update.MRs[0].State != "merged" || update.MRs[0].URL != "https://github.com/o/r/pull/42" {
					t.Fatalf("wrong PR: %+v", update.MRs)
				}
			} else if len(update.MRs) != 0 {
				t.Fatalf("unrelated PRs returned: %+v", update.MRs)
			}
			if !tc.noRun && !tc.noWorkflow && update.Run == nil {
				t.Fatal("run data lost")
			}
		})
	}
}

func TestDependencyLogRedirectDoesNotForwardCredential(t *testing.T) {
	storage := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("credential leaked to log storage")
		}
		fmt.Fprint(w, "archive")
	}))
	defer storage.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing API credential")
		}
		http.Redirect(w, r, storage.URL+"?signed=private", http.StatusFound)
	}))
	defer api.Close()
	d := Dashboard{github: storage.Client(), githubToken: "secret"}
	got, err := d.dependencyLogs(context.Background(), api.URL)
	if err != nil || string(got) != "archive" {
		t.Fatalf("%q, %v", got, err)
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
