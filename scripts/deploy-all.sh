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

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# Defaults
AUTO_YES=false; SKIP_BUILD=false; SKIP_IMAGES=false; SKIP_SECRETS=false
SKIP_TELEMETRY=false; SKIP_EXTENSIONS=false; NO_CACHE=false; USE_DEV=false
VERSION=""

# ── Helpers ──────────────────────────────────────────────────────────────
banner() { echo -e "\n${BLUE}══════════════════════════════════════════════════════════${NC}\n${BOLD}  $1${NC}\n${BLUE}══════════════════════════════════════════════════════════${NC}"; }
step()   { echo -e "\n${GREEN}==> $1${NC}"; }
info()   { echo -e "${CYAN}    $1${NC}"; }
warn()   { echo -e "${YELLOW}    WARNING: $1${NC}"; }
fail()   { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

ask_secret() {
  local prompt="$1" default="${2:-}"
  if [[ "$AUTO_YES" == true && -n "$default" ]]; then echo "$default"; return; fi
  local suffix=""; [[ -n "$default" ]] && suffix=" [****${default: -4}]"
  echo -en "${BOLD}    ${prompt}${suffix}: ${NC}" >&2; local answer; read -rs answer; echo "" >&2
  if [[ -z "$answer" && -n "$default" ]]; then echo "$default"; else echo "$answer"; fi
}

ask() {
  local prompt="$1" default="${2:-}"
  if [[ "$AUTO_YES" == true && -n "$default" ]]; then echo "$default"; return; fi
  local suffix=""; [[ -n "$default" ]] && suffix=" [${default}]"
  echo -en "${BOLD}    ${prompt}${suffix}: ${NC}" >&2; local answer; read -r answer
  if [[ -z "$answer" && -n "$default" ]]; then echo "$default"; else echo "$answer"; fi
}

confirm() {
  [[ "$AUTO_YES" == true ]] && return 0
  echo -en "${BOLD}    $1 [Y/n]: ${NC}" >&2; local a; read -r a; [[ -z "$a" || "$a" =~ ^[Yy] ]]
}

# ── Parse arguments ─────────────────────────────────────────────────────
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
    --help|-h)         sed -n '3,15p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)                 fail "Unknown argument: $1. Use --help for usage." ;;
  esac
done

# ── 1. Preflight checks ─────────────────────────────────────────────────
banner "Baker Street Deploy"
step "Checking prerequisites..."

for cmd in docker kubectl pnpm node; do
  command -v "$cmd" &>/dev/null || fail "Missing required tool: $cmd"
done

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js >= 22 required (found v$(node --version))"

docker info &>/dev/null || fail "Docker is not running. Start Docker Desktop first."
kubectl cluster-info &>/dev/null 2>&1 || fail "Cannot reach Kubernetes cluster."

info "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
info "Kubectl: $(kubectl config current-context 2>/dev/null || echo 'unknown')"
info "Node: $(node --version)"

# ── 2. Secrets ───────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env-secrets"

