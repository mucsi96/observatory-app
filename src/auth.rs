use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, ensure};
use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Auth(Arc<Inner>);

struct Inner {
    issuer: String,
    audience: String,
    jwks_url: String,
    client: reqwest::Client,
    keys: Mutex<(Instant, JwkSet)>,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    jwks_uri: String,
}

#[derive(Clone, Deserialize)]
struct Claims {
    #[serde(default)]
    scp: String,
    #[serde(default)]
    roles: Vec<String>,
}

fn endpoint(value: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(value)?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && local),
        "OIDC endpoints require HTTPS (HTTP loopback is allowed for local fixtures)"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
        "invalid OIDC endpoint"
    );
    Ok(url)
}

impl Auth {
    pub async fn new(issuer: String, audience: String) -> anyhow::Result<Self> {
        endpoint(&issuer)?;
        ensure!(!audience.trim().is_empty(), "API_CLIENT_ID is required");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let discovery: Discovery = client
            .get(format!("{issuer}/.well-known/openid-configuration"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("OIDC discovery")?;
        ensure!(discovery.issuer == issuer, "OIDC issuer mismatch");
        endpoint(&discovery.jwks_uri)?;
        let keys = client
            .get(&discovery.jwks_uri)
            .send()
            .await?
            .error_for_status()?
            .json::<JwkSet>()
            .await?;
        Ok(Self(Arc::new(Inner {
            issuer,
            audience,
            jwks_url: discovery.jwks_uri,
            client,
            keys: Mutex::new((Instant::now(), keys)),
        })))
    }

    async fn verify(&self, token: &str) -> Result<(), StatusCode> {
        let header = decode_header(token).map_err(|_| StatusCode::UNAUTHORIZED)?;
        if header.alg != Algorithm::RS256 {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let kid = header.kid.ok_or(StatusCode::UNAUTHORIZED)?;
        let mut cache = self.0.keys.lock().await;
        // Bounded refresh also handles signing-key rotation; unrecognized kids do
        // not cause unbounded outbound requests from unauthenticated clients.
        if cache.0.elapsed() >= Duration::from_secs(300) {
            let result = self
                .0
                .client
                .get(&self.0.jwks_url)
                .send()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
                .error_for_status()
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
                .json::<JwkSet>()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            *cache = (Instant::now(), result);
        }
        let jwk = cache.1.find(&kid).ok_or(StatusCode::UNAUTHORIZED)?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| StatusCode::UNAUTHORIZED)?;
        drop(cache);
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.0.issuer]);
        validation.set_audience(&[&self.0.audience]);
        validation.validate_nbf = true;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| StatusCode::UNAUTHORIZED)?
            .claims;
        if !claims.scp.split_whitespace().any(|s| s == "api-access")
            || !claims.roles.iter().any(|r| r == "readApps")
        {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(())
    }
}

pub async fn authorize(
    State(auth): State<Auth>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    auth.verify(token).await?;
    Ok(next.run(request).await)
}
