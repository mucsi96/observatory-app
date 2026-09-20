package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/mucsi96/observatory-app/internal/auth"
	"github.com/mucsi96/observatory-app/internal/dashboard"
	"github.com/mucsi96/observatory-app/internal/database"
)

type Config struct {
	Environment         string           `json:"environment"`
	Apps                []dashboard.App  `json:"apps"`
	Auth                auth.Environment `json:"auth"`
	Database            database.Config  `json:"-"`
	ListenAddress       string           `json:"-"`
	ManagementAddress   string           `json:"-"`
	BasePath            string           `json:"-"`
	GitHubURL           string           `json:"-"`
	GitHubToken         string           `json:"-"`
	KubernetesURL       string           `json:"-"`
	KubernetesTokenFile string           `json:"-"`
	KubernetesCAFile    string           `json:"-"`
	PollInterval        time.Duration    `json:"-"`
}

func Load() (Config, error) {
	var c Config
	data, err := os.ReadFile(env("CONFIG_FILE", "config.json"))
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	c.Auth.ClientAppName = "observatory-client"
	c.Auth.MockOAuth2ServerURI = os.Getenv("MOCK_OAUTH2_SERVER_URI")
	if c.Auth.MockOAuth2ServerURI != "" {
		if os.Getenv("APP_ENV") != "test" {
			return c, fmt.Errorf("mock OIDC is only allowed with APP_ENV=test")
		}
		c.Auth.APIClientID = "mock-api-client-id"
	} else {
		uuid := regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
		if !uuid.MatchString(c.Auth.TenantID) || !uuid.MatchString(c.Auth.ClientID) || !uuid.MatchString(c.Auth.APIClientID) || c.Auth.ClientID == c.Auth.APIClientID {
			return c, fmt.Errorf("Entra tenantId and distinct SPA clientId and apiClientId are required")
		}
	}
	if c.Environment == "" || len(c.Apps) == 0 {
		return c, fmt.Errorf("environment and apps are required")
	}
	slug := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	repo := regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	seen := map[string]bool{}
	for _, app := range c.Apps {
		u, err := url.Parse(app.URL)
		if app.Name == "" || !slug.MatchString(app.Namespace) || seen[app.Namespace] || (app.Repository != "" && !repo.MatchString(app.Repository)) || err != nil || u.Scheme != "https" || u.Host == "" {
			return c, fmt.Errorf("invalid app configuration: %q", app.Name)
		}
		seen[app.Namespace] = true
	}
	c.Database = database.Config{Host: os.Getenv("DB_HOST"), Port: env("DB_PORT", "5432"), Name: os.Getenv("DB_NAME"), Username: os.Getenv("DB_USERNAME"), Password: os.Getenv("DB_PASSWORD"), SSLMode: env("DB_SSLMODE", "disable")}
	if c.Database.Host == "" || c.Database.Name == "" || c.Database.Username == "" || c.Database.Password == "" {
		return c, fmt.Errorf("DB_HOST, DB_NAME, DB_USERNAME and DB_PASSWORD are required")
	}
	serverPort := env("SERVER_PORT", "8080")
	managementPort := env("MANAGEMENT_PORT", "8082")
	for _, port := range []string{serverPort, managementPort} {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return c, fmt.Errorf("SERVER_PORT and MANAGEMENT_PORT must be valid ports")
		}
	}
	if serverPort == managementPort {
		return c, fmt.Errorf("application and management ports must differ")
	}
	c.ListenAddress = ":" + serverPort
	c.ManagementAddress = ":" + managementPort
	c.BasePath = env("BASE_PATH", "/api")
	if !regexp.MustCompile(`^/[a-zA-Z0-9/_-]*$`).MatchString(c.BasePath) {
		return c, fmt.Errorf("BASE_PATH must be an absolute URL path")
	}
	c.GitHubURL = env("GITHUB_API_URL", "https://api.github.com")
	c.GitHubToken = os.Getenv("GITHUB_TOKEN")
	c.KubernetesURL = env("KUBERNETES_API_URL", "https://kubernetes.default.svc")
	c.KubernetesTokenFile = env("KUBERNETES_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token")
	c.KubernetesCAFile = env("KUBERNETES_CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	c.PollInterval, err = time.ParseDuration(env("POLL_INTERVAL", "60s"))
	if err != nil || c.PollInterval < time.Second {
		return c, fmt.Errorf("POLL_INTERVAL must be at least 1s")
	}
	return c, nil
}

func env(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
