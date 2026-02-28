#!/usr/bin/env bash
set -euo pipefail

# Baker Street Bootstrap — installs the SysAdmin pod that orchestrates everything else.
#
# Usage:
#   scripts/bootstrap.sh                    # uses GHCR latest image
#   scripts/bootstrap.sh --local            # uses locally built image (imagePullPolicy: Never)
#   SYSADMIN_IMAGE=ghcr.io/.../bakerst-sysadmin:1.0.0 scripts/bootstrap.sh  # custom image
#
# Prerequisites: kubectl, Kubernetes cluster reachable

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="bakerst"
SYSADMIN_IMAGE="${SYSADMIN_IMAGE:-ghcr.io/the-baker-street-project/bakerst-sysadmin:latest}"
NODEPORT=30090
LOCAL_MODE=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL_MODE=true; shift ;;
    --help|-h)
      echo "Usage: scripts/bootstrap.sh [--local]"
      echo "  --local  Use locally built image (bakerst-sysadmin:latest, imagePullPolicy: Never)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$LOCAL_MODE" == true ]]; then
  SYSADMIN_IMAGE="bakerst-sysadmin:latest"
  echo "=== Baker Street Bootstrap (local mode) ==="
else
  echo "=== Baker Street Bootstrap ==="
fi
echo ""

# Check prerequisites
for cmd in kubectl; do
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
if [[ "$LOCAL_MODE" == true ]]; then
  echo "  (Using local image: $SYSADMIN_IMAGE)"
else
  docker pull "$SYSADMIN_IMAGE" 2>/dev/null || echo "  (Pull failed, proceeding anyway)"
fi

echo "[4/5] Deploying SysAdmin..."
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/deployment.yaml"
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/service.yaml"
kubectl apply -f "$REPO_ROOT/k8s/sysadmin/network-policy.yaml"

# Patch the image and pull policy based on mode
if [[ "$LOCAL_MODE" == true ]]; then
  kubectl set image deployment/sysadmin sysadmin="$SYSADMIN_IMAGE" -n "$NAMESPACE"
  kubectl patch deployment/sysadmin -n "$NAMESPACE" \
    -p '{"spec":{"template":{"spec":{"containers":[{"name":"sysadmin","imagePullPolicy":"Never"}]}}}}'
else
  kubectl set image deployment/sysadmin sysadmin="$SYSADMIN_IMAGE" -n "$NAMESPACE"
  kubectl patch deployment/sysadmin -n "$NAMESPACE" \
    -p '{"spec":{"template":{"spec":{"containers":[{"name":"sysadmin","imagePullPolicy":"IfNotPresent"}]}}}}'
fi

echo "[5/5] Waiting for rollout..."
kubectl rollout status deployment/sysadmin -n "$NAMESPACE" --timeout=120s

echo ""
echo "=== Baker Street SysAdmin is ready! ==="
echo ""
echo "  Image:    $SYSADMIN_IMAGE"
echo "  Terminal: http://localhost:${NODEPORT}"
echo ""
echo "The SysAdmin will guide you through deploying Baker Street."
