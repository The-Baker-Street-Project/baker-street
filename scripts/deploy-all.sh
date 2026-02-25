#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# deploy-all.sh — Interactive full deploy orchestrator for Baker Street
#
# Usage:
#   scripts/deploy-all.sh [options]
#
# Options:
#   --yes, -y          Skip all confirmations (use defaults / existing config)
#   --skip-build       Skip pnpm install/build and Docker image builds
#   --skip-images      Skip Docker image builds only
#   --skip-secrets     Skip secrets configuration
#   --skip-telemetry   Skip telemetry stack (OTel, Grafana, Prometheus, etc.)
#   --skip-extensions  Skip extension pods (utilities, etc.)
#   --no-cache         Force fresh Docker builds (no layer cache)
#   --dev              Use dev overlay (sets BAKERST_MODE=dev)
#   --version <tag>    Version tag for images (default: git short hash)
#   --help, -h         Show this help
###############################################################################

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="bakerst"
TELEMETRY_NAMESPACE="bakerst-telemetry"

# ---------------------------------------------------------------------------
# Deploy log — capture all output for debugging
# ---------------------------------------------------------------------------
DEPLOY_LOG="${REPO_ROOT}/deploy.log"
: > "$DEPLOY_LOG"  # truncate previous log
exec > >(tee "$DEPLOY_LOG") 2>&1
echo "=== Deploy started: $(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date) ==="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Defaults
AUTO_YES=false
SKIP_BUILD=false
SKIP_IMAGES=false
SKIP_SECRETS=false
SKIP_TELEMETRY=false
SKIP_EXTENSIONS=false
NO_CACHE=false
DEPLOY_TELEMETRY=false
DEPLOY_EXTENSIONS=false
USE_DEV=false
VERSION=""
PROMETHEUS_MODE=""  # "local" or "external"
PROMETHEUS_EXTERNAL_URL=""
PROMETHEUS_EXTERNAL_USER=""
PROMETHEUS_EXTERNAL_PASS=""

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)          AUTO_YES=true; shift ;;
    --skip-build)      SKIP_BUILD=true; shift ;;
    --skip-images)     SKIP_IMAGES=true; shift ;;
    --skip-secrets)    SKIP_SECRETS=true; shift ;;
    --skip-telemetry)  SKIP_TELEMETRY=true; shift ;;
    --skip-extensions) SKIP_EXTENSIONS=true; shift ;;
    --no-cache)        NO_CACHE=true; shift ;;
    --dev)             USE_DEV=true; shift ;;
    --version)         VERSION="$2"; shift 2 ;;
    --help|-h)
      sed -n '3,15p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}" >&2
      echo "Use --help for usage information." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
