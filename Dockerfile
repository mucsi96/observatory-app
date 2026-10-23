FROM rust:1.99.0-bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src/ ./src/
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=backend /src/target/release/observatory /app/observatory
USER 65532:65532
LABEL org.opencontainers.image.source="https://github.com/mucsi96/observatory-app"
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/app/observatory"]
