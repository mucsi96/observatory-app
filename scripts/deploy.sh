#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_KEYVAULT_NAME:?Set the platform Key Vault name}"
: "${SERVER_IMAGE:?Set the immutable server image to deploy}"
: "${CLIENT_IMAGE:?Set the immutable client image to deploy}"
for image in "$SERVER_IMAGE" "$CLIENT_IMAGE"; do
  if [[ ! "$image" =~ (:sha-[a-f0-9]{40}|@sha256:[a-f0-9]{64})$ ]]; then
    printf '%s\n' 'Images must use a full commit SHA tag or sha256 digest.' >&2
    exit 1
  fi
done

root=$(dirname "$(dirname "$(realpath "$0")")")
umask 077
temporary=$(mktemp -d)
KUBECONFIG="$temporary/kubeconfig"
export KUBECONFIG
trap 'rm -rf "$temporary"' EXIT
az keyvault secret show --vault-name "$AZURE_KEYVAULT_NAME" \
  --name k8s-oidc-config --query value --output tsv > "$KUBECONFIG"
kubectl config set-context --current --namespace=observatory >/dev/null

# Terraform owns inventory and upstream credentials. The chart owns runtime
# Secrets and hashes them into the Deployment to roll out configuration changes.
# Keep all secret material in private temporary files, never command arguments.
kubectl get configmap observatory -o json | jq -er '.data["config.json"]' > "$temporary/config.json"
kubectl get secrets observatory-database observatory-github -o json > "$temporary/secrets.json"
jq -en --slurpfile config "$temporary/config.json" --slurpfile secrets "$temporary/secrets.json" \
  --arg image "$SERVER_IMAGE" '{
    image: $image,
    host: ($config[0].apps[] | select(.namespace == "observatory") | .url | ltrimstr("https://")),
    clientId: $config[0].auth.apiClientId,
    configFile: [{name: "config.json", mountPath: "/config/config.json", data: ($config[0] | tojson | @base64)}],
    env: (($secrets[0].items[] | select(.metadata.name == "observatory-database") | .data | with_entries(.value |= @base64d)) + {
      CONFIG_FILE: "/config/config.json",
      GITHUB_TOKEN: ($secrets[0].items[] | select(.metadata.name == "observatory-github") | .data.token | @base64d)
    })
  }' > "$temporary/server-values.json"
jq -en --slurpfile server "$temporary/server-values.json" --arg image "$CLIENT_IMAGE" \
  '{image: $image, host: $server[0].host}' > "$temporary/client-values.json"

helm repo add mucsi96 https://mucsi96.github.io/k8s-helm-charts --force-update
helm repo update mucsi96
# Adopt only the existing Observatory resource names during the first migration.
# Both releases keep immutable image tags; later upgrades use Helm ownership.
helm upgrade observatory mucsi96/go-app --install --version 1.0.0 \
  --namespace observatory --take-ownership --history-max 3 \
  -f "$root/deploy/server-values.yaml" -f "$temporary/server-values.json" \
  --wait --timeout 5m
helm upgrade observatory-client mucsi96/client-app --install --version 22.0.0 \
  --namespace observatory --take-ownership --history-max 3 \
  -f "$root/deploy/client-values.yaml" -f "$temporary/client-values.json" \
  --wait --timeout 5m
