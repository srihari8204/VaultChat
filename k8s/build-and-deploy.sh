#!/usr/bin/env bash
# Build the API images with Docker, hand them to k3s, run migrations, roll out.
#
# Run this ON the node, from the repo root:
#   ./k8s/build-and-deploy.sh
#
# Why the docker save | ctr import dance: k3s runs containerd, NOT Docker. An
# image sitting in Docker's local store is invisible to k3s, and the pod fails
# with ErrImagePull even though `docker images` clearly lists it. Importing
# puts it in containerd's store, where the kubelet looks. (The alternative —
# push to a registry and pull — is in k8s/README.md under "Multi-node".)
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Tag every deploy with the commit + timestamp. An immutable tag per build is
# what makes `kubectl rollout undo` mean something: with :latest, rolling back
# re-pulls the same bytes you are trying to roll back from.
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date -u +%Y%m%d%H%M)"
echo "==> Building tag: ${TAG}"

echo "==> [1/5] docker build go-api"
docker build -t "vaultchat/go-api:${TAG}" "${REPO_ROOT}/vaultchat-backend-go"

echo "==> [2/5] docker build node-migrate (migration runner)"
docker build -t "vaultchat/node-migrate:${TAG}" "${REPO_ROOT}/vaultchat-backend"

echo "==> [3/5] import both images into k3s containerd"
docker save "vaultchat/go-api:${TAG}"       | sudo k3s ctr images import -
docker save "vaultchat/node-migrate:${TAG}" | sudo k3s ctr images import -

echo "==> [4/5] run schema migrations (idempotent)"
kubectl -n vaultchat delete job vaultchat-migrate --ignore-not-found
sed "s|REPLACE_TAG|${TAG}|g" "${REPO_ROOT}/k8s/20-migrate-job.yaml" | kubectl apply -f -
# Block until the migration finishes. If it fails, STOP — rolling out an API
# that expects a schema the database does not have is the worst of both.
if ! kubectl -n vaultchat wait --for=condition=complete job/vaultchat-migrate --timeout=300s; then
  echo "!! migration job did not complete — API NOT rolled out" >&2
  kubectl -n vaultchat logs job/vaultchat-migrate --tail=50 >&2 || true
  exit 1
fi
kubectl -n vaultchat logs job/vaultchat-migrate --tail=20

echo "==> [5/5] roll out go-api"
sed "s|REPLACE_TAG|${TAG}|g" "${REPO_ROOT}/k8s/30-api.yaml" | kubectl apply -f -
kubectl -n vaultchat rollout status deploy/go-api --timeout=180s

echo "==> deployed ${TAG}"
kubectl -n vaultchat get pods -o wide
