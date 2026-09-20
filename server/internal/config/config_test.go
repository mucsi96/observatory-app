package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProductionRejectsMissingOrMockAuthentication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"environment":"test","apps":[{"name":"Test","namespace":"test","url":"https://example.com"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONFIG_FILE", path)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("MOCK_OAUTH2_SERVER_URI", "")
	if _, err := Load(); err == nil {
		t.Fatal("production without Entra config accepted")
	}
	t.Setenv("MOCK_OAUTH2_SERVER_URI", "http://localhost:8070")
	if _, err := Load(); err == nil {
		t.Fatal("production accepted mock OIDC")
	}
}
