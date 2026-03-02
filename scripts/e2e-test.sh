#!/usr/bin/env bash
# Baker Street E2E Installer Test
# Usage: ./scripts/e2e-test.sh <minimal|full> [--keep]
#
# Environment variables (real credentials):
#   E2E_ANTHROPIC_OAUTH_TOKEN  (required)
#   E2E_VOYAGE_API_KEY         (optional, needed for full)
#   E2E_GITHUB_TOKEN           (optional, needed for full)
#   E2E_PERPLEXITY_API_KEY     (optional, needed for full)
#   E2E_TELEGRAM_BOT_TOKEN     (optional, needed for full)
#
# Flags:
#   --keep    Don't uninstall after test (useful for debugging)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="${REPO_ROOT}/tools/installer/target/release/bakerst-install"
NAMESPACE="bakerst-e2e"
BRAIN_PORT=13000

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCENARIO="${1:-}"
KEEP_INSTALL=false
if [[ "${2:-}" == "--keep" ]]; then KEEP_INSTALL=true; fi

if [[ -z "$SCENARIO" ]]; then
  echo -e "${RED}Usage: $0 <minimal|full> [--keep]${NC}"
  exit 1
fi

CONFIG_FILE="${REPO_ROOT}/tools/installer/tests/e2e/${SCENARIO}.yaml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo -e "${RED}Config not found: ${CONFIG_FILE}${NC}"
  exit 1
fi

# --- Logging helpers ---
pass() { echo -e "  ${GREEN}✓ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}→ $1${NC}"; }
section() { echo -e "\n${YELLOW}[$1]${NC} $2"; }

FAILURES=0
PIDS_TO_KILL=()

