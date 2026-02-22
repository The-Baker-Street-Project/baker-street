#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# upgrade.sh — Zero-downtime blue-green brain upgrade orchestrator
#
# Usage:
#   scripts/upgrade.sh [--version <version>]
#
# If --version is not provided, defaults to the current git short hash.
###############################################################################

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="bakerst"
SERVICE_NAME="brain"
BRAIN_PORT=3000
ROLLOUT_TIMEOUT="120s"
HEALTH_TIMEOUT=60   # seconds to wait for /brain/state to report active
HEALTH_INTERVAL=3   # seconds between health polls

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--version <version>]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi

# Sanitize version: allow only alphanumeric, dash, dot, underscore
if [[ ! "$VERSION" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "ERROR: Invalid version string: $VERSION" >&2
  echo "Version must contain only alphanumeric characters, dashes, dots, and underscores." >&2
  exit 1
fi

echo "==> Upgrade version: $VERSION"

# ---------------------------------------------------------------------------
# Determine current active slot from Service selector
# ---------------------------------------------------------------------------
CURRENT_SLOT=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.selector.slot}')

if [[ -z "$CURRENT_SLOT" ]]; then
  echo "ERROR: Service '$SERVICE_NAME' has no 'slot' selector. Is blue-green configured?" >&2
  exit 1
fi

if [[ "$CURRENT_SLOT" == "blue" ]]; then
  NEW_SLOT="green"
else
  NEW_SLOT="blue"
fi

echo "==> Current active slot: $CURRENT_SLOT"
echo "==> New slot: $NEW_SLOT"

# ---------------------------------------------------------------------------
# Rollback helper — called on failure
# ---------------------------------------------------------------------------
rollback() {
  echo ""
  echo "!!! UPGRADE FAILED — rolling back !!!"
  echo "==> Scaling $NEW_SLOT back to 0..."
  kubectl scale deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" --replicas=0 2>/dev/null || true
  echo "==> Rollback complete. Active slot remains: $CURRENT_SLOT"
  exit 1
}

trap rollback ERR

# ---------------------------------------------------------------------------
# Step 1: Build new brain image
# ---------------------------------------------------------------------------
echo ""
echo "==> Building brain image with version $VERSION..."
docker build \
  -t "bakerst-brain:latest" \
  -t "bakerst-brain:${VERSION}" \
  --build-arg BRAIN_VERSION="$VERSION" \
  -f "$REPO_ROOT/services/brain/Dockerfile" \
  "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Step 2: Update inactive slot — image, BRAIN_ROLE, BRAIN_VERSION
# ---------------------------------------------------------------------------
echo ""
echo "==> Configuring brain-${NEW_SLOT} deployment..."

# Update the brain container's image (forces pod replacement)
kubectl set image deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
  brain="bakerst-brain:${VERSION}"

# Patch env vars: BRAIN_ROLE=pending, BRAIN_VERSION=<version>
# We use a strategic merge patch on the deployment spec
kubectl patch deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" --type='json' -p="[
  {\"op\": \"replace\", \"path\": \"/spec/template/metadata/labels/version\", \"value\": \"${VERSION}\"},
  {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/env\", \"value\": $(
    kubectl get deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].env}' | \
    python3 -c "
import json, sys
envs = json.load(sys.stdin)
for e in envs:
    if e['name'] == 'BRAIN_ROLE':
        e['value'] = 'pending'
    elif e['name'] == 'BRAIN_VERSION':
        e['value'] = '${VERSION}'
print(json.dumps(envs))
"
  )}
]" 2>/dev/null || {
  # If the version label doesn't exist yet, use add instead of replace
  kubectl patch deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" --type='json' -p="[
    {\"op\": \"add\", \"path\": \"/spec/template/metadata/labels/version\", \"value\": \"${VERSION}\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/env\", \"value\": $(
      kubectl get deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
        -o jsonpath='{.spec.template.spec.containers[0].env}' | \
      python3 -c "
import json, sys
envs = json.load(sys.stdin)
for e in envs:
    if e['name'] == 'BRAIN_ROLE':
        e['value'] = 'pending'
    elif e['name'] == 'BRAIN_VERSION':
        e['value'] = '${VERSION}'
print(json.dumps(envs))
"
    )}
  ]"
}

