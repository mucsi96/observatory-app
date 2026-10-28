#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_KEYVAULT_NAME:?Set the app Key Vault name}"
: "${SERVER_IMAGE:?Set the numbered server image}"
: "${CLIENT_CSP_FILE:?Set the prepared document CSP file}"
for image in "$SERVER_IMAGE"; do
  [[ "$image" =~ ^ghcr\.io/.+(:[1-9][0-9]*|@sha256:[a-f0-9]{64})$ ]] || { echo 'Images require GHCR numbered tags or digests.' >&2; exit 1; }
done

umask 077
work=$(mktemp -d /dev/shm/observatory-deploy.XXXXXX)
trap 'rm -rf "$work"' EXIT
export KUBECONFIG="$work/kubeconfig"
secret() { az keyvault secret show --vault-name "$AZURE_KEYVAULT_NAME" --name "$1" --query value -o tsv; }
secret k8s-config > "$KUBECONFIG"
kubectl config set-context --current --namespace=observatory >/dev/null
HOSTNAME=$(secret hostname)
API_CLIENT_ID=$(secret api-client-id)
AUTH_CONFIG=$(secret forward-auth-config)
AUTH_RELEASE=$(jq -er '.release_name | select(type == "string" and length > 0)' <<<"$AUTH_CONFIG")
PROXY_AUTH=$(jq -ce '.auth | select(.proxyService | type == "string" and length > 0) | select(.proxyPort | type == "number") | select(.mode == "api-token")' <<<"$AUTH_CONFIG")
CLIENT_RUNTIME_CONFIG=$(secret client-runtime-config | jq -ce 'select(.clientLogUrl | type == "string") | select(.clientAppName | type == "string")')
# A fixed same-origin config gives the exact script bytes Helm's toJson emits.
jq -e --arg url "https://$HOSTNAME/_telemetry/collect" '. == {clientAppName:"observatory-client",clientLogUrl:$url}' <<<"$CLIENT_RUNTIME_CONFIG" >/dev/null
CLIENT_STORAGE_CONFIG=$(secret client-storage-config)
CLIENT_ORIGIN=$(jq -er '.hostname | select(test("^[a-z0-9.-]+\\.web\\.core\\.windows\\.net$"))' <<<"$CLIENT_STORAGE_CONFIG")
kubectl get configmap observatory -o json | jq -er '.data["config.json"]' > "$work/inventory.json"
OIDC_ISSUER=$(jq -er '.auth.issuer' "$work/inventory.json")

helm repo add mucsi96 https://mucsi96.github.io/k8s-helm-charts --force-update
serverChartVersion=6.0.0
clientChartVersion=4.0.0
helm status "$AUTH_RELEASE" --namespace observatory >/dev/null
helm show chart mucsi96/rust-app --version "$serverChartVersion" >/dev/null
helm show chart mucsi96/static-client-app --version "$clientChartVersion" >/dev/null

jq -n --arg image "$SERVER_IMAGE" --arg host "$HOSTNAME" --arg clientId "$API_CLIENT_ID" \
  --arg issuer "$OIDC_ISSUER" --argjson auth "$PROXY_AUTH" --slurpfile inventory "$work/inventory.json" '{
  image:$image,host:$host,basePath:"/api",clientId:$clientId,auth:$auth,
  serviceAccountName:"observatory-api-workload-identity",serviceAccount:{create:true,automountServiceAccountToken:true},
  env:{CONFIG_FILE:"/runtime-config/config.json",GITHUB_TOKEN_FILE:"/credentials/token",OIDC_ISSUER:$issuer,API_CLIENT_ID:$clientId},
  configFile:[{name:"config.json",mountPath:"/runtime-config/config.json",data:($inventory[0] | del(.auth) | tojson | @base64)}],
  extraVolumes:[{name:"github",secret:{secretName:"observatory-github"}}],
  extraVolumeMounts:[{name:"github",mountPath:"/credentials",readOnly:true}],
  resources:{requests:{cpu:"10m",memory:"64Mi"},limits:{cpu:null,memory:"256Mi"}}
}' > "$work/server.json"
# Preserve the existing backend Deployment/Service names while adopting them into Helm.
# Use a distinct config directory: adoption can retain the legacy /config volume
# mount, which conflicts with a subPath file mounted at /config/config.json.
helm upgrade observatory mucsi96/rust-app --install --take-ownership --reset-values \
  --namespace observatory --version "$serverChartVersion" -f "$work/server.json" --wait
helm upgrade observatory-client mucsi96/static-client-app --install --reset-values \
  --namespace observatory --version "$clientChartVersion" \
  --set-string staticOrigin="$CLIENT_ORIGIN" --set-string host="$HOSTNAME" \
  --set-json auth="$PROXY_AUTH" --set-json runtimeConfig="$CLIENT_RUNTIME_CONFIG" \
  --set-file contentSecurityPolicy="$CLIENT_CSP_FILE" --wait