cleanup() {
  for pid in "${PIDS_TO_KILL[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ "$KEEP_INSTALL" == "false" && "$FAILURES" -eq 0 ]]; then
    section "CLEANUP" "Uninstalling..."
    "$INSTALLER" --uninstall --non-interactive --namespace "$NAMESPACE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Phase 0: Prerequisites ---
section "0/7" "Prerequisites"

if [[ ! -x "$INSTALLER" ]]; then
  echo -e "${RED}Installer not found. Run: cd tools/installer && cargo build --release${NC}"
  exit 1
fi
pass "Installer binary exists"

if ! kubectl cluster-info &>/dev/null; then
  echo -e "${RED}No Kubernetes cluster available${NC}"
  exit 1
fi
pass "Kubernetes cluster reachable"

if [[ -z "${E2E_ANTHROPIC_OAUTH_TOKEN:-}" ]]; then
  echo -e "${RED}E2E_ANTHROPIC_OAUTH_TOKEN must be set${NC}"
  exit 1
fi
pass "Anthropic token set"

# --- Phase 1: Resolve config template ---
section "1/7" "Preparing config"

# Substitute env vars in the YAML template
RESOLVED_CONFIG=$(mktemp /tmp/e2e-config-XXXXXX.yaml)
envsubst < "$CONFIG_FILE" > "$RESOLVED_CONFIG"
info "Resolved config to $RESOLVED_CONFIG"

# Verify no unresolved placeholders remain
if grep -q '${E2E_' "$RESOLVED_CONFIG"; then
  MISSING=$(grep -o '\${E2E_[A-Z_]*}' "$RESOLVED_CONFIG" | sort -u | tr '\n' ', ')
  echo -e "${YELLOW}WARNING: Unresolved env vars: ${MISSING}${NC}"
  echo -e "${YELLOW}Features requiring these will be skipped${NC}"
  # Remove lines with unresolved vars (feature won't be enabled)
  sed -i '/\${E2E_/d' "$RESOLVED_CONFIG"
fi
pass "Config resolved"

# --- Phase 2: Uninstall previous ---
section "2/7" "Clean slate"

if kubectl get namespace "$NAMESPACE" &>/dev/null; then
  info "Deleting existing namespace $NAMESPACE..."
  "$INSTALLER" --uninstall --non-interactive --namespace "$NAMESPACE" 2>/dev/null || true
  # Wait for namespace deletion
  for i in $(seq 1 60); do
    if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then break; fi
    sleep 2
  done
  pass "Previous install removed"
else
  pass "No previous install found"
fi

# --- Phase 3: Install ---
section "3/7" "Installing (${SCENARIO})"

INSTALL_LOG=$(mktemp /tmp/e2e-install-XXXXXX.log)
info "Running installer with --config $RESOLVED_CONFIG"
info "Log: $INSTALL_LOG"

"$INSTALLER" --config "$RESOLVED_CONFIG" --namespace "$NAMESPACE" 2>&1 | tee "$INSTALL_LOG"
INSTALL_EXIT=${PIPESTATUS[0]}

if [[ $INSTALL_EXIT -ne 0 ]]; then
  fail "Installer exited with code $INSTALL_EXIT"
  echo -e "${RED}Install log:${NC}"
  cat "$INSTALL_LOG"
  exit 1
fi
pass "Installer completed successfully"

# Extract auth token from installer output
AUTH_TOKEN=$(grep -oP 'Auth Token: \K.*' "$INSTALL_LOG" || true)
if [[ -z "$AUTH_TOKEN" ]]; then
  fail "Could not extract AUTH_TOKEN from installer output"
  exit 1
fi
pass "Auth token extracted"

# --- Phase 4: Wait for pods ---
section "4/7" "Waiting for pods"

# Read expected pods from the resolved config
EXPECTED_PODS=$(python3 -c "
import yaml, sys
with open('$RESOLVED_CONFIG') as f:
    c = yaml.safe_load(f)
for p in c.get('verify', {}).get('expected_pods', []):
    print(p)
" 2>/dev/null || echo "brain worker gateway ui nats qdrant")

MAX_WAIT=300
ELAPSED=0
ALL_READY=false

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  ALL_READY=true
  for pod_prefix in $EXPECTED_PODS; do
    POD_STATUS=$(kubectl -n "$NAMESPACE" get pods -l "app=$pod_prefix" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "NotFound")
    if [[ "$POD_STATUS" != "Running" ]]; then
      ALL_READY=false
      break
    fi
  done
  if $ALL_READY; then break; fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

if $ALL_READY; then
  pass "All expected pods running ($ELAPSED s)"
else
  fail "Not all pods ready after ${MAX_WAIT}s"
  kubectl -n "$NAMESPACE" get pods
fi

# --- Phase 5: Port-forward & API verification ---
section "5/7" "API verification"

# Port-forward brain
kubectl -n "$NAMESPACE" port-forward svc/brain "$BRAIN_PORT":3000 &>/dev/null &
PIDS_TO_KILL+=($!)
sleep 3

# Brain /ping
PING_RESP=$(curl -sf "http://localhost:${BRAIN_PORT}/ping" 2>/dev/null || echo "FAIL")
if echo "$PING_RESP" | grep -q '"status"'; then
  pass "Brain /ping responds"
else
  fail "Brain /ping failed: $PING_RESP"
fi

# Brain /ping features check
if [[ "$PING_RESP" != "FAIL" ]]; then
  FEATURES=$(echo "$PING_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('features',{})))" 2>/dev/null || echo "{}")
  info "Brain features: $FEATURES"
  pass "Brain features retrieved"
fi

# Authenticated brain /chat test
CHAT_RESP=$(curl -sf -X POST "http://localhost:${BRAIN_PORT}/chat" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello, what is your name?"}' 2>/dev/null || echo "FAIL")

if [[ "$CHAT_RESP" != "FAIL" ]] && echo "$CHAT_RESP" | grep -qi "baker\|hello\|assist"; then
  pass "Brain /chat responds to greeting"
else
  fail "Brain /chat failed or unexpected response"
  info "Response: $(echo "$CHAT_RESP" | head -c 500)"
fi

# --- Phase 6: Capability verification via chat ---
section "6/7" "Capability verification"

# Read chat_prompt and expected_capabilities from config
CHAT_PROMPT=$(python3 -c "
import yaml
with open('$RESOLVED_CONFIG') as f:
    c = yaml.safe_load(f)
print(c.get('verify', {}).get('chat_prompt', 'What are your capabilities?'))
" 2>/dev/null || echo "What are your capabilities?")

EXPECTED_CAPS=$(python3 -c "
import yaml
with open('$RESOLVED_CONFIG') as f:
    c = yaml.safe_load(f)
for cap in c.get('verify', {}).get('expected_capabilities', []):
    print(cap)
" 2>/dev/null || echo "")

info "Asking: $CHAT_PROMPT"

CAP_RESP=$(curl -sf -X POST "http://localhost:${BRAIN_PORT}/chat" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"$CHAT_PROMPT\"}" 2>/dev/null || echo "FAIL")

if [[ "$CAP_RESP" == "FAIL" ]]; then
  fail "Capability chat request failed"
else
  # Extract the response text
  RESP_TEXT=$(echo "$CAP_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',''))" 2>/dev/null || echo "$CAP_RESP")
  info "Response (first 500 chars): $(echo "$RESP_TEXT" | head -c 500)"

  if [[ -z "$EXPECTED_CAPS" ]]; then
    pass "No specific capabilities to verify (minimal install)"
  else
    for cap in $EXPECTED_CAPS; do
      if echo "$RESP_TEXT" | grep -qi "$cap"; then
        pass "Capability mentioned: $cap"
      else
        fail "Capability NOT mentioned: $cap"
      fi
    done
  fi
fi

# --- Phase 7: Results ---
section "7/7" "Results"

echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}═══════════════════════════════════════${NC}"
  echo -e "${GREEN}  E2E TEST PASSED (${SCENARIO})${NC}"
  echo -e "${GREEN}═══════════════════════════════════════${NC}"
else
  echo -e "${RED}═══════════════════════════════════════${NC}"
  echo -e "${RED}  E2E TEST FAILED: ${FAILURES} failure(s) (${SCENARIO})${NC}"
  echo -e "${RED}═══════════════════════════════════════${NC}"
  echo -e "\nNamespace preserved for debugging: $NAMESPACE"
  KEEP_INSTALL=true
fi

exit $FAILURES
