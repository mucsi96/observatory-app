package httpapi

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/mucsi96/observatory-app/internal/auth"
	"github.com/mucsi96/observatory-app/internal/dashboard"
)

type failingStore struct{}

func (failingStore) Latest(context.Context, string) (dashboard.Snapshot, error) {
	panic("unauthorized request reached persistence")
}
func (failingStore) Ready(context.Context) error { return errors.New("database unavailable") }

func TestPublicConfigurationAndProtectedAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := NewRouter(failingStore{}, "private-fleet", auth.Environment{TenantID: "tenant", ClientID: "spa", APIClientID: "api"}, nil, "/api")
	for _, tc := range []struct {
		path string
		code int
	}{{"/api/environment", 200}, {"/health/liveness", 404}, {"/health/readiness", 404}, {"/api/apps", 401}} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.code {
			t.Fatalf("%s: got %d want %d", tc.path, w.Code, tc.code)
		}
	}
}

func TestManagementHealthIsSeparate(t *testing.T) {
	r := NewManagementRouter(failingStore{})
	for _, tc := range []struct {
		path   string
		status int
	}{{"/health/liveness", 200}, {"/health/readiness", 503}, {"/api/apps", 404}} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: got %d want %d", tc.path, w.Code, tc.status)
		}
	}
}