# ---------------------------------------------------------------------------
# Step 3: Scale up the new slot
# ---------------------------------------------------------------------------
echo ""
echo "==> Scaling brain-${NEW_SLOT} to 1 replica..."
kubectl scale deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" --replicas=1

# ---------------------------------------------------------------------------
# Step 4: Wait for rollout
# ---------------------------------------------------------------------------
echo "==> Waiting for brain-${NEW_SLOT} rollout..."
kubectl rollout status deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
  --timeout="$ROLLOUT_TIMEOUT"

# ---------------------------------------------------------------------------
# Step 5: Poll /brain/state until active (or timeout)
# ---------------------------------------------------------------------------
echo ""
echo "==> Polling brain-${NEW_SLOT} health..."

# Use port-forward to reach the pod (more reliable than pod IP from host)
# Start port-forward in background
LOCAL_PORT=$((BRAIN_PORT + 1 + RANDOM % 1000))
kubectl port-forward -n "$NAMESPACE" \
  "deployment/brain-${NEW_SLOT}" "${LOCAL_PORT}:${BRAIN_PORT}" &
PF_PID=$!

# Ensure port-forward is cleaned up
cleanup_pf() {
  kill "$PF_PID" 2>/dev/null || true
  wait "$PF_PID" 2>/dev/null || true
}
trap 'cleanup_pf; rollback' ERR

# Wait for port-forward to establish
sleep 3

ELAPSED=0
HEALTHY=false
while [[ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]]; do
  RESPONSE=$(curl -sf "http://localhost:${LOCAL_PORT}/brain/state" 2>/dev/null || true)
  if [[ -n "$RESPONSE" ]]; then
    echo "  brain-${NEW_SLOT} is responding (elapsed: ${ELAPSED}s)"
    HEALTHY=true
    break
  fi
  echo "  Waiting for brain-${NEW_SLOT}... (${ELAPSED}s / ${HEALTH_TIMEOUT}s)"
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

cleanup_pf

# Restore simple rollback trap
trap rollback ERR

if [[ "$HEALTHY" != "true" ]]; then
  echo "ERROR: brain-${NEW_SLOT} did not become healthy within ${HEALTH_TIMEOUT}s" >&2
  rollback
fi

# ---------------------------------------------------------------------------
# Step 6: Switch Service selector to new slot
# ---------------------------------------------------------------------------
echo ""
echo "==> Switching service to brain-${NEW_SLOT}..."
kubectl patch svc "$SERVICE_NAME" -n "$NAMESPACE" \
  -p "{\"spec\":{\"selector\":{\"app\":\"brain\",\"slot\":\"${NEW_SLOT}\"}}}"

echo "==> Service now pointing to: $NEW_SLOT"

# ---------------------------------------------------------------------------
# Step 6b: Reset BRAIN_ROLE to active on new slot
# ---------------------------------------------------------------------------
echo ""
echo "==> Resetting BRAIN_ROLE to active on brain-${NEW_SLOT}..."
kubectl patch deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" --type='json' -p="[
  {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/env\", \"value\": $(
    kubectl get deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].env}' | \
    python3 -c "
import json, sys
envs = json.load(sys.stdin)
for e in envs:
    if e['name'] == 'BRAIN_ROLE':
        e['value'] = 'active'
print(json.dumps(envs))
"
  )}
]"

echo "==> brain-${NEW_SLOT} BRAIN_ROLE set to active (pod will restart)"

# Wait for the restarted pod to become ready
echo "==> Waiting for brain-${NEW_SLOT} rollout after BRAIN_ROLE reset..."
kubectl rollout status deployment "brain-${NEW_SLOT}" -n "$NAMESPACE" \
  --timeout="$ROLLOUT_TIMEOUT"

# ---------------------------------------------------------------------------
# Step 7: Scale down old slot
# ---------------------------------------------------------------------------
echo ""
echo "==> Scaling brain-${CURRENT_SLOT} to 0 replicas..."
kubectl scale deployment "brain-${CURRENT_SLOT}" -n "$NAMESPACE" --replicas=0

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Upgrade complete!"
echo "  Version:     $VERSION"
echo "  Active slot: $NEW_SLOT"
echo "========================================"
