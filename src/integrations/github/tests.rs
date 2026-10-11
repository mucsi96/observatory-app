use std::{convert::Infallible, sync::Arc};

use http_body_util::Full;
use hyper::{Request, Response, body::Bytes, service::service_fn};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, path},
};

use super::GitHub;

#[tokio::test]
async fn signed_https_log_download_does_not_forward_github_credentials() {
    let certificate = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let cert_der = certificate.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        certificate.signing_key.serialize_der(),
    ));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der.clone()], key)
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let storage = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let stream = TlsAcceptor::from(Arc::new(tls))
            .accept(stream)
            .await
            .unwrap();
        hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .serve_connection(
                TokioIo::new(stream),
                service_fn(|request: Request<hyper::body::Incoming>| async move {
                    assert!(!request.headers().contains_key("authorization"));
                    assert_eq!(request.uri().query(), Some("signed=private"));
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"archive"))))
                }),
            )
            .await
            .unwrap();
    });
    let api = MockServer::start().await;
    Mock::given(path("/logs"))
        .and(header("Authorization", "Bearer private-token"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("Location", format!("https://{address}/logs?signed=private")),
        )
        .expect(1)
        .mount(&api)
        .await;
    let mut github = GitHub::with_base_url(&api.uri(), "private-token".into()).unwrap();
    github.client = reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_der(cert_der.as_ref()).unwrap())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    assert_eq!(github.dependency_logs("/logs").await.unwrap(), b"archive");
    storage.await.unwrap();
}
