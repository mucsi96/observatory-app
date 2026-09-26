FROM docker.io/library/golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server ./cmd/server

FROM docker.io/library/alpine:3.23
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /server /server
USER 65532:65532
ENV SERVER_PORT=8080 MANAGEMENT_PORT=8082 BASE_PATH=/api
EXPOSE 8080 8082
ENTRYPOINT ["/server"]
