package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
)

const testIssuer = "https://login.microsoftonline.com/test-tenant/v2.0"

func authFixture(t *testing.T) (*oidc.IDTokenVerifier, func(map[string]any) string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "kid": "test-key", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	t.Cleanup(server.Close)
	verifier := oidc.NewVerifier(testIssuer, oidc.NewRemoteKeySet(context.Background(), server.URL), &oidc.Config{ClientID: "api-client", SupportedSigningAlgs: []string{oidc.RS256}})
	sign := func(overrides map[string]any) string {
		claims := map[string]any{
			"iss": testIssuer, "aud": "api-client", "sub": "user",
			"exp": time.Now().Add(time.Hour).Unix(), "nbf": time.Now().Add(-time.Minute).Unix(),
			"scp": "api-access", "roles": []string{"readApps"},
		}
		for k, v := range overrides {
			claims[k] = v
		}
		payload, err := json.Marshal(claims)
		if err != nil {
			t.Fatal(err)
		}
		input := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test-key"}`)) + "." + base64.RawURLEncoding.EncodeToString(payload)
		hash := sha256.Sum256([]byte(input))
		signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if err != nil {
			t.Fatal(err)
		}
		return input + "." + base64.RawURLEncoding.EncodeToString(signature)
	}
	return verifier, sign
}

func TestBearerAccessControl(t *testing.T) {
	verifier, sign := authFixture(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/apps", RequireAccess(verifier), func(c *gin.Context) { c.JSON(200, gin.H{"environment": "private-fleet"}) })
	for _, tc := range []struct {
		name   string
		token  string
		status int
	}{
		{"missing token", "", 401},
		{"malformed token", "not-a-jwt", 401},
		{"unsigned token", "eyJhbGciOiJub25lIn0.e30.", 401},
		{"wrong signature", sign(nil) + "x", 401},
		{"wrong tenant", sign(map[string]any{"iss": "https://login.microsoftonline.com/other-tenant/v2.0"}), 401},
		{"wrong audience", sign(map[string]any{"aud": "another-api"}), 401},
		{"SPA ID token audience", sign(map[string]any{"aud": "spa-client"}), 401},
		{"expired", sign(map[string]any{"exp": time.Now().Add(-time.Hour).Unix()}), 401},
		{"missing expiry", sign(map[string]any{"exp": nil}), 401},
		{"not yet valid", sign(map[string]any{"nbf": time.Now().Add(time.Hour).Unix()}), 401},
		{"missing scope", sign(map[string]any{"scp": ""}), 403},
		{"scope substring", sign(map[string]any{"scp": "not-api-access"}), 403},
		{"missing role", sign(map[string]any{"roles": []string{}}), 403},
		{"wrong role", sign(map[string]any{"roles": []string{"readGreetings"}}), 403},
		{"valid delegated access", sign(nil), 200},
		{"multiple scopes and roles", sign(map[string]any{"scp": "other api-access", "roles": []string{"other", "readApps"}}), 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/apps", nil)
			if tc.token != "" {
				r.Header.Set("Authorization", "Bearer "+tc.token)
			}
			// Proxy identity headers must not grant access.
			r.Header.Set("X-Forwarded-User", "admin")
			r.Header.Set("X-Auth-Request-Email", "admin@example.com")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if tc.status != 200 && strings.Contains(w.Body.String(), "private-fleet") {
				t.Fatal("unauthorized fleet disclosure")
			}
			if tc.status == 401 && w.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("missing bearer challenge")
			}
		})
	}
}
