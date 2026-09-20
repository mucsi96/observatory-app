#!/usr/bin/env bash
set -euo pipefail
ROOT=$(dirname "$(dirname "$(realpath "$0")")")
if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  podman build -t localhost/observatory-app-server:test "$ROOT/server" & server=$!
  podman build -t localhost/observatory-app-client:test "$ROOT/client" & client=$!
  podman build -t localhost/observatory-app-mock-upstream:test "$ROOT/mock_upstream_server" & mock=$!
  wait "$server"
  wait "$client"
  wait "$mock"
fi
bash "$ROOT/scripts/pod_down.sh"
podman kube play "$ROOT/test/test-pod.yaml"
for container in observatory-app-test-traefik observatory-app-test-db observatory-app-test-mock-upstream observatory-app-test-mock-oauth2 observatory-app-test-server observatory-app-test-client; do
  ready=false
  for ((attempt=0; attempt<60; attempt++)); do
    if timeout 5s podman healthcheck run "$container" >/dev/null 2>&1; then ready=true; break; fi
    if [[ "$(podman inspect "$container" --format '{{.State.Status}}')" == exited ]]; then break; fi
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    podman logs "$container"
    printf 'Container failed readiness: %s\n' "$container" >&2
    exit 1
  fi
done
printf 'Observatory test pod ready at http://localhost:8170\n'