# Always load existing secrets
if [[ -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE"; set +a
fi

if [[ "$SKIP_SECRETS" == false ]]; then
  banner "Secrets Configuration"

  # Core secrets
  [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ANTHROPIC_API_KEY=$(ask_secret "ANTHROPIC_API_KEY (optional if using Ollama)" "")
  [[ -z "${VOYAGE_API_KEY:-}" ]]    && VOYAGE_API_KEY=$(ask_secret "VOYAGE_API_KEY (optional)" "")

  # Model overrides
  if [[ "$AUTO_YES" == false ]]; then
    [[ -z "${DEFAULT_MODEL:-}" ]]  && DEFAULT_MODEL=$(ask "DEFAULT_MODEL (optional)" "")
    [[ -z "${WORKER_MODEL:-}" ]]   && WORKER_MODEL=$(ask "WORKER_MODEL (optional)" "")
    [[ -z "${OLLAMA_ENDPOINTS:-}" ]] && OLLAMA_ENDPOINTS=$(ask "OLLAMA_ENDPOINTS (optional, e.g. host.docker.internal:11434)" "")
  fi

  # Agent name
  AGENT_NAME=$(ask "Agent persona name" "${AGENT_NAME:-Baker}")
fi

# Auto-generate AUTH_TOKEN if not set
if [[ -z "${AUTH_TOKEN:-}" ]]; then
  AUTH_TOKEN="$(openssl rand -hex 32)"
  info "Generated new AUTH_TOKEN"
fi

# Persist secrets
{
  [[ -n "${ANTHROPIC_API_KEY:-}" ]]   && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
  [[ -n "${DEFAULT_MODEL:-}" ]]       && echo "DEFAULT_MODEL=$DEFAULT_MODEL"
  [[ -n "${WORKER_MODEL:-}" ]]        && echo "WORKER_MODEL=$WORKER_MODEL"
  [[ -n "${VOYAGE_API_KEY:-}" ]]      && echo "VOYAGE_API_KEY=$VOYAGE_API_KEY"
  [[ -n "${OPENAI_API_KEY:-}" ]]      && echo "OPENAI_API_KEY=$OPENAI_API_KEY"
  [[ -n "${OLLAMA_ENDPOINTS:-}" ]]    && echo "OLLAMA_ENDPOINTS=$OLLAMA_ENDPOINTS"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]  && echo "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
  [[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]] && echo "TELEGRAM_ALLOWED_CHAT_IDS=$TELEGRAM_ALLOWED_CHAT_IDS"
  [[ -n "${DISCORD_BOT_TOKEN:-}" ]]   && echo "DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN"
  [[ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]] && echo "DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_ALLOWED_CHANNEL_IDS"
  echo "AUTH_TOKEN=$AUTH_TOKEN"
  [[ -n "${AGENT_NAME:-}" ]]          && echo "AGENT_NAME=$AGENT_NAME"
  [[ -n "${GITHUB_TOKEN:-}" ]]        && echo "GITHUB_TOKEN=$GITHUB_TOKEN"
  [[ -n "${OBSIDIAN_VAULT_PATH:-}" ]] && echo "OBSIDIAN_VAULT_PATH=$OBSIDIAN_VAULT_PATH"
  [[ -n "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]     && echo "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
  [[ -n "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]  && echo "GOOGLE_OAUTH_CLIENT_SECRET=$GOOGLE_OAUTH_CLIENT_SECRET"
  [[ -n "${GOOGLE_CREDENTIAL_FILE:-}" ]]      && echo "GOOGLE_CREDENTIAL_FILE=$GOOGLE_CREDENTIAL_FILE"
} > "$ENV_FILE"

# ── 3. Version ───────────────────────────────────────────────────────────
[[ -z "$VERSION" ]] && VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
info "Version: ${VERSION}"

# ── 4. Build TypeScript ──────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then
  banner "Build"
  step "Installing dependencies..."
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
  step "Compiling TypeScript..."
  (cd "$REPO_ROOT" && pnpm -r build)
fi

# ── 5. Docker images ────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false && "$SKIP_IMAGES" == false ]]; then
  banner "Docker Images"
  BUILD_ARGS=("--version" "$VERSION")
  [[ "$NO_CACHE" == true ]] && BUILD_ARGS+=("--no-cache")
  SKIP_INSTALLER=true "$REPO_ROOT/scripts/build.sh" "${BUILD_ARGS[@]}"
fi

# ── 6. Apply Kubernetes ─────────────────────────────────────────────────
banner "Kubernetes Deploy"

step "Creating namespace..."
kubectl apply -f "$REPO_ROOT/k8s/namespace.yaml"

# --- Scoped secrets ---
step "Creating Kubernetes secrets..."

create_secret() {
  local name="$1"; shift
  if [[ $# -gt 0 ]]; then
    info "Creating $name"
    kubectl create secret generic "$name" "$@" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  fi
}

# Brain secrets
BRAIN_ARGS=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && BRAIN_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[[ -n "${DEFAULT_MODEL:-}" ]]     && BRAIN_ARGS+=(--from-literal="DEFAULT_MODEL=$DEFAULT_MODEL")
[[ -n "${WORKER_MODEL:-}" ]]      && BRAIN_ARGS+=(--from-literal="WORKER_MODEL=$WORKER_MODEL")
[[ -n "${VOYAGE_API_KEY:-}" ]]    && BRAIN_ARGS+=(--from-literal="VOYAGE_API_KEY=$VOYAGE_API_KEY")
[[ -n "${OPENAI_API_KEY:-}" ]]    && BRAIN_ARGS+=(--from-literal="OPENAI_API_KEY=$OPENAI_API_KEY")
[[ -n "${OLLAMA_ENDPOINTS:-}" ]]  && BRAIN_ARGS+=(--from-literal="OLLAMA_ENDPOINTS=$OLLAMA_ENDPOINTS")
BRAIN_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")
[[ -n "${AGENT_NAME:-}" ]]        && BRAIN_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")
create_secret bakerst-brain-secrets "${BRAIN_ARGS[@]}"

# Worker secrets
WORKER_ARGS=()
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && WORKER_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[[ -n "${DEFAULT_MODEL:-}" ]]     && WORKER_ARGS+=(--from-literal="DEFAULT_MODEL=$DEFAULT_MODEL")
[[ -n "${WORKER_MODEL:-}" ]]      && WORKER_ARGS+=(--from-literal="WORKER_MODEL=$WORKER_MODEL")
[[ -n "${OPENAI_API_KEY:-}" ]]    && WORKER_ARGS+=(--from-literal="OPENAI_API_KEY=$OPENAI_API_KEY")
[[ -n "${OLLAMA_ENDPOINTS:-}" ]]  && WORKER_ARGS+=(--from-literal="OLLAMA_ENDPOINTS=$OLLAMA_ENDPOINTS")
[[ -n "${AGENT_NAME:-}" ]]        && WORKER_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")
create_secret bakerst-worker-secrets "${WORKER_ARGS[@]}"

# Gateway secrets
GATEWAY_ARGS=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]          && GATEWAY_ARGS+=(--from-literal="TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN")
[[ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]]   && GATEWAY_ARGS+=(--from-literal="TELEGRAM_ALLOWED_CHAT_IDS=$TELEGRAM_ALLOWED_CHAT_IDS")
[[ -n "${DISCORD_BOT_TOKEN:-}" ]]           && GATEWAY_ARGS+=(--from-literal="DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN")
[[ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]] && GATEWAY_ARGS+=(--from-literal="DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_ALLOWED_CHANNEL_IDS")
create_secret bakerst-gateway-secrets "${GATEWAY_ARGS[@]}"

# Optional extension secrets
[[ -n "${GITHUB_TOKEN:-}" ]] && \
  create_secret bakerst-github-secrets --from-literal="GITHUB_TOKEN=$GITHUB_TOKEN"

if [[ -n "${GOOGLE_OAUTH_CLIENT_ID:-}" && -n "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]; then
  create_secret bakerst-google-secrets \
    --from-literal="GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID" \
    --from-literal="GOOGLE_OAUTH_CLIENT_SECRET=$GOOGLE_OAUTH_CLIENT_SECRET"
fi

if [[ -n "${GOOGLE_CREDENTIAL_FILE:-}" && -f "${GOOGLE_CREDENTIAL_FILE}" ]]; then
  info "Creating bakerst-google-cred-file"
  kubectl create secret generic bakerst-google-cred-file \
    --from-file="${GOOGLE_CREDENTIAL_FILE}" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
fi

# --- ConfigMap & manifests ---
step "Creating configmap from operating_system/..."
kubectl create configmap bakerst-os \
  --from-file="$REPO_ROOT/operating_system/" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

step "Applying Kubernetes manifests..."
if [[ "$USE_DEV" == true ]]; then
  info "Using dev overlay"
  kubectl apply -f "$REPO_ROOT/k8s/network-policies.yaml" -n "$NAMESPACE"
  kubectl apply -k "$REPO_ROOT/k8s/overlays/dev/"
else
  kubectl apply -k "$REPO_ROOT/k8s/"
fi

# Scale gateway to 0 if no adapters
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  info "No gateway adapters configured -- scaling gateway to 0"
  kubectl scale deployment/gateway -n "$NAMESPACE" --replicas=0 2>/dev/null || true
fi

# --- Extensions ---
if [[ "$SKIP_EXTENSIONS" == false && -d "$REPO_ROOT/examples" ]]; then
  step "Deploying extensions..."
  for ext_dir in "$REPO_ROOT/examples"/*/; do
    ext_name=$(basename "$ext_dir")
    k8s_dir="${ext_dir}k8s"

    # Skip deprecated standalone extensions
    [[ "$ext_name" == "extension-utilities" || "$ext_name" == "extension-github" ]] && continue
    [[ "$ext_name" == "extension-obsidian" && -z "${OBSIDIAN_VAULT_PATH:-}" ]] && continue
    [[ "$ext_name" == "extension-google-workspace" && -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ]] && continue

    if [[ -d "$k8s_dir" ]]; then
      info "Applying ${ext_name}..."
      kubectl apply -f "$k8s_dir/" -n "$NAMESPACE"
    fi
  done
fi

# --- Telemetry ---
if [[ "$SKIP_TELEMETRY" == false ]]; then
  step "Deploying telemetry stack..."
  kubectl apply -k "$REPO_ROOT/k8s/telemetry/" 2>/dev/null || warn "Telemetry manifests not found, skipping."
fi

# ── 7. Verify rollouts ──────────────────────────────────────────────────
step "Waiting for rollouts..."

FAILED=()
for deploy in nats qdrant brain-blue worker ui; do
  echo -n "    ${deploy}... "
  if kubectl rollout status "deployment/${deploy}" -n "$NAMESPACE" --timeout=120s &>/dev/null; then
    echo -e "${GREEN}ready${NC}"
  else
    echo -e "${RED}failed${NC}"
    FAILED+=("$deploy")
  fi
done

# ── 8. Summary ───────────────────────────────────────────────────────────
banner "Deploy Complete"

kubectl get pods -n "$NAMESPACE" --no-headers | while read -r line; do info "$line"; done
echo ""

[[ ${#FAILED[@]} -gt 0 ]] && warn "Deployments not ready: ${FAILED[*]}"

echo -e "${BOLD}  Configuration:${NC}"
info "Version:    ${VERSION}"
info "Mode:       $(if [[ "$USE_DEV" == true ]]; then echo "dev"; else echo "production"; fi)"
info "Anthropic:  $(if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then echo "configured"; else echo "not set"; fi)"
info "Ollama:     $(if [[ -n "${OLLAMA_ENDPOINTS:-}" ]]; then echo "${OLLAMA_ENDPOINTS}"; else echo "not set"; fi)"
info "Agent:      ${AGENT_NAME:-Baker}"
info "Auth token: ****${AUTH_TOKEN: -4}"
echo ""
echo -e "${BOLD}  Access:${NC}"
info "UI:         http://localhost:30080"
info "Brain API:  http://localhost:30000"
echo ""
