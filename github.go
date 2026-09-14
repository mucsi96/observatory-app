package main

import (
	"context"
	"fmt"
	"net/url"
)

type PullRequest struct {
	Number   int    `json:"number"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Pipeline string `json:"pipeline"`
	Draft    bool   `json:"draft"`
}
type Run struct {
	Status    string `json:"status"`
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt"`
}
type RepositoryData struct {
	OpenMRs    int           `json:"openMRs"`
	Issues     int           `json:"issues"`
	MRs        []PullRequest `json:"mrs"`
	Deployment *Run          `json:"deployment"`
}

// Count issues separately from PRs and combine checks with legacy commit statuses.
func (d *Dashboard) repository(ctx context.Context, repo, workflow string) (*RepositoryData, error) {
	if d.githubToken == "" {
		return nil, fmt.Errorf("GITHUB_TOKEN is not configured")
	}
	// REST search gives exact counts; the detail list is paginated separately.
	count := func(kind string) (int, error) {
		var data struct {
			TotalCount int  `json:"total_count"`
			Incomplete bool `json:"incomplete_results"`
		}
		err := getJSON(ctx, d.github, d.githubURL+"/search/issues?q="+url.QueryEscape("repo:"+repo+" is:open is:"+kind)+"&per_page=1", d.githubToken, &data)
		if data.Incomplete {
			return 0, fmt.Errorf("GitHub search results incomplete")
		}
		return data.TotalCount, err
	}
	issues, err := count("issue")
	if err != nil {
		return nil, err
	}
	result := &RepositoryData{Issues: issues, MRs: []PullRequest{}}
	for page := 1; ; page++ {
		var prs []struct {
			Number  int
			Title   string
			HTMLURL string `json:"html_url"`
			Draft   bool
			Head    struct{ SHA string }
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/repos/%s/pulls?state=open&per_page=100&page=%d", d.githubURL, repo, page), d.githubToken, &prs); err != nil {
			return nil, err
		}
		for _, pr := range prs {
			state, err := d.pipeline(ctx, repo, pr.Head.SHA)
			if err != nil {
				state = "unknown"
			}
			result.MRs = append(result.MRs, PullRequest{Number: pr.Number, Title: pr.Title, URL: pr.HTMLURL, Draft: pr.Draft, Pipeline: state})
		}
		if len(prs) < 100 {
			break
		}
	}
	result.OpenMRs = len(result.MRs)
	// Existing app delivery workflows have a deploy job; report that job rather
	// than an unrelated review/renovate workflow or the latest successful release.
	if workflow == "" {
		workflow = "pipeline.yml"
	}
	var runs struct {
		Runs []struct {
			ID        int64
			Path      string
			HTMLURL   string `json:"html_url"`
			UpdatedAt string `json:"updated_at"`
		} `json:"workflow_runs"`
	}
	if err := getJSON(ctx, d.github, d.githubURL+"/repos/"+repo+"/actions/runs?branch=main&per_page=20", d.githubToken, &runs); err != nil {
		return nil, err
	}
	for _, run := range runs.Runs {
		if run.Path != ".github/workflows/"+workflow {
			continue
		}
		var jobs struct {
			Jobs []struct {
				Name, Status, Conclusion string
				HTMLURL                  string `json:"html_url"`
			}
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/repos/%s/actions/runs/%d/jobs?per_page=100", d.githubURL, repo, run.ID), d.githubToken, &jobs); err != nil {
			return nil, err
		}
		for _, job := range jobs.Jobs {
			if job.Name == "deploy" || job.Name == "Deploy" {
				status := job.Status
				if status == "completed" {
					status = job.Conclusion
				}
				result.Deployment = &Run{Status: status, URL: job.HTMLURL, UpdatedAt: run.UpdatedAt}
				return result, nil
			}
		}
	}
	return result, nil
}

func (d *Dashboard) pipeline(ctx context.Context, repo, sha string) (string, error) {
	base := d.githubURL + "/repos/" + repo + "/commits/" + sha
	var status struct {
		State      string
		TotalCount int `json:"total_count"`
	}
	if err := getJSON(ctx, d.github, base+"/status", d.githubToken, &status); err != nil {
		return "", err
	}
	failed, pending, count := status.State == "failure" || status.State == "error", status.TotalCount > 0 && status.State == "pending", status.TotalCount
	for page := 1; ; page++ {
		var checks struct {
			Runs []struct{ Status, Conclusion string } `json:"check_runs"`
		}
		if err := getJSON(ctx, d.github, fmt.Sprintf("%s/check-runs?filter=latest&per_page=100&page=%d", base, page), d.githubToken, &checks); err != nil {
			return "", err
		}
		for _, check := range checks.Runs {
			count++
			if check.Status != "completed" {
				pending = true
			} else {
				switch check.Conclusion {
				case "success", "neutral", "skipped":
				default:
					failed = true
				}
			}
		}
		if len(checks.Runs) < 100 {
			break
		}
	}
	if failed {
		return "failed", nil
	}
	if pending {
		return "running", nil
	}
	if count == 0 {
		return "no checks", nil
	}
	return "passed", nil
}
