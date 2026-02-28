#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Parse --version flag (default: git short hash)
VERSION=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [[ -z "$VERSION" ]]; then
  VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi

echo "==> Build version: $VERSION"

echo "==> Building bakerst-brain..."
docker build --network host -t bakerst-brain:latest --build-arg BRAIN_VERSION="$VERSION" -f "$REPO_ROOT/services/brain/Dockerfile" "$REPO_ROOT"

echo "==> Building bakerst-worker..."
docker build --network host -t bakerst-worker:latest -f "$REPO_ROOT/services/worker/Dockerfile" "$REPO_ROOT"

echo "==> Building bakerst-ui..."
docker build --network host -t bakerst-ui:latest -f "$REPO_ROOT/services/ui/Dockerfile" "$REPO_ROOT"

echo "==> Building bakerst-gateway..."
docker build --network host -t bakerst-gateway:latest -f "$REPO_ROOT/services/gateway/Dockerfile" "$REPO_ROOT"

echo "==> Building bakerst-sysadmin..."
docker build --network host -t bakerst-sysadmin:latest -f "$REPO_ROOT/services/sysadmin/Dockerfile" "$REPO_ROOT"

echo "==> Done. Images:"
docker images | grep bakerst
