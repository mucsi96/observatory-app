package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Auth struct {
	issuer, audience, jwksURL string
	client                    *http.Client
	mu                        sync.Mutex
	loaded                    time.Time
	keys                      map[string]*rsa.PublicKey
}

func oidcEndpoint(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))
}

func newAuth(ctx context.Context, issuer, audience string) (*Auth, error) {
	if !oidcEndpoint(issuer) || strings.TrimSpace(audience) == "" {
		return nil, fmt.Errorf("OIDC_ISSUER and API_CLIENT_ID are required")
	}
	client, err := upstreamClient("")
	if err != nil {
		return nil, err
	}
	var discovery struct {
		Issuer  string
		JWKSURI string `json:"jwks_uri"`
	}
	if err := getJSON(ctx, client, issuer+"/.well-known/openid-configuration", "", &discovery); err != nil {
		return nil, fmt.Errorf("OIDC discovery: %w", err)
	}
	if discovery.Issuer != issuer || !oidcEndpoint(discovery.JWKSURI) {
		return nil, fmt.Errorf("invalid OIDC discovery")
	}
	a := &Auth{issuer: issuer, audience: audience, jwksURL: discovery.JWKSURI, client: client}
	if err := a.loadKeys(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Auth) loadKeys(ctx context.Context) error {
	var jwks struct {
		Keys []struct{ Kty, Kid, N, E, Alg, Use string }
	}
	if err := getJSON(ctx, a.client, a.jwksURL, "", &jwks); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, key := range jwks.Keys {
		if key.Kty != "RSA" || key.Kid == "" || (key.Alg != "" && key.Alg != "RS256") || (key.Use != "" && key.Use != "sig") {
			continue
		}
		n, err := base64.RawURLEncoding.DecodeString(key.N)
		if err != nil {
			continue
		}
		e, err := base64.RawURLEncoding.DecodeString(key.E)
		if err != nil || len(e) > 4 {
			continue
		}
		exponent := new(big.Int).SetBytes(e).Int64()
		if len(n) < 256 || exponent < 3 || exponent > 2147483647 {
			continue
		}
		keys[key.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent)}
	}
	if len(keys) == 0 {
		return fmt.Errorf("OIDC signing keys unavailable")
	}
	a.keys, a.loaded = keys, time.Now()
	return nil
}

func (a *Auth) verify(ctx context.Context, token string, issue bool) int {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 32768 {
		return 401
	}
	decode := func(part string, value any) bool {
		data, err := base64.RawURLEncoding.DecodeString(part)
		return err == nil && json.Unmarshal(data, value) == nil
	}
	var header struct{ Alg, Kid string }
	if !decode(parts[0], &header) || header.Alg != "RS256" || header.Kid == "" {
		return 401
	}
	a.mu.Lock()
	if time.Since(a.loaded) >= 5*time.Minute {
		if err := a.loadKeys(ctx); err != nil {
			a.mu.Unlock()
			return 503
		}
	}
	key := a.keys[header.Kid]
	a.mu.Unlock()
	if key == nil {
		return 401
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return 401
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) != nil {
		return 401
	}
	var claims struct {
		Iss   string
		Aud   json.RawMessage
		Exp   *int64
		Nbf   *int64
		Scp   string
		Roles []string
	}
	if !decode(parts[1], &claims) || claims.Iss != a.issuer || claims.Exp == nil {
		return 401
	}
	now := time.Now().Unix()
	if *claims.Exp < now-60 || (claims.Nbf != nil && *claims.Nbf > now+60) {
		return 401
	}
	var audience string
	var audiences []string
	if json.Unmarshal(claims.Aud, &audience) == nil {
		audiences = []string{audience}
	} else if json.Unmarshal(claims.Aud, &audiences) != nil {
		return 401
	}
	contains := func(values []string, value string) bool {
		for _, candidate := range values {
			if candidate == value {
				return true
			}
		}
		return false
	}
	if !contains(audiences, a.audience) {
		return 401
	}
	if !contains(strings.Fields(claims.Scp), "api-access") || !contains(claims.Roles, "readApps") || (issue && !contains(claims.Roles, "createIssues")) {
		return 403
	}
	return 0
}

func (d *Dashboard) authorize(issue bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		value := r.Header.Get("Authorization")
		if d.auth == nil || !strings.HasPrefix(value, "Bearer ") {
			jsonError(w, 401, "Unauthorized")
			return
		}
		if status := d.auth.verify(r.Context(), strings.TrimPrefix(value, "Bearer "), issue); status != 0 {
			jsonError(w, status, http.StatusText(status))
			return
		}
		next.ServeHTTP(w, r)
	})
}
