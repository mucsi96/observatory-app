FROM docker.io/library/golang:1.27.3-bookworm AS backend
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /observatory .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend /observatory /app/observatory
USER 65532:65532
LABEL org.opencontainers.image.source="https://github.com/mucsi96/observatory-app"
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/app/observatory"]
