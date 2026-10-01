package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const dependencyLogLimit = 16 << 20

// GitHub redirects log downloads to signed storage URLs. Never forward the
// upstream credential to storage, or return logs/signed URLs to the browser.
func (d *Dashboard) dependencyLogs(ctx context.Context, endpoint string) ([]byte, error) {
	client := *d.github
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("invalid dependency log endpoint")
	}
	req.Header.Set("Authorization", "Bearer "+d.githubToken)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dependency logs unavailable")
	}
	if resp.StatusCode == http.StatusFound {
		location := resp.Header.Get("Location")
		resp.Body.Close()
		target, err := url.Parse(location)
		if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil {
			return nil, fmt.Errorf("invalid dependency log redirect")
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
		if err != nil {
			return nil, fmt.Errorf("invalid dependency log redirect")
		}
		resp, err = client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("dependency logs unavailable")
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dependency logs HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, dependencyLogLimit+1))
	if err != nil || len(data) > dependencyLogLimit {
		return nil, fmt.Errorf("dependency logs incomplete or too large")
	}
	return data, nil
}

// Match actual Renovate events, not PR mentions, cached PRs, updates, or dry runs.
// The event's repository scope is mandatory because autodiscovery can process
// several repositories in one workflow. Attempt-specific archives exclude reruns.
func createdDependencyPRs(data []byte, repo string) ([]int, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid dependency log archive")
	}
	header := regexp.MustCompile(`^\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL): (.*) \(repository=([^,)]+)(?:, [^)]*)?\)$`)
	field := regexp.MustCompile(`^\S+\s+"pr": ([1-9][0-9]*),?$`)
	level := regexp.MustCompile(`^\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL): `)
	numbers := map[int]bool{}
	finished := false
	remaining := int64(dependencyLogLimit)
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			continue
		}
		if file.UncompressedSize64 > uint64(remaining) {
			return nil, fmt.Errorf("dependency logs too large")
		}
		reader, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("dependency logs unreadable")
		}
		scanner := bufio.NewScanner(io.LimitReader(reader, remaining+1))
		scanner.Buffer(make([]byte, 4096), dependencyLogLimit)
		pending := false
		for scanner.Scan() {
			line := scanner.Text()
			remaining -= int64(len(scanner.Bytes()) + 1)
			if remaining < 0 {
				reader.Close()
				return nil, fmt.Errorf("dependency logs too large")
			}
			if level.MatchString(line) {
				if pending {
					reader.Close()
					return nil, fmt.Errorf("dependency PR creation record incomplete")
				}
				match := header.FindStringSubmatch(line)
				if len(match) == 0 || !strings.EqualFold(match[2], repo) {
					continue
				}
				switch match[1] {
				case "PR created":
					pending = true
				case "Repository finished":
					finished = true
				}
			} else if pending {
				match := field.FindStringSubmatch(line)
				if len(match) > 0 {
					number, err := strconv.Atoi(match[1])
					if err != nil {
						reader.Close()
						return nil, fmt.Errorf("invalid dependency PR number")
					}
					numbers[number] = true
					pending = false
				}
			}
		}
		err = scanner.Err()
		reader.Close()
		if err != nil || pending {
			return nil, fmt.Errorf("dependency logs incomplete")
		}
	}
	if !finished {
		return nil, fmt.Errorf("dependency run result could not be verified from logs")
	}
	result := make([]int, 0, len(numbers))
	for number := range numbers {
		result = append(result, number)
	}
	sort.Ints(result)
	return result, nil
}
