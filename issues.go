package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (d *Dashboard) createIssue(w http.ResponseWriter, r *http.Request) {
	if !sameOriginRequest(r, "create-issue") {
		jsonError(w, 403, "Issue creation requires a same-origin dashboard request.")
		return
	}
	contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if contentType != "application/json" {
		jsonError(w, 415, "Expected JSON.")
		return
	}
	var issue struct{ Repository, Title, Description string }
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&issue)
	if decodeErr == nil {
		decodeErr = decoder.Decode(new(any))
		if decodeErr == io.EOF {
			decodeErr = nil
		} else if decodeErr == nil {
			decodeErr = fmt.Errorf("multiple JSON values")
		}
	}
	if decodeErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(decodeErr, &tooLarge) {
			jsonError(w, 413, "Issue request exceeds 128 KiB.")
			return
		}
		jsonError(w, 400, "Invalid issue payload.")
		return
	}
	configured := false
	for _, app := range d.config.Apps {
		if app.Repository != "" && app.Repository == issue.Repository {
			configured = true
		}
	}
	for _, part := range strings.Split(issue.Repository, "/") {
		if part == "." || part == ".." {
			configured = false
		}
	}
	if !configured {
		jsonError(w, 400, "Select a configured application repository.")
		return
	}
	title := strings.TrimSpace(issue.Title)
	if title == "" || utf8.RuneCountInString(title) > 256 || len(issue.Description) > 65536 {
		jsonError(w, 400, "Provide a title of 1–256 characters and a description of at most 64 KiB.")
		return
	}
	if strings.TrimSpace(d.githubToken) == "" {
		jsonError(w, 503, "Issue creation is not configured. Ask an administrator to configure a GitHub token with Issues write permission.")
		return
	}
	data, _ := json.Marshal(map[string]string{"title": title, "body": issue.Description})
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", d.githubURL+"/repos/"+issue.Repository+"/issues", bytes.NewReader(data))
	if err != nil {
		jsonError(w, 502, "Could not confirm issue creation. Check the repository before trying again to avoid a duplicate.")
		return
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(d.githubToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "observatory")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := d.github.Do(req)
	unconfirmed := func() {
		jsonError(w, 502, "Could not confirm issue creation. Check the repository before trying again to avoid a duplicate.")
	}
	if err != nil {
		unconfirmed()
		return
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 201:
		var result struct{ Number uint64 }
		body, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
		if err != nil || len(body) > 8<<20 || json.Unmarshal(body, &result) != nil || result.Number == 0 {
			unconfirmed()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"number": result.Number, "url": fmt.Sprintf("https://github.com/%s/issues/%d", issue.Repository, result.Number)})
	case 401, 403, 404, 410:
		jsonError(w, 502, "GitHub denied issue creation. Ask an administrator to check token access, Issues write permission, and whether issues are enabled.")
	case 422:
		jsonError(w, 422, "GitHub rejected the issue. Check the title and description.")
	case 429:
		jsonError(w, 429, "GitHub rate limit reached. Try again later.")
	default:
		unconfirmed()
	}
}
