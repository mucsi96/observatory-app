#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_KEYVAULT_NAME:?Set the platform Key Vault name}"
: "${DASHBOARD_IMAGE:?Set the immutable image to deploy}"
if [[ ! "$DASHBOARD_IMAGE" =~ (:sha-[a-f0-9]{40}|@sha256:[a-f0-9]{64})$ ]]; then
  printf '%s\n' 'DASHBOARD_IMAGE must use a full commit SHA tag or sha256 digest.' >&2
  exit 1
fi

root=$(dirname "$(dirname "$(realpath "$0")")")
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
az keyvault secret show --vault-name "$AZURE_KEYVAULT_NAME" \
  --name k8s-oidc-config --query value --output tsv > "$KUBECONFIG"
kubectl config set-context --current --namespace=observatory >/dev/null

kubectl apply -f "$root/deploy/service.yaml"
kubectl set image --local -f "$root/deploy/deployment.yaml" \
  "observatory=$DASHBOARD_IMAGE" -o yaml | kubectl apply -f -
# Also reload platform configuration/credentials when deploying the same image.
kubectl rollout restart deployment/observatory
kubectl rollout status deployment/observatory --timeout=300s
