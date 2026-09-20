package dashboard

import "time"

type App struct {
	Name               string `json:"name"`
	Namespace          string `json:"namespace"`
	Repository         string `json:"repository"`
	URL                string `json:"url"`
	DeploymentWorkflow string `json:"deploymentWorkflow,omitempty"`
}

type Workload struct {
	Name    string   `json:"name"`
	Images  []string `json:"images"`
	Ready   int      `json:"ready"`
	Desired int      `json:"desired"`
	Status  string   `json:"status"`
}

type Result struct {
	App
	Health         string          `json:"health"`
	Workloads      []Workload      `json:"workloads"`
	RepositoryData *RepositoryData `json:"repositoryData"`
	Errors         []string        `json:"errors"`
}

type Snapshot struct {
	Environment string    `json:"environment"`
	UpdatedAt   time.Time `json:"updatedAt"`
	Apps        []Result  `json:"apps"`
}
