package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/mucsi96/observatory-app/internal/auth"
	"github.com/mucsi96/observatory-app/internal/dashboard"
)

type guardedCache struct{}

func (guardedCache) Latest() (dashboard.Snapshot, bool) {
	panic("unauthorized request reached the snapshot cache")
}

func TestPublicConfigurationAndProtectedAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := NewRouter(guardedCache{}, auth.Environment{TenantID: "tenant", ClientID: "spa", APIClientID: "api"}, nil, "/api")
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
	cache := &dashboard.Cache{}
	r := NewManagementRouter(cache)
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
	// Upstream failures are dashboard signals, not an unhealthy API process.
	cache.Publish(dashboard.Snapshot{UpdatedAt: time.Now(), Apps: []dashboard.Result{{Health: "unknown", Errors: []string{"upstream unavailable"}}}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/health/readiness", nil))
	if w.Code != 200 {
		t.Fatal("first snapshot must make the API ready, including partial results")
	}
}
