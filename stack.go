package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
)

type packageStack struct {
	Frontend    []string
	NodeBackend bool
}

func applicationFile(file string) bool {
	for _, part := range strings.Split(file, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
		switch part {
		case "node_modules", "vendor", "target", "dist", "build", "test", "tests", "e2e", "fixtures", "example", "examples", "docs", "scripts", "tools":
			return false
		}
	}
	return true
}

func backendFile(file string) bool {
	dirs := strings.Split(path.Dir(file), "/")
	backend := path.Dir(file) == "."
	for _, dir := range dirs {
		switch dir {
		case "frontend", "client", "web", "ui":
			return false
		case "backend", "server", "api", "service", "services":
			backend = true
		}
	}
	return backend
}

func (d *Dashboard) technology(ctx context.Context, repo string, result *TechnologyStack) error {
	if d.githubToken == "" {
		return fmt.Errorf("GITHUB_TOKEN is not configured")
	}
	var tree struct {
		Tree      []struct{ Path, Type, SHA string }
		Truncated bool
	}
	if err := getJSON(ctx, d.github, d.githubURL+"/repos/"+repo+"/git/trees/HEAD?recursive=1", d.githubToken, &tree); err != nil {
		return err
	}
	if tree.Truncated {
		return fmt.Errorf("GitHub repository tree incomplete")
	}
	frontend, backend := map[string]bool{}, map[string]bool{}
	detectFrontend, detectBackend := result.Frontend == nil, result.Backend == nil
	publish := func() {
		label := func(values map[string]bool) *string {
			labels := []string{}
			for value := range values {
				labels = append(labels, value)
			}
			if len(labels) == 0 {
				return nil
			}
			sort.Strings(labels)
			joined := strings.Join(labels, " + ")
			return &joined
		}
		if detectFrontend {
			result.Frontend = label(frontend)
		}
		if detectBackend {
			result.Backend = label(backend)
		}
	}
	packages := []struct{ Path, SHA string }{}
	for _, file := range tree.Tree {
		if file.Type != "blob" || !applicationFile(file.Path) {
			continue
		}
		name := path.Base(file.Path)
		if detectFrontend && name == "angular.json" {
			frontend["Angular"] = true
		}
		if name == "package.json" && (detectFrontend || (detectBackend && backendFile(file.Path))) {
			packages = append(packages, struct{ Path, SHA string }{file.Path, file.SHA})
		}
		if !detectBackend || !backendFile(file.Path) {
			continue
		}
		switch name {
		case "Cargo.toml":
			backend["Rust"] = true
		case "go.mod":
			backend["Go"] = true
		case "pyproject.toml", "requirements.txt", "Pipfile":
			backend["Python"] = true
		case "Gemfile":
			backend["Ruby"] = true
		case "composer.json":
			backend["PHP"] = true
		case "pom.xml", "build.gradle", "build.gradle.kts":
			language := "Java"
			for _, entry := range tree.Tree {
				if entry.Type == "blob" && applicationFile(entry.Path) && strings.HasPrefix(entry.Path, strings.TrimSuffix(file.Path, name)) && strings.HasSuffix(entry.Path, ".kt") {
					language = "Kotlin"
				}
			}
			backend[language] = true
		default:
			if strings.HasSuffix(name, ".csproj") {
				backend["C#"] = true
			}
			if strings.HasSuffix(name, ".fsproj") {
				backend["F#"] = true
			}
		}
	}
	publish()
	if len(packages) > 12 {
		return fmt.Errorf("too many package manifests")
	}
	var failure error
	for _, file := range packages {
		pkg, err := d.packageTechnology(ctx, repo, file.SHA)
		if err != nil {
			failure = err
			continue
		}
		if detectFrontend {
			for _, label := range pkg.Frontend {
				frontend[label] = true
			}
		}
		if detectBackend && backendFile(file.Path) && pkg.NodeBackend {
			backend["Node.js"] = true
		}
		publish()
	}
	return failure
}

var blobSHA = regexp.MustCompile(`^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$`)

func (d *Dashboard) packageTechnology(ctx context.Context, repo, sha string) (packageStack, error) {
	if !blobSHA.MatchString(sha) {
		return packageStack{}, fmt.Errorf("invalid blob identity")
	}
	// Serialize cache fills so repeated repositories share immutable blob reads.
	d.stackMu.Lock()
	defer d.stackMu.Unlock()
	key := repo + "/" + sha
	if cached, ok := d.stackCache[key]; ok {
		return cached, nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", d.githubURL+"/repos/"+repo+"/git/blobs/"+sha, nil)
	if err != nil {
		return packageStack{}, fmt.Errorf("invalid manifest request")
	}
	req.Header.Set("Authorization", "Bearer "+d.githubToken)
	req.Header.Set("Accept", "application/vnd.github.raw+json")
	req.Header.Set("User-Agent", "observatory")
	resp, err := d.github.Do(req)
	if err != nil {
		return packageStack{}, fmt.Errorf("manifest unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return packageStack{}, fmt.Errorf("upstream HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (256<<10)+1))
	if err != nil || len(data) > 256<<10 {
		return packageStack{}, fmt.Errorf("upstream response too large or incomplete")
	}
	var pkg struct {
		Dependencies    map[string]json.RawMessage
		DevDependencies map[string]json.RawMessage `json:"devDependencies"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return packageStack{}, fmt.Errorf("upstream response invalid")
	}
	result := packageStack{}
	for dependency, label := range map[string]string{"@angular/core": "Angular", "react": "React", "vue": "Vue", "svelte": "Svelte", "solid-js": "Solid", "@solidjs/router": "Solid", "preact": "Preact"} {
		if pkg.Dependencies[dependency] != nil || pkg.DevDependencies[dependency] != nil {
			result.Frontend = append(result.Frontend, label)
		}
	}
	for _, dependency := range []string{"express", "fastify", "koa", "@nestjs/core", "hono"} {
		if pkg.Dependencies[dependency] != nil {
			result.NodeBackend = true
		}
	}
	if d.stackCache == nil {
		d.stackCache = map[string]packageStack{}
	}
	if len(d.stackCache) >= 512 {
		for existing := range d.stackCache {
			delete(d.stackCache, existing)
			break
		}
	}
	d.stackCache[key] = result
	return result, nil
}
