package main

import (
	"context"
	"fmt"
	"strings"
)

type DependencyUpdate struct {
	Run   *Run          `json:"run"`
	MR    *DependencyMR `json:"mr"`
	Error string        `json:"error,omitempty"`
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
	result := &DependencyUpdate{}
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
	// GitHub has no direct run-to-PR association for Renovate. Show the newest
	// local renovate/* PR independently: a successful run may create no PRs.
	for page := 1; ; page++ {
		var prs []struct {
			Number       int
			Title, State string
			HTMLURL      string  `json:"html_url"`
			MergedAt     *string `json:"merged_at"`
			Head         struct {
				Ref  string
				Repo struct {
					FullName string `json:"full_name"`
				}
			}
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/pulls?state=all&sort=created&direction=desc&per_page=100&page=%d", base, page), d.githubToken, &prs); err != nil {
			return result, err
		}
		for _, pr := range prs {
			if !strings.HasPrefix(pr.Head.Ref, "renovate/") || !strings.EqualFold(pr.Head.Repo.FullName, repo) {
				continue
			}
			state := pr.State
			if pr.MergedAt != nil {
				state = "merged"
			}
			result.MR = &DependencyMR{Number: pr.Number, Title: pr.Title, URL: pr.HTMLURL, State: state}
			return result, nil
		}
		if len(prs) < 100 {
			return result, nil
		}
	}
}
