package main

import (
	"context"
	"fmt"
)

type DependencyUpdate struct {
	Run     *Run           `json:"run"`
	MRs     []DependencyMR `json:"mrs"`
	Outcome string         `json:"outcome"`
	Error   string         `json:"error,omitempty"`
}

type DependencyMR struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	State  string `json:"state"`
}

// Workflows are discovered separately from the short deployment run history:
// weekly Renovate runs can easily be displaced by delivery and review workflows.
func (d *Dashboard) dependencyUpdate(ctx context.Context, repo string) (*DependencyUpdate, error) {
	result := &DependencyUpdate{MRs: []DependencyMR{}, Outcome: "unknown"}
	base := d.githubURL + "/repos/" + repo
	var workflowID int64
	for page := 1; ; page++ {
		var data struct {
			Workflows []struct {
				ID   int64
				Path string
			}
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/actions/workflows?per_page=100&page=%d", base, page), d.githubToken, &data); err != nil {
			return result, err
		}
		for _, workflow := range data.Workflows {
			if workflow.Path == ".github/workflows/update_dependencies.yml" {
				workflowID = workflow.ID
				break
			}
		}
		if workflowID != 0 || len(data.Workflows) < 100 {
			break
		}
	}
	if workflowID == 0 {
		return result, nil
	}
	var data struct {
		Runs []struct {
			ID                 int64
			Attempt            int `json:"run_attempt"`
			Status, Conclusion string
			HTMLURL            string `json:"html_url"`
			UpdatedAt          string `json:"updated_at"`
		} `json:"workflow_runs"`
	}
	if err := getJSON(ctx, d.github, fmt.Sprintf("%s/actions/workflows/%d/runs?per_page=1", base, workflowID), d.githubToken, &data); err != nil {
		return result, err
	}
	if len(data.Runs) == 0 {
		return result, nil
	}
	run := data.Runs[0]
	status := run.Status
	if status == "completed" {
		status = run.Conclusion
	}
	result.Run = &Run{Status: status, URL: run.HTMLURL, UpdatedAt: run.UpdatedAt}
	if run.Status != "completed" {
		result.Outcome = "pending"
		return result, nil
	}
	if run.ID <= 0 || run.Attempt <= 0 {
		return result, fmt.Errorf("dependency run identity unavailable")
	}
	logs, err := d.dependencyLogs(ctx, fmt.Sprintf("%s/actions/runs/%d/attempts/%d/logs", base, run.ID, run.Attempt))
	if err != nil {
		return result, err
	}
	numbers, err := createdDependencyPRs(logs, repo)
	if err != nil {
		return result, err
	}
	for _, number := range numbers {
		var pr struct {
			Title, State string
			MergedAt     *string `json:"merged_at"`
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/pulls/%d", base, number), d.githubToken, &pr); err != nil {
			return result, err
		}
		state := pr.State
		if pr.MergedAt != nil {
			state = "merged"
		}
		result.MRs = append(result.MRs, DependencyMR{Number: number, Title: pr.Title, URL: fmt.Sprintf("https://github.com/%s/pull/%d", repo, number), State: state})
	}
	result.Outcome = "no PR created"
	if len(result.MRs) > 0 {
		result.Outcome = "PR created"
	}
	return result, nil
}
