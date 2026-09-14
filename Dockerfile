FROM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dashboard .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /dashboard /dashboard
USER 65532:65532
ENV LISTEN_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/dashboard"]
