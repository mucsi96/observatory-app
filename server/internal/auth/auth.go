package auth

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
)

type Environment struct {
	TenantID            string `json:"tenantId"`
	ClientID            string `json:"clientId"`
	APIClientID         string `json:"apiClientId"`
	MockOAuth2ServerURI string `json:"mockOAuth2ServerUri"`
	ClientLogURL        string `json:"clientLogUrl"`
	ClientAppName       string `json:"clientAppName"`
}

func NewVerifier(ctx context.Context, e Environment) *oidc.IDTokenVerifier {
	ctx = oidc.ClientContext(ctx, &http.Client{Timeout: 10 * time.Second})
	if e.MockOAuth2ServerURI != "" {
		issuer := e.MockOAuth2ServerURI + "/default"
		return oidc.NewVerifier(issuer, oidc.NewRemoteKeySet(ctx, issuer+"/jwks"), &oidc.Config{ClientID: e.APIClientID, SupportedSigningAlgs: []string{oidc.RS256}})
	}
	issuer := "https://login.microsoftonline.com/" + e.TenantID + "/v2.0"
	keys := oidc.NewRemoteKeySet(ctx, "https://login.microsoftonline.com/"+e.TenantID+"/discovery/v2.0/keys")
	return oidc.NewVerifier(issuer, keys, &oidc.Config{ClientID: e.APIClientID, SupportedSigningAlgs: []string{oidc.RS256}})
}

func RequireAccess(verifier *oidc.IDTokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		authorization := strings.Fields(c.GetHeader("Authorization"))
		if verifier == nil || len(authorization) != 2 || !strings.EqualFold(authorization[0], "Bearer") || len(authorization[1]) > 32768 {
			unauthorized(c)
			return
		}
		token, err := verifier.Verify(c.Request.Context(), authorization[1])
		if err != nil {
			unauthorized(c)
			return
		}
		var claims struct {
			Scope     string   `json:"scp"`
			Roles     []string `json:"roles"`
			NotBefore int64    `json:"nbf"`
		}
		if err := token.Claims(&claims); err != nil || claims.NotBefore > time.Now().Unix() {
			unauthorized(c)
			return
		}
		if !slices.Contains(strings.Fields(claims.Scope), "api-access") || !slices.Contains(claims.Roles, "readApps") {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "The readApps role and api-access scope are required"})
			return
		}
		c.Next()
	}
}

func unauthorized(c *gin.Context) {
	c.Header("WWW-Authenticate", `Bearer realm="observatory"`)
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
}
