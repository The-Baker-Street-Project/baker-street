#!/usr/bin/env bash
# ============================================================
# Baker Street Installer — Scenario Test Runner
# ============================================================
# Downloads the installer from GHCR (or uses a local binary),
# runs each scenario YAML sequentially, validates the deployment,
# tears down the namespace, and moves to the next.
#
# Usage:
#   ./run-scenarios.sh                          # Run all scenarios, latest release
#   ./run-scenarios.sh scenario-anthropic.yaml  # Run one scenario
#   ./run-scenarios.sh --version 0.6.0          # Pin release version
#   ./run-scenarios.sh --binary ./bakerst-install  # Use local binary
#   ./run-scenarios.sh --skip-download          # Reuse previously downloaded binary
#
# Exit codes:
#   0 = all scenarios passed
#   1 = one or more scenarios failed
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="The-Baker-Street-Project/baker-street"
BINARY_NAME="bakerst-install"
TMPDIR="${TMPDIR:-/tmp}"
RESULTS_DIR="${SCRIPT_DIR}/results-$(date +%Y%m%d-%H%M%S)"

# --- Defaults ---
VERSION="latest"
BINARY=""
SKIP_DOWNLOAD=false
SCENARIOS=()

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    VERSION="$2"; shift 2 ;;
    --binary)     BINARY="$2"; shift 2 ;;
    --skip-download) SKIP_DOWNLOAD=true; shift ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS] [scenario.yaml ...]"
      echo ""
      echo "Options:"
      echo "  --version <ver>    Pin to specific release (default: latest)"
      echo "  --binary <path>    Use a local installer binary (skip download)"
      echo "  --skip-download    Reuse previously downloaded binary in /tmp"
      echo "  -h, --help         Show this help"
      exit 0
      ;;
    *.yaml)       SCENARIOS+=("$1"); shift ;;
    *)            echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# If no scenarios specified, run all YAML files in the directory
if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
  for f in "${SCRIPT_DIR}"/scenario-*.yaml; do
    [[ -f "$f" ]] && SCENARIOS+=("$(basename "$f")")
  done
fi

if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
  echo "No scenario files found in ${SCRIPT_DIR}/"
  echo "Copy from README.md template or create scenario-*.yaml files."
  exit 1
fi

# --- Platform detection ---
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${os}-${arch}" in
    linux-x86_64)  echo "linux-amd64" ;;
    darwin-arm64)  echo "darwin-arm64" ;;
    darwin-x86_64) echo "darwin-amd64" ;;
    *)             echo ""; return 1 ;;
  esac
}

# --- Download installer ---
download_installer() {
  local platform asset url dest
  platform=$(detect_platform) || { echo "Unsupported platform: $(uname -s)-$(uname -m)"; exit 1; }
  asset="${BINARY_NAME}-${platform}"
  dest="${TMPDIR}/${BINARY_NAME}"

  if [[ "$SKIP_DOWNLOAD" == "true" && -x "$dest" ]]; then
    echo "Reusing existing binary: ${dest}"
    BINARY="$dest"
    return
  fi

  if [[ "$VERSION" == "latest" ]]; then
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    VERSION="${VERSION#v}"
    url="https://github.com/${REPO}/releases/download/v${VERSION}/${asset}"
  fi

  echo "Downloading ${asset} (${VERSION})..."
  curl -fsSL "$url" -o "$dest"
  chmod +x "$dest"
  echo "Downloaded to ${dest} ($(du -h "$dest" | cut -f1))"
  BINARY="$dest"
}

