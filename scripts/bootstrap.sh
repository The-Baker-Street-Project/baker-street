#!/usr/bin/env bash
set -euo pipefail

# Baker Street Bootstrap — installs the SysAdmin pod that orchestrates everything else.
# Prerequisites: kubectl, docker, Kubernetes cluster reachable

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="bakerst"
SYSADMIN_IMAGE="${SYSADMIN_IMAGE:-ghcr.io/the-baker-street-project/bakerst-sysadmin:latest}"
NODEPORT=30090

echo "=== Baker Street Bootstrap ==="
echo ""

# Check prerequisites
for cmd in kubectl docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not found."
    exit 1
  fi
done

if ! kubectl cluster-info &>/dev/null; then
  echo "Error: Cannot connect to Kubernetes cluster."
  echo "Make sure kubectl is configured and the cluster is running."
  exit 1
fi

echo "[1/5] Creating namespace..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

echo "[2/5] Applying SysAdmin RBAC..."
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/rbac.yaml"

echo "[3/5] Pulling SysAdmin image..."
docker pull "$SYSADMIN_IMAGE" 2>/dev/null || echo "  (Using local image)"

echo "[4/5] Deploying SysAdmin..."
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/deployment.yaml"
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/service.yaml"
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/network-policy.yaml"

echo "[5/5] Waiting for rollout..."
kubectl rollout status deployment/sysadmin -n "$NAMESPACE" --timeout=120s

echo ""
echo "=== Baker Street SysAdmin is ready! ==="
echo ""
echo "  Open: http://localhost:${NODEPORT}"
echo ""
echo "The SysAdmin will guide you through deploying Baker Street."
