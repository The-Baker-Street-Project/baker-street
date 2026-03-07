#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Parse flags (default: git short hash for version)
VERSION=""
FORCE_BUILD="${FORCE_BUILD:-false}"
NO_CACHE=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --force)
      FORCE_BUILD="true"
      shift
      ;;
    --no-cache)
      FORCE_BUILD="true"
      NO_CACHE="--no-cache"
      shift
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

# --- Change detection ---
HASH_DIR="$REPO_ROOT/.build-hashes"
mkdir -p "$HASH_DIR"

CURRENT_HASH=""

compute_hash() {
  local context_path="$1"
  local dockerfile="$2"
  find "$context_path" "$dockerfile" -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.build-hashes/*' \
    | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1
}

should_build() {
  local name="$1"
  local context_path="$2"
  local dockerfile="$3"

  CURRENT_HASH=$(compute_hash "$context_path" "$dockerfile")

  if [[ "$FORCE_BUILD" == "true" ]]; then return 0; fi

  local stored_hash=""
  if [[ -f "$HASH_DIR/$name.hash" ]]; then
    stored_hash=$(cat "$HASH_DIR/$name.hash")
  fi

  if [[ "$CURRENT_HASH" == "$stored_hash" ]]; then
    echo "==> Skipping $name (no changes)"
    return 1
  fi

  return 0
}

save_hash() {
  local name="$1"
  echo "$CURRENT_HASH" > "$HASH_DIR/$name.hash"
}

echo "==> Build version: $VERSION"

if should_build "brain" "$REPO_ROOT/services/brain" "$REPO_ROOT/services/brain/Dockerfile"; then
  echo "==> Building bakerst-brain..."
  docker build --network host $NO_CACHE -t bakerst-brain:latest --build-arg BRAIN_VERSION="$VERSION" \
    -f "$REPO_ROOT/services/brain/Dockerfile" "$REPO_ROOT" && save_hash "brain"
fi

if should_build "worker" "$REPO_ROOT/services/worker" "$REPO_ROOT/services/worker/Dockerfile"; then
  echo "==> Building bakerst-worker..."
  docker build --network host $NO_CACHE -t bakerst-worker:latest \
    -f "$REPO_ROOT/services/worker/Dockerfile" "$REPO_ROOT" && save_hash "worker"
fi

if should_build "ui" "$REPO_ROOT/services/ui" "$REPO_ROOT/services/ui/Dockerfile"; then
  echo "==> Building bakerst-ui..."
  docker build --network host $NO_CACHE -t bakerst-ui:latest \
    -f "$REPO_ROOT/services/ui/Dockerfile" "$REPO_ROOT" && save_hash "ui"
fi

if should_build "gateway" "$REPO_ROOT/services/gateway" "$REPO_ROOT/services/gateway/Dockerfile"; then
  echo "==> Building bakerst-gateway..."
  docker build --network host $NO_CACHE -t bakerst-gateway:latest \
    -f "$REPO_ROOT/services/gateway/Dockerfile" "$REPO_ROOT" && save_hash "gateway"
fi

if should_build "sysadmin" "$REPO_ROOT/services/sysadmin" "$REPO_ROOT/services/sysadmin/Dockerfile"; then
  echo "==> Building bakerst-sysadmin..."
  docker build --network host $NO_CACHE -t bakerst-sysadmin:latest \
    -f "$REPO_ROOT/services/sysadmin/Dockerfile" "$REPO_ROOT" && save_hash "sysadmin"
fi

if should_build "voice" "$REPO_ROOT/services/voice" "$REPO_ROOT/services/voice/Dockerfile"; then
  echo "==> Building bakerst-voice..."
  docker build --network host $NO_CACHE -t bakerst-voice:latest \
    -f "$REPO_ROOT/services/voice/Dockerfile" "$REPO_ROOT" && save_hash "voice"
fi

if should_build "ext-toolbox" "$REPO_ROOT/examples/extension-toolbox" "$REPO_ROOT/examples/extension-toolbox/Dockerfile"; then
  echo "==> Building bakerst-ext-toolbox..."
  docker build --network host $NO_CACHE -t bakerst-ext-toolbox:latest \
    -f "$REPO_ROOT/examples/extension-toolbox/Dockerfile" "$REPO_ROOT" && save_hash "ext-toolbox"
fi

if should_build "ext-browser" "$REPO_ROOT/examples/extension-browser" "$REPO_ROOT/examples/extension-browser/Dockerfile"; then
  echo "==> Building bakerst-ext-browser..."
  docker build --network host $NO_CACHE -t bakerst-ext-browser:latest \
    -f "$REPO_ROOT/examples/extension-browser/Dockerfile" "$REPO_ROOT" && save_hash "ext-browser"
fi

echo "==> Building bakerst-install CLI..."
make -C "$REPO_ROOT/tools/installer" install

echo "==> Done. Images:"
docker images | grep bakerst