# --- Extra verification beyond installer's built-in checks ---
run_extra_checks() {
  local ns="$1"
  local config_file="$2"
  local checks_passed=0
  local checks_failed=0

  echo "  Running extra verification..."

  # Check 1: Verify model configuration on brain pod
  local expected_model
  expected_model=$(grep -E '^\s+DEFAULT_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_model" && "$expected_model" != '${'* ]]; then
    local actual_model
    actual_model=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv DEFAULT_MODEL 2>/dev/null || echo "")
    if [[ "$actual_model" == "$expected_model" ]]; then
      echo "    [PASS] Agent model: ${actual_model}"
      ((checks_passed++))
    else
      echo "    [FAIL] Agent model: expected '${expected_model}', got '${actual_model}'"
      ((checks_failed++))
    fi
  fi

  # Check 2: Verify worker model
  local expected_worker
  expected_worker=$(grep -E '^\s+WORKER_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_worker" && "$expected_worker" != '${'* ]]; then
    local actual_worker
    actual_worker=$(kubectl exec -n "$ns" deploy/worker -- printenv WORKER_MODEL 2>/dev/null || echo "")
    if [[ "$actual_worker" == "$expected_worker" ]]; then
      echo "    [PASS] Worker model: ${actual_worker}"
      ((checks_passed++))
    else
      echo "    [FAIL] Worker model: expected '${expected_worker}', got '${actual_worker}'"
      ((checks_failed++))
    fi
  fi

  # Check 3: Verify observer model
  local expected_observer
  expected_observer=$(grep -E '^\s+OBSERVER_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_observer" && "$expected_observer" != '${'* ]]; then
    local actual_observer
    actual_observer=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv OBSERVER_MODEL 2>/dev/null || echo "")
    if [[ "$actual_observer" == "$expected_observer" ]]; then
      echo "    [PASS] Observer model: ${actual_observer}"
      ((checks_passed++))
    else
      echo "    [FAIL] Observer model: expected '${expected_observer}', got '${actual_observer}'"
      ((checks_failed++))
    fi
  fi

  # Check 4: Verify reflector model
  local expected_reflector
  expected_reflector=$(grep -E '^\s+REFLECTOR_MODEL:' "$config_file" | head -1 | sed 's/.*: *"\?\([^"]*\)"\?/\1/' | xargs)
  if [[ -n "$expected_reflector" && "$expected_reflector" != '${'* ]]; then
    local actual_reflector
    actual_reflector=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv REFLECTOR_MODEL 2>/dev/null || echo "")
    if [[ "$actual_reflector" == "$expected_reflector" ]]; then
      echo "    [PASS] Reflector model: ${actual_reflector}"
      ((checks_passed++))
    else
      echo "    [FAIL] Reflector model: expected '${expected_reflector}', got '${actual_reflector}'"
      ((checks_failed++))
    fi
  fi

  # Check 5: UI serves on NodePort 30080
  local ui_status
  ui_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:30080/ 2>/dev/null || echo "000")
  if [[ "$ui_status" == "200" || "$ui_status" == "304" ]]; then
    echo "    [PASS] UI responding (HTTP ${ui_status})"
    ((checks_passed++))
  else
    echo "    [FAIL] UI not responding (HTTP ${ui_status})"
    ((checks_failed++))
  fi

  # Check 6: Gateway deployment exists and ready
  local gw_ready
  gw_ready=$(kubectl get deploy/gateway -n "$ns" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  if [[ "$gw_ready" -ge 1 ]]; then
    echo "    [PASS] Gateway ready (${gw_ready} replica(s))"
    ((checks_passed++))
  else
    echo "    [FAIL] Gateway not ready"
    ((checks_failed++))
  fi

  # Check 7: Qdrant health
  local qdrant_ok
  qdrant_ok=$(kubectl exec -n "$ns" deploy/qdrant -- wget -q -O- http://localhost:6333/healthz 2>/dev/null || echo "")
  if [[ -n "$qdrant_ok" ]]; then
    echo "    [PASS] Qdrant healthy"
    ((checks_passed++))
  else
    echo "    [FAIL] Qdrant health check failed"
    ((checks_failed++))
  fi

  # Check 8: Verify OLLAMA_ENDPOINTS doesn't contain localhost (K8s pod can't reach it)
  local ollama_eps
  ollama_eps=$(kubectl exec -n "$ns" deploy/brain-blue -- printenv OLLAMA_ENDPOINTS 2>/dev/null || echo "")
  if [[ -n "$ollama_eps" ]]; then
    if echo "$ollama_eps" | grep -qE '(^|,)localhost[,:]|://localhost'; then
      echo "    [FAIL] OLLAMA_ENDPOINTS contains 'localhost' — pods can't reach host. Use host.docker.internal"
      ((checks_failed++))
    else
      echo "    [PASS] OLLAMA_ENDPOINTS: ${ollama_eps} (no localhost)"
      ((checks_passed++))
    fi
  fi

  echo "  Extra checks: ${checks_passed} passed, ${checks_failed} failed"
  return "$checks_failed"
}

# --- Teardown namespace ---
teardown() {
  local ns="$1"
  echo "  Tearing down namespace '${ns}'..."
  kubectl delete namespace "$ns" --wait=false 2>/dev/null || true
  # Wait for namespace to actually disappear (max 120s)
  local waited=0
  while kubectl get namespace "$ns" &>/dev/null && [[ $waited -lt 120 ]]; do
    sleep 5
    waited=$((waited + 5))
  done
  if kubectl get namespace "$ns" &>/dev/null; then
    echo "  WARNING: Namespace '${ns}' still terminating after 120s"
  else
    echo "  Namespace '${ns}' deleted"
  fi
}

# --- Main ---
if [[ -z "$BINARY" ]]; then
  download_installer
fi

# Verify binary works
"$BINARY" --version 2>/dev/null || { echo "Binary not executable or missing: $BINARY"; exit 1; }

mkdir -p "$RESULTS_DIR"

echo ""
echo "========================================"
echo "Baker Street Installer Scenario Runner"
echo "========================================"
echo "Binary:    ${BINARY}"
echo "Scenarios: ${#SCENARIOS[@]}"
echo "Results:   ${RESULTS_DIR}"
echo "========================================"
echo ""

PASSED=0
FAILED=0
SKIPPED=0
RESULTS=()

for scenario_file in "${SCENARIOS[@]}"; do
  # Resolve to full path
  if [[ ! -f "$scenario_file" ]]; then
    scenario_file="${SCRIPT_DIR}/${scenario_file}"
  fi

  if [[ ! -f "$scenario_file" ]]; then
    echo "[SKIP] ${scenario_file} — file not found"
    ((SKIPPED++))
    RESULTS+=("SKIP  $(basename "$scenario_file")  (not found)")
    continue
  fi

  scenario_name=$(basename "$scenario_file" .yaml)
  log_file="${RESULTS_DIR}/${scenario_name}.log"

  # Extract namespace from scenario file
  ns=$(grep -E '^namespace:' "$scenario_file" | head -1 | awk '{print $2}' | tr -d '"' || echo "bakerst-test")

  echo "──────────────────────────────────────"
  echo "[RUN]  ${scenario_name}"
  echo "       Config:    ${scenario_file}"
  echo "       Namespace: ${ns}"
  echo "──────────────────────────────────────"

  # Ensure clean slate — delete namespace if it exists from a previous run
  if kubectl get namespace "$ns" &>/dev/null; then
    echo "  Cleaning up existing namespace '${ns}'..."
    teardown "$ns"
  fi

  # Run installer
  scenario_start=$(date +%s)
  install_ok=true

  echo "  Installing..."
  if "$BINARY" install --config "$scenario_file" --log "${RESULTS_DIR}/${scenario_name}-install.json" 2>&1 | tee "$log_file"; then
    echo "  Installer exited 0"
  else
    echo "  Installer FAILED (exit $?)"
    install_ok=false
  fi

  scenario_end=$(date +%s)
  elapsed=$((scenario_end - scenario_start))

  if [[ "$install_ok" == "true" ]]; then
    # Run extra checks
    extra_failures=0
    run_extra_checks "$ns" "$scenario_file" || extra_failures=$?

    if [[ $extra_failures -eq 0 ]]; then
      echo "[PASS] ${scenario_name}  (${elapsed}s)"
      ((PASSED++))
      RESULTS+=("PASS  ${scenario_name}  (${elapsed}s)")
    else
      echo "[FAIL] ${scenario_name}  (${elapsed}s) — ${extra_failures} extra check(s) failed"
      ((FAILED++))
      RESULTS+=("FAIL  ${scenario_name}  (${elapsed}s) — ${extra_failures} extra check(s) failed")
    fi
  else
    echo "[FAIL] ${scenario_name}  (${elapsed}s) — installer failed"
    ((FAILED++))
    RESULTS+=("FAIL  ${scenario_name}  (${elapsed}s) — installer failed")
  fi

  # Teardown
  teardown "$ns"

  echo ""
done

# --- Summary ---
echo "========================================"
echo "SUMMARY"
echo "========================================"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "Passed: ${PASSED}  Failed: ${FAILED}  Skipped: ${SKIPPED}"
echo "Results saved to: ${RESULTS_DIR}/"
echo "========================================"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