banner() {
  echo ""
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

step() {
  echo -e "\n${GREEN}==> $1${NC}"
}

warn() {
  echo -e "${YELLOW}    ⚠  $1${NC}"
}

info() {
  echo -e "${CYAN}    $1${NC}"
}

fail() {
  echo -e "${RED}ERROR: $1${NC}" >&2
  exit 1
}

ask() {
  # ask "prompt" "default"
  local prompt="$1"
  local default="${2:-}"
  if [[ "$AUTO_YES" == true && -n "$default" ]]; then
    echo "$default"
    return
  fi
  local suffix=""
  if [[ -n "$default" ]]; then
    suffix=" [${default}]"
  fi
  echo -en "${BOLD}    ${prompt}${suffix}: ${NC}" >&2
  local answer
  read -r answer
  if [[ -z "$answer" && -n "$default" ]]; then
    echo "$default"
  else
    echo "$answer"
  fi
}

ask_secret() {
  # ask_secret "prompt" "default"
  local prompt="$1"
  local default="${2:-}"
  if [[ "$AUTO_YES" == true && -n "$default" ]]; then
    echo "$default"
    return
  fi
  local suffix=""
  if [[ -n "$default" ]]; then
    suffix=" [****${default: -4}]"
  fi
  echo -en "${BOLD}    ${prompt}${suffix}: ${NC}" >&2
  local answer
  read -rs answer
  echo "" >&2
  if [[ -z "$answer" && -n "$default" ]]; then
    echo "$default"
  else
    echo "$answer"
  fi
}

confirm() {
  # confirm "question" → returns 0 (yes) or 1 (no)
  if [[ "$AUTO_YES" == true ]]; then
    return 0
  fi
  echo -en "${BOLD}    $1 [Y/n]: ${NC}" >&2
  local answer
  read -r answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

confirm_no_default() {
  # confirm_no_default "question" → returns 0 (yes) or 1 (no); defaults to no
  if [[ "$AUTO_YES" == true ]]; then
    return 1
  fi
  echo -en "${BOLD}    $1 [y/N]: ${NC}" >&2
  local answer
  read -r answer
  [[ "$answer" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------
# Step 0: Banner & prerequisite checks
# ---------------------------------------------------------------------------
banner "Baker Street Deploy"

step "Checking prerequisites..."

MISSING=()
for cmd in docker kubectl pnpm node openssl git; do
  if ! command -v "$cmd" &>/dev/null; then
    MISSING+=("$cmd")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  fail "Missing required tools: ${MISSING[*]}"
fi

# Validate Node.js version (must be even/LTS >=22)
NODE_VERSION=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  fail "Node.js >= 22 required (found v${NODE_VERSION}). Install Node 22 LTS: https://nodejs.org"
fi
if (( NODE_MAJOR % 2 != 0 )); then
  warn "Node.js v${NODE_VERSION} is an odd-numbered (unstable) release."
  warn "Baker Street requires an even-numbered LTS release (22, 24, etc.)."
  warn "Odd versions may cause ELIFECYCLE build failures."
  fail "Switch to Node $(( NODE_MAJOR - 1 )) or $(( NODE_MAJOR + 1 )): nvm install $(( NODE_MAJOR - 1 ))"
fi

# Validate pnpm version (must be >=9)
PNPM_MAJOR=$(pnpm --version | cut -d. -f1)
if [[ "$PNPM_MAJOR" -lt 9 ]]; then
  fail "pnpm >= 9 required (found $(pnpm --version)). Run: corepack enable && corepack prepare pnpm@latest --activate"
fi

# Check Docker is running
if ! docker info &>/dev/null; then
  fail "Docker is not running. Start Docker Desktop first."
fi

# Check kubectl can reach a cluster
if ! kubectl cluster-info &>/dev/null 2>&1; then
  fail "Cannot reach Kubernetes cluster. Ensure Docker Desktop Kubernetes is enabled."
fi

CLUSTER=$(kubectl config current-context 2>/dev/null || echo "unknown")
info "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
info "Kubectl context: ${CLUSTER}"
info "Node: v${NODE_VERSION} (LTS)"
info "pnpm: $(pnpm --version)"

# ---------------------------------------------------------------------------
# Step 1: Determine version
# ---------------------------------------------------------------------------
step "Version"

if [[ -z "$VERSION" ]]; then
  VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi
VERSION=$(ask "Image version tag" "$VERSION")

if [[ ! "$VERSION" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  fail "Invalid version: '$VERSION'. Use only alphanumeric, dash, dot, underscore."
fi
info "Version: ${VERSION}"

# ---------------------------------------------------------------------------
# Step 2: Environment mode
# ---------------------------------------------------------------------------
step "Environment"

if [[ "$USE_DEV" == false && "$AUTO_YES" == false ]]; then
  if confirm "Use dev overlay? (sets BAKERST_MODE=dev on all services)"; then
    USE_DEV=true
  fi
fi

if [[ "$USE_DEV" == true ]]; then
  info "Mode: dev (BAKERST_MODE=dev)"
else
  info "Mode: production"
fi

# ---------------------------------------------------------------------------
# Step 2b: Telemetry stack
# ---------------------------------------------------------------------------
if [[ "$SKIP_TELEMETRY" == false ]]; then
  step "Telemetry"

  # Check available memory
  AVAIL_MEM_MB=0
  if command -v free &>/dev/null; then
    AVAIL_MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || echo "0")
  fi

  if [[ "$AVAIL_MEM_MB" -gt 0 && "$AVAIL_MEM_MB" -lt 4096 ]]; then
    warn "Low available memory (${AVAIL_MEM_MB}MB). Telemetry adds ~1.5GB RAM."
    warn "Skipping telemetry to preserve system resources."
    DEPLOY_TELEMETRY=false
  else
    info "Telemetry adds 5-6 pods (~1.5GB RAM) for distributed tracing,"
    info "log aggregation, and metrics. Recommended for debugging and"
    info "performance monitoring."
    if confirm_no_default "Install telemetry stack? (advanced)"; then
      DEPLOY_TELEMETRY=true

      # Ask about Prometheus mode
      info "A local Prometheus instance will be deployed by default."
      if confirm_no_default "Use an external Prometheus instead?"; then
        PROMETHEUS_MODE="external"
        PROMETHEUS_EXTERNAL_URL=$(ask "Prometheus remote-write URL" "${PROMETHEUS_EXTERNAL_URL:-}")
        if [[ -z "$PROMETHEUS_EXTERNAL_URL" ]]; then
          warn "No URL provided — using local Prometheus."
          PROMETHEUS_MODE="local"
        else
          if confirm_no_default "Does the external Prometheus require authentication?"; then
            PROMETHEUS_EXTERNAL_USER=$(ask "Username" "${PROMETHEUS_EXTERNAL_USER:-}")
            PROMETHEUS_EXTERNAL_PASS=$(ask_secret "Password" "${PROMETHEUS_EXTERNAL_PASS:-}")
          fi
        fi
      else
        PROMETHEUS_MODE="local"
      fi

      info "Prometheus mode: ${PROMETHEUS_MODE}"
    else
      DEPLOY_TELEMETRY=false
      info "Telemetry will not be deployed."
    fi
  fi
else
  step "Skipping telemetry (--skip-telemetry)"
fi

# ---------------------------------------------------------------------------
# Step 2c: Extension pods
# ---------------------------------------------------------------------------
if [[ "$SKIP_EXTENSIONS" == false ]]; then
  step "Extensions"

  # Check if any extension examples exist
  EXTENSIONS_DIR="$REPO_ROOT/examples"
  if [[ -d "$EXTENSIONS_DIR" ]]; then
    EXT_COUNT=$(find "$EXTENSIONS_DIR" -maxdepth 1 -mindepth 1 -type d | wc -l)
    info "Found ${EXT_COUNT} extension(s) in examples/:"
    for ext_dir in "$EXTENSIONS_DIR"/*/; do
      ext_name=$(basename "$ext_dir")
      info "  - ${ext_name}"
    done
    echo ""
    info "Extensions add extra tool capabilities (time/date, DNS lookups,"
    info "HTTP fetch, etc.) by deploying additional pods."
    if confirm_no_default "Deploy extension pods?"; then
      DEPLOY_EXTENSIONS=true
    else
      DEPLOY_EXTENSIONS=false
      info "Extensions will not be deployed."
    fi
  else
    info "No extensions found in examples/."
    DEPLOY_EXTENSIONS=false
  fi
else
  step "Skipping extensions (--skip-extensions)"
fi

# ---------------------------------------------------------------------------
# Step 3: Secrets configuration
# ---------------------------------------------------------------------------
if [[ "$SKIP_SECRETS" == false ]]; then
  banner "Secrets Configuration"

  ENV_FILE="$REPO_ROOT/.env-secrets"

  # Load existing .env-secrets
  if [[ -f "$ENV_FILE" ]]; then
    step "Loading existing .env-secrets"
    set -a
    . "$ENV_FILE"
    set +a
    info "Loaded $(grep -c '=' "$ENV_FILE" 2>/dev/null || echo 0) variables"
  else
    step "No .env-secrets found — starting fresh"
  fi

  # --- Anthropic auth ---
  step "Anthropic authentication (required)"

  HAVE_ANTHROPIC=false
  if [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]]; then
    info "ANTHROPIC_OAUTH_TOKEN is set (****${ANTHROPIC_OAUTH_TOKEN: -4})"
    HAVE_ANTHROPIC=true
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    info "ANTHROPIC_API_KEY is set (****${ANTHROPIC_API_KEY: -4})"
    HAVE_ANTHROPIC=true
  fi

  if [[ "$HAVE_ANTHROPIC" == false ]]; then
    warn "No Anthropic credentials found."
    info "Provide either an OAuth token (preferred) or an API key."
    ANTHROPIC_OAUTH_TOKEN=$(ask_secret "ANTHROPIC_OAUTH_TOKEN (or press Enter to use API key instead)" "")
    if [[ -z "$ANTHROPIC_OAUTH_TOKEN" ]]; then
      ANTHROPIC_API_KEY=$(ask_secret "ANTHROPIC_API_KEY" "")
      if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        fail "At least one of ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY is required."
      fi
    fi
  fi

  # --- Voyage API key ---
  step "Voyage AI (embeddings)"

  if [[ -n "${VOYAGE_API_KEY:-}" ]]; then
    info "VOYAGE_API_KEY is set (****${VOYAGE_API_KEY: -4})"
  else
    VOYAGE_API_KEY=$(ask_secret "VOYAGE_API_KEY (optional, press Enter to skip)" "")
    if [[ -z "$VOYAGE_API_KEY" ]]; then
      warn "Skipped — embeddings will not be available."
    fi
  fi

  # --- Telegram ---
  step "Telegram gateway (optional)"

  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    info "TELEGRAM_BOT_TOKEN is set (****${TELEGRAM_BOT_TOKEN: -4})"
    if [[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]]; then
      info "TELEGRAM_ALLOWED_CHAT_IDS: ${TELEGRAM_ALLOWED_CHAT_IDS}"
    fi
  else
    if [[ "$AUTO_YES" == false ]] && confirm "Configure Telegram bot?"; then
      TELEGRAM_BOT_TOKEN=$(ask_secret "TELEGRAM_BOT_TOKEN" "")
      if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
        TELEGRAM_ALLOWED_CHAT_IDS=$(ask "TELEGRAM_ALLOWED_CHAT_IDS (comma-separated)" "${TELEGRAM_ALLOWED_CHAT_IDS:-}")
      fi
    else
      info "Skipped"
    fi
  fi

  # --- Discord ---
  step "Discord gateway (optional)"

  if [[ -n "${DISCORD_BOT_TOKEN:-}" ]]; then
    info "DISCORD_BOT_TOKEN is set (****${DISCORD_BOT_TOKEN: -4})"
    if [[ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]]; then
      info "DISCORD_ALLOWED_CHANNEL_IDS: ${DISCORD_ALLOWED_CHANNEL_IDS}"
    fi
  else
    if [[ "$AUTO_YES" == false ]] && confirm "Configure Discord bot?"; then
      DISCORD_BOT_TOKEN=$(ask_secret "DISCORD_BOT_TOKEN" "")
      if [[ -n "$DISCORD_BOT_TOKEN" ]]; then
        DISCORD_ALLOWED_CHANNEL_IDS=$(ask "DISCORD_ALLOWED_CHANNEL_IDS (comma-separated)" "${DISCORD_ALLOWED_CHANNEL_IDS:-}")
      fi
    else
      info "Skipped"
    fi
  fi

  # --- AUTH_TOKEN ---
  step "Auth token"

  if [[ -z "${AUTH_TOKEN:-}" ]]; then
    AUTH_TOKEN="$(openssl rand -hex 32)"
    info "Generated new AUTH_TOKEN"
  else
    info "Using existing AUTH_TOKEN (****${AUTH_TOKEN: -4})"
  fi

  # --- AGENT_NAME ---
  step "Agent persona name"

  AGENT_NAME=$(ask "Agent persona name" "${AGENT_NAME:-Baker}")
  info "Agent name: ${AGENT_NAME}"

  # --- Save .env-secrets ---
  step "Saving secrets to .env-secrets"

  {
    [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]] && echo "ANTHROPIC_OAUTH_TOKEN=$ANTHROPIC_OAUTH_TOKEN"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]]     && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    [[ -n "${VOYAGE_API_KEY:-}" ]]        && echo "VOYAGE_API_KEY=$VOYAGE_API_KEY"
    [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]    && echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
    [[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]] && echo "TELEGRAM_ALLOWED_CHAT_IDS=$TELEGRAM_ALLOWED_CHAT_IDS"
    [[ -n "${DISCORD_BOT_TOKEN:-}" ]]     && echo "DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN"
    [[ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]] && echo "DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_ALLOWED_CHANNEL_IDS"
    echo "AUTH_TOKEN=$AUTH_TOKEN"
    [[ -n "${AGENT_NAME:-}" ]] && echo "AGENT_NAME=$AGENT_NAME"
    [[ -n "${PROMETHEUS_EXTERNAL_URL:-}" ]]  && echo "PROMETHEUS_EXTERNAL_URL=$PROMETHEUS_EXTERNAL_URL"
    [[ -n "${PROMETHEUS_EXTERNAL_USER:-}" ]] && echo "PROMETHEUS_EXTERNAL_USER=$PROMETHEUS_EXTERNAL_USER"
    [[ -n "${PROMETHEUS_EXTERNAL_PASS:-}" ]] && echo "PROMETHEUS_EXTERNAL_PASS=$PROMETHEUS_EXTERNAL_PASS"
  } > "$ENV_FILE"

  info "Saved to .env-secrets"
else
  step "Skipping secrets configuration (--skip-secrets)"

  # Still need to load them for the K8s secret creation
  ENV_FILE="$REPO_ROOT/.env-secrets"
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    . "$ENV_FILE"
    set +a
  fi

  if [[ -z "${AUTH_TOKEN:-}" ]]; then
    AUTH_TOKEN="$(openssl rand -hex 32)"
    echo "AUTH_TOKEN=$AUTH_TOKEN" >> "$ENV_FILE"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: Build application
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == false ]]; then
  banner "Build"

  step "Installing dependencies (pnpm install)..."
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)

  step "Compiling TypeScript (pnpm -r build)..."
  (cd "$REPO_ROOT" && pnpm -r build)
else
  step "Skipping pnpm install/build (--skip-build)"
fi

# ---------------------------------------------------------------------------
# Step 5: Build Docker images
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == false && "$SKIP_IMAGES" == false ]]; then
  banner "Docker Images"

  DOCKER_CACHE_FLAG=""
  if [[ "$NO_CACHE" == true ]]; then
    DOCKER_CACHE_FLAG="--no-cache"
    info "Docker cache disabled (--no-cache)"
  fi

  step "Building bakerst-brain (version: ${VERSION})..."
  docker build $DOCKER_CACHE_FLAG -t bakerst-brain:latest -t "bakerst-brain:${VERSION}" \
    --build-arg BRAIN_VERSION="$VERSION" \
    -f "$REPO_ROOT/services/brain/Dockerfile" "$REPO_ROOT"

  step "Building bakerst-worker..."
  docker build $DOCKER_CACHE_FLAG -t bakerst-worker:latest \
    -f "$REPO_ROOT/services/worker/Dockerfile" "$REPO_ROOT"

  step "Building bakerst-ui..."
  docker build $DOCKER_CACHE_FLAG -t bakerst-ui:latest \
    -f "$REPO_ROOT/services/ui/Dockerfile" "$REPO_ROOT"

  step "Building bakerst-gateway..."
  docker build $DOCKER_CACHE_FLAG -t bakerst-gateway:latest \
    -f "$REPO_ROOT/services/gateway/Dockerfile" "$REPO_ROOT"

  # Extension images
  if [[ "$DEPLOY_EXTENSIONS" == true ]]; then
    for ext_dir in "$REPO_ROOT/examples"/*/; do
      ext_name=$(basename "$ext_dir")
      if [[ -f "${ext_dir}Dockerfile" ]]; then
        step "Building bakerst-ext-${ext_name#extension-}..."
        docker build $DOCKER_CACHE_FLAG -t "bakerst-ext-${ext_name#extension-}:latest" \
          -f "${ext_dir}Dockerfile" "$REPO_ROOT"
      fi
    done
  fi

  step "Images built:"
  docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep bakerst
else
  if [[ "$SKIP_BUILD" == true ]]; then
    step "Skipping Docker builds (--skip-build)"
  else
    step "Skipping Docker builds (--skip-images)"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Create Kubernetes secrets
# ---------------------------------------------------------------------------
banner "Kubernetes Deploy"

step "Creating namespace..."
kubectl apply -f "$REPO_ROOT/k8s/namespace.yaml"

step "Creating Kubernetes secrets..."

# --- Brain secrets ---
BRAIN_ARGS=()
[[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]] && BRAIN_ARGS+=(--from-literal="ANTHROPIC_OAUTH_TOKEN=$ANTHROPIC_OAUTH_TOKEN")
[[ -n "${ANTHROPIC_API_KEY:-}" ]]     && BRAIN_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[[ -n "${VOYAGE_API_KEY:-}" ]]        && BRAIN_ARGS+=(--from-literal="VOYAGE_API_KEY=$VOYAGE_API_KEY")
BRAIN_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")
[[ -n "${AGENT_NAME:-}" ]] && BRAIN_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")

if [[ ${#BRAIN_ARGS[@]} -lt 2 ]]; then
  fail "No Anthropic credentials configured. Cannot create brain secrets."
fi

info "Creating bakerst-brain-secrets"
kubectl create secret generic bakerst-brain-secrets \
  "${BRAIN_ARGS[@]}" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- Worker secrets ---
WORKER_ARGS=()
[[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]] && WORKER_ARGS+=(--from-literal="ANTHROPIC_OAUTH_TOKEN=$ANTHROPIC_OAUTH_TOKEN")
[[ -n "${ANTHROPIC_API_KEY:-}" ]]     && WORKER_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")

[[ -n "${AGENT_NAME:-}" ]] && WORKER_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")

if [[ ${#WORKER_ARGS[@]} -eq 0 ]]; then
  warn "No Anthropic keys for worker — skipping bakerst-worker-secrets"
else
  info "Creating bakerst-worker-secrets"
  kubectl create secret generic bakerst-worker-secrets \
    "${WORKER_ARGS[@]}" \
    -n "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# --- Gateway secrets ---
GATEWAY_ARGS=()
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]          && GATEWAY_ARGS+=(--from-literal="TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN")
[[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]]   && GATEWAY_ARGS+=(--from-literal="TELEGRAM_ALLOWED_CHAT_IDS=$TELEGRAM_ALLOWED_CHAT_IDS")
[[ -n "${DISCORD_BOT_TOKEN:-}" ]]           && GATEWAY_ARGS+=(--from-literal="DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN")
[[ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]] && GATEWAY_ARGS+=(--from-literal="DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_ALLOWED_CHANNEL_IDS")
GATEWAY_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")

info "Creating bakerst-gateway-secrets"
kubectl create secret generic bakerst-gateway-secrets \
  "${GATEWAY_ARGS[@]}" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- Telemetry secrets (external Prometheus) ---
if [[ "$DEPLOY_TELEMETRY" == true && "$PROMETHEUS_MODE" == "external" ]]; then
  step "Creating telemetry namespace..."
  kubectl apply -f "$REPO_ROOT/k8s/telemetry/namespace.yaml"

  TELEM_ARGS=()
  [[ -n "${PROMETHEUS_EXTERNAL_URL:-}" ]]  && TELEM_ARGS+=(--from-literal="PROMETHEUS_EXTERNAL_URL=$PROMETHEUS_EXTERNAL_URL")
  [[ -n "${PROMETHEUS_EXTERNAL_USER:-}" ]] && TELEM_ARGS+=(--from-literal="PROMETHEUS_EXTERNAL_USER=$PROMETHEUS_EXTERNAL_USER")
  [[ -n "${PROMETHEUS_EXTERNAL_PASS:-}" ]] && TELEM_ARGS+=(--from-literal="PROMETHEUS_EXTERNAL_PASS=$PROMETHEUS_EXTERNAL_PASS")

  if [[ ${#TELEM_ARGS[@]} -gt 0 ]]; then
    info "Creating bakerst-telemetry-secrets"
    kubectl create secret generic bakerst-telemetry-secrets \
      "${TELEM_ARGS[@]}" \
      -n "$TELEMETRY_NAMESPACE" \
      --dry-run=client -o yaml | kubectl apply -f -
  fi
fi

# ---------------------------------------------------------------------------
# Step 7: Create ConfigMap and apply manifests
# ---------------------------------------------------------------------------
step "Creating configmap from operating_system/..."
kubectl create configmap bakerst-os \
  --from-file="$REPO_ROOT/operating_system/" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

step "Applying Kubernetes manifests..."
if [[ "$USE_DEV" == true ]]; then
  info "Using dev overlay"
  # Dev overlay references component dirs only; apply standalone resources separately
  kubectl apply -f "$REPO_ROOT/k8s/network-policies.yaml" -n "$NAMESPACE"
  kubectl apply -k "$REPO_ROOT/k8s/overlays/dev/"
else
  kubectl apply -k "$REPO_ROOT/k8s/"
fi

# ---------------------------------------------------------------------------
# Step 7a: Deploy extensions (conditional)
# ---------------------------------------------------------------------------
if [[ "$DEPLOY_EXTENSIONS" == true ]]; then
  step "Deploying extension pods..."
  for ext_dir in "$REPO_ROOT/examples"/*/; do
    ext_name=$(basename "$ext_dir")
    k8s_dir="${ext_dir}k8s"
    if [[ -d "$k8s_dir" ]]; then
      info "Applying ${ext_name} manifests..."
      kubectl apply -f "$k8s_dir/" -n "$NAMESPACE"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Step 7b: Deploy telemetry stack (conditional)
# ---------------------------------------------------------------------------
if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  step "Deploying telemetry stack to ${TELEMETRY_NAMESPACE}..."
  kubectl apply -k "$REPO_ROOT/k8s/telemetry/"

  # If external Prometheus: patch OTel Collector with remote-write and Grafana with external URL
  if [[ "$PROMETHEUS_MODE" == "external" ]]; then
    info "Configuring external Prometheus: ${PROMETHEUS_EXTERNAL_URL}"

    # Build remote-write exporter config
    RW_AUTH=""
    if [[ -n "${PROMETHEUS_EXTERNAL_USER:-}" ]]; then
      RW_AUTH="
        headers:
          Authorization: \"Basic $(echo -n "${PROMETHEUS_EXTERNAL_USER}:${PROMETHEUS_EXTERNAL_PASS}" | base64)\""
    fi

    # Patch OTel Collector configmap with remote-write exporter
    kubectl create configmap otel-collector-config \
      -n "$TELEMETRY_NAMESPACE" \
      --from-literal="otel-collector-config.yaml=$(cat <<OTELEOF
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889
    resource_to_telemetry_conversion:
      enabled: true
  prometheusremotewrite:
    endpoint: "${PROMETHEUS_EXTERNAL_URL}"
    tls:
      insecure: false${RW_AUTH}
  debug:
    verbosity: basic
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo, debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus, prometheusremotewrite]
OTELEOF
)" \
      --dry-run=client -o yaml | kubectl apply -f -

    # Patch Grafana datasource to use external Prometheus URL
    kubectl create configmap grafana-datasources \
      -n "$TELEMETRY_NAMESPACE" \
      --from-literal="datasources.yaml=$(cat <<GRAFEOF
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    uid: prometheus
    url: ${PROMETHEUS_EXTERNAL_URL}
    isDefault: true$(if [[ -n "${PROMETHEUS_EXTERNAL_USER:-}" ]]; then cat <<AUTHEOF

    basicAuth: true
    basicAuthUser: ${PROMETHEUS_EXTERNAL_USER}
    secureJsonData:
      basicAuthPassword: ${PROMETHEUS_EXTERNAL_PASS}
AUTHEOF
fi)
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true
      tracesToMetrics:
        datasourceUid: prometheus
  - name: Loki
    type: loki
    access: proxy
    uid: loki
    url: http://loki:3100
GRAFEOF
)" \
      --dry-run=client -o yaml | kubectl apply -f -

    # Restart otel-collector and grafana to pick up new configmaps
    kubectl rollout restart deployment/otel-collector -n "$TELEMETRY_NAMESPACE"
    kubectl rollout restart deployment/grafana -n "$TELEMETRY_NAMESPACE"
  fi
fi

# ---------------------------------------------------------------------------
# Step 8: Wait for rollout
# ---------------------------------------------------------------------------
step "Waiting for rollouts..."

APP_DEPLOYMENTS=(nats qdrant brain-blue worker ui gateway)
FAILED=()

for deploy in "${APP_DEPLOYMENTS[@]}"; do
  echo -n "    ${deploy}... "
  if kubectl rollout status "deployment/${deploy}" -n "$NAMESPACE" --timeout=120s &>/dev/null; then
    echo -e "${GREEN}ready${NC}"
  else
    echo -e "${RED}failed${NC}"
    FAILED+=("$deploy")
  fi
done

if [[ "$DEPLOY_EXTENSIONS" == true ]]; then
  for ext_dir in "$REPO_ROOT/examples"/*/; do
    ext_name=$(basename "$ext_dir")
    k8s_dir="${ext_dir}k8s"
    if [[ -d "$k8s_dir" ]]; then
      # Extract deployment name from the K8s manifest
      deploy_name=$(grep -m1 'name:' "$k8s_dir/deployment.yaml" 2>/dev/null | awk '{print $2}' || true)
      if [[ -n "$deploy_name" ]]; then
        echo -n "    ${deploy_name} (extension)... "
        if kubectl rollout status "deployment/${deploy_name}" -n "$NAMESPACE" --timeout=120s &>/dev/null; then
          echo -e "${GREEN}ready${NC}"
        else
          echo -e "${RED}failed${NC}"
          FAILED+=("${deploy_name}(extension)")
        fi
      fi
    fi
  done
fi

if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  TELEMETRY_DEPLOYMENTS=(otel-collector tempo loki grafana)
  if [[ "$PROMETHEUS_MODE" == "local" ]]; then
    TELEMETRY_DEPLOYMENTS+=(prometheus kube-state-metrics)
  fi

  for deploy in "${TELEMETRY_DEPLOYMENTS[@]}"; do
    echo -n "    ${deploy} (telemetry)... "
    if kubectl rollout status "deployment/${deploy}" -n "$TELEMETRY_NAMESPACE" --timeout=120s &>/dev/null; then
      echo -e "${GREEN}ready${NC}"
    else
      echo -e "${RED}failed${NC}"
      FAILED+=("${deploy}(telemetry)")
    fi
  done
fi

# ---------------------------------------------------------------------------
# Step 9: Summary
# ---------------------------------------------------------------------------
banner "Deploy Complete"

echo ""
kubectl get pods -n "$NAMESPACE" -o wide --no-headers | while read -r line; do
  info "$line"
done

if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  echo ""
  info "--- Telemetry namespace ---"
  kubectl get pods -n "$TELEMETRY_NAMESPACE" -o wide --no-headers | while read -r line; do
    info "$line"
  done
fi
echo ""

if [[ ${#FAILED[@]} -gt 0 ]]; then
  warn "Some deployments did not become ready: ${FAILED[*]}"
  warn "Check logs: kubectl logs -n <namespace> deployment/<name>"
fi

# Print configured features
echo -e "${BOLD}  Configuration:${NC}"
info "Version:     ${VERSION}"
info "Mode:        $(if [[ "$USE_DEV" == true ]]; then echo "dev"; else echo "production"; fi)"
info "Anthropic:   $(if [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]]; then echo "OAuth token"; elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then echo "API key"; fi)"
info "Voyage:      $(if [[ -n "${VOYAGE_API_KEY:-}" ]]; then echo "configured"; else echo "not configured"; fi)"
info "Telegram:    $(if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then echo "configured"; else echo "not configured"; fi)"
info "Discord:     $(if [[ -n "${DISCORD_BOT_TOKEN:-}" ]]; then echo "configured"; else echo "not configured"; fi)"
info "Agent name:  ${AGENT_NAME:-Baker}"
info "Auth token:  ****${AUTH_TOKEN: -4}"
if [[ "$DEPLOY_EXTENSIONS" == true ]]; then
  info "Extensions:  deployed"
else
  info "Extensions:  not deployed"
fi
if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  info "Telemetry:   deployed (Prometheus: ${PROMETHEUS_MODE})"
else
  info "Telemetry:   not deployed"
fi

echo ""
echo -e "${BOLD}  Access:${NC}"
info "UI:          http://localhost:30080"
info "Brain API:   http://localhost:30000"
if [[ "$DEPLOY_TELEMETRY" == true ]]; then
  info "Grafana:     http://localhost:30001"
fi
info "Deploy log:  ${DEPLOY_LOG}"
echo ""
