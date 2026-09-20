package httpapi

import (
	"net/http"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"github.com/mucsi96/observatory-app/internal/auth"
	"github.com/mucsi96/observatory-app/internal/dashboard"
)

type SnapshotReader interface {
	Latest() (dashboard.Snapshot, bool)
}

func NewRouter(cache SnapshotReader, public auth.Environment, verifier *oidc.IDTokenVerifier, basePath string) *gin.Engine {
	r := gin.New()
	r.SetTrustedProxies(nil)
	r.Use(gin.Recovery(), func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Cache-Control", "no-store")
		c.Next()
	})
	root := r.Group(basePath)
	root.GET("/environment", func(c *gin.Context) { c.JSON(http.StatusOK, public) })
	api := root.Group("", auth.RequireAccess(verifier))
	api.GET("/apps", func(c *gin.Context) {
		snapshot, ready := cache.Latest()
		if !ready {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Initial collection in progress"})
			return
		}
		c.JSON(http.StatusOK, snapshot)
	})
	return r
}

// The go-app chart probes a separate management port. No management endpoint is
// served by the publicly routed application listener.
func NewManagementRouter(cache SnapshotReader) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/health/liveness", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "UP"}) })
	r.GET("/health/readiness", func(c *gin.Context) {
		if _, ready := cache.Latest(); !ready {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "DOWN"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "UP"})
	})
	return r
}
