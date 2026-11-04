use observatory::app::App;

#[tokio::main]
async fn main() -> loco_rs::Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install TLS provider");
    loco_rs::cli::main::<App>().await
}
