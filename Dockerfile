FROM node:26-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.99.1-bookworm AS backend
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src/ ./src/
RUN cargo build --release --locked

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=backend /src/target/release/observatory /app/observatory
COPY --from=frontend /src/frontend/dist /app/static
USER 65532:65532
ENV LISTEN_ADDR=0.0.0.0:8080 STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["/app/observatory"]
