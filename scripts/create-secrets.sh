#!/usr/bin/env bash
# Creates or updates the cams Secrets from an env file. Never prints values.
#   usage: scripts/create-secrets.sh [env-file]   (default: ~/Development/reolink/.env)
# Needs: namespaces cams and cams-runner (created by kube-setup).
set -euo pipefail
ENV_FILE="${1:-$HOME/Development/reolink/.env}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/k3s-config}"
set -a; . "$ENV_FILE"; set +a
: "${GOOGLE_OAUTH_CLIENT_ID:?missing in $ENV_FILE}"
: "${GOOGLE_OAUTH_CLIENT_SECRET:?missing in $ENV_FILE}"
: "${CAMS_GITHUB_PAT:?missing in $ENV_FILE}"
: "${ALLOWED_EMAILS:?missing in $ENV_FILE}"

# Keep an existing COOKIE_SECRET so re-running doesn't sign everyone out.
existing=$(kubectl -n cams get secret cams-oauth -o jsonpath='{.data.COOKIE_SECRET}' 2>/dev/null | base64 -d || true)
COOKIE_SECRET="${existing:-$(openssl rand -hex 32)}"

kubectl -n cams create secret generic cams-oauth \
  --from-literal=GOOGLE_CLIENT_ID="$GOOGLE_OAUTH_CLIENT_ID" \
  --from-literal=GOOGLE_CLIENT_SECRET="$GOOGLE_OAUTH_CLIENT_SECRET" \
  --from-literal=GOOGLE_REDIRECT_URI="https://cams.skylar.technology/auth/google/callback" \
  --from-literal=ALLOWED_EMAILS="$ALLOWED_EMAILS" \
  --from-literal=COOKIE_SECRET="$COOKIE_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cams-runner create secret generic runner-pat \
  --from-literal=token="$CAMS_GITHUB_PAT" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cams describe secret cams-oauth | sed -n '/^Data/,$p'
kubectl -n cams-runner describe secret runner-pat | sed -n '/^Data/,$p'
