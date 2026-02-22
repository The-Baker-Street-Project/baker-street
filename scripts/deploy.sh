#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# DEPLOY_TELEMETRY can be set externally (e.g., DEPLOY_TELEMETRY=true scripts/deploy.sh)
DEPLOY_TELEMETRY="${DEPLOY_TELEMETRY:-false}"

echo "==> Creating/updating namespace..."
kubectl apply -f "$REPO_ROOT/k8s/namespace.yaml"

echo "==> Creating configmap from operating_system/..."
kubectl create configmap bakerst-os \
  --from-file="$REPO_ROOT/operating_system/" \
  -n bakerst \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> Applying kustomization..."
kubectl apply -k "$REPO_ROOT/k8s/"

echo "==> Waiting for rollout..."
kubectl rollout status deployment/nats -n bakerst --timeout=60s
kubectl rollout status deployment/qdrant -n bakerst --timeout=60s
kubectl rollout status deployment/brain-blue -n bakerst --timeout=60s
kubectl rollout status deployment/worker -n bakerst --timeout=60s
kubectl rollout status deployment/ui -n bakerst --timeout=60s
kubectl rollout status deployment/gateway -n bakerst --timeout=60s

if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  echo "==> Deploying telemetry stack..."
  kubectl apply -k "$REPO_ROOT/k8s/telemetry/"

  echo "==> Waiting for telemetry rollout..."
  kubectl rollout status deployment/otel-collector -n bakerst-telemetry --timeout=60s
  kubectl rollout status deployment/tempo -n bakerst-telemetry --timeout=60s
  kubectl rollout status deployment/loki -n bakerst-telemetry --timeout=60s
  kubectl rollout status deployment/grafana -n bakerst-telemetry --timeout=60s
  kubectl rollout status deployment/prometheus -n bakerst-telemetry --timeout=60s
  kubectl rollout status deployment/kube-state-metrics -n bakerst-telemetry --timeout=60s
fi

echo "==> Pods:"
kubectl get pods -n bakerst
if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  echo "==> Telemetry pods:"
  kubectl get pods -n bakerst-telemetry
fi

echo "==> Done. To access:"
echo "    kubectl port-forward svc/brain 3000:3000 -n bakerst"
echo "    kubectl port-forward svc/ui 8080:8080 -n bakerst"
if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  echo "    http://localhost:30001 (Grafana)"
fi
