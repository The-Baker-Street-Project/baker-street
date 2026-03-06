#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# install.sh — Deploy Baker Street with secrets pulled from Vaultwarden
#
# Usage:
#   install.sh --<instance> [deploy-all.sh options...]
#
# Examples:
#   install.sh --Irene                    # Full interactive deploy
#   install.sh --Irene -y                 # Non-interactive deploy
#   install.sh --Irene --skip-build       # Secrets + deploy only
#   install.sh --Irene-Dev --dev          # Dev instance
#
# The instance name maps to a vault path: project/baker-street/<instance>/*
# All matching secrets are exported as env vars for the duration of the deploy.
#
# Prerequisites:
#   - bw (Bitwarden CLI) installed and configured
#   - jq installed
#   - Vault unlocked: export BW_SESSION=$(bw unlock --raw)
###############################################################################

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Parse arguments — extract --<Instance> flag, pass rest to deploy-all.sh
# ---------------------------------------------------------------------------
INSTANCE=""
DEPLOY_ARGS=()

for arg in "$@"; do
  if [[ -z "$INSTANCE" && "$arg" =~ ^--[A-Z] ]]; then
    INSTANCE="${arg#--}"
  else
    DEPLOY_ARGS+=("$arg")
  fi
done

if [[ -z "$INSTANCE" ]]; then
  echo -e "${BOLD}Usage:${NC} install.sh --<Instance> [deploy-all.sh options...]"
  echo ""
  echo "Instance name maps to vault path: project/baker-street/<Instance>/*"
  echo ""
  echo "Examples:"
  echo "  install.sh --Irene"
  echo "  install.sh --Irene-Dev --dev"
  exit 1
fi

VAULT_PREFIX="project/baker-street/${INSTANCE}"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v bw &>/dev/null; then
  # Try snap location
  if [[ -x /snap/bin/bw ]]; then
    BW=/snap/bin/bw
  else
    error "bw (Bitwarden CLI) is not installed."
    exit 1
  fi
else
  BW=$(command -v bw)
fi

if ! command -v jq &>/dev/null; then
  error "jq is not installed."
  exit 1
fi

# Handle self-hosted Vaultwarden TLS
export NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"

# Check vault is unlocked
BW_STATUS=$($BW status 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown")
if [[ "$BW_STATUS" != "unlocked" ]]; then
  error "Bitwarden vault is ${BW_STATUS}. Run: export BW_SESSION=\$(bw unlock --raw)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Pull secrets from vault
# ---------------------------------------------------------------------------
info "Pulling secrets from vault: ${CYAN}${VAULT_PREFIX}/*${NC}"

# Search for items matching our project path
ITEMS=$($BW list items --search "baker-street" 2>/dev/null)

# Extract fields matching our prefix as base64-encoded JSON objects
# (base64 avoids issues with special chars, newlines, tabs in JSON values)
FIELD_COUNT=$(echo "$ITEMS" | jq --arg prefix "$VAULT_PREFIX/" '
  [.[] | .fields[]? | select(.name | startswith($prefix))] | length
')

if [[ "$FIELD_COUNT" -eq 0 ]]; then
  error "No secrets found matching ${VAULT_PREFIX}/*"
  error "Expected vault item with fields like: ${VAULT_PREFIX}/ANTHROPIC_API_KEY"
  exit 1
fi

FIELD_ENTRIES=$(echo "$ITEMS" | jq -r --arg prefix "$VAULT_PREFIX/" '
  [.[] | .fields[]? | select(.name | startswith($prefix))] |
  .[] | {name: .name, value: .value} | @base64
')

# ---------------------------------------------------------------------------
# Export secrets as env vars + handle JSON file fields
# ---------------------------------------------------------------------------
EXPORTED_VARS=()
TEMP_FILES=()

cleanup() {
  # Unset exported vars
  for var in "${EXPORTED_VARS[@]}"; do
    unset "$var" 2>/dev/null || true
  done
  # Remove temp files
  for f in "${TEMP_FILES[@]}"; do
    rm -f "$f" 2>/dev/null || true
  done
  if [[ ${#TEMP_FILES[@]} -gt 0 ]]; then
    info "Cleaned up ${#TEMP_FILES[@]} temp file(s)"
  fi
}
trap cleanup EXIT

# Fields ending in _JSON are written to temp files
# The env var name has _JSON stripped and _FILE appended
# e.g., GOOGLE_CLIENT_SECRET_JSON → GOOGLE_CLIENT_SECRET_FILE (pointing to temp file)
#
# Special case: GOOGLE_OAUTH_TOKEN_JSON → GOOGLE_CREDENTIAL_FILE
# (this is the pre-authorized token that deploy-all.sh expects)

for entry in $FIELD_ENTRIES; do
  field_name=$(echo "$entry" | base64 -d | jq -r '.name')
  field_value=$(echo "$entry" | base64 -d | jq -r '.value')

  # Strip prefix to get bare var name
  var_name="${field_name#"${VAULT_PREFIX}/"}"

  if [[ "$var_name" == *_JSON ]]; then
    # Write JSON to temp file
    tmp=$(mktemp "/tmp/bw-${INSTANCE}-XXXXXX.json")
    echo "$field_value" > "$tmp"
    chmod 600 "$tmp"
    TEMP_FILES+=("$tmp")

    if [[ "$var_name" == "GOOGLE_OAUTH_TOKEN_JSON" ]]; then
      export GOOGLE_CREDENTIAL_FILE="$tmp"
      EXPORTED_VARS+=("GOOGLE_CREDENTIAL_FILE")
      info "  ${CYAN}GOOGLE_CREDENTIAL_FILE${NC} → ${tmp} (from ${var_name})"
    elif [[ "$var_name" == "GOOGLE_CLIENT_SECRET_JSON" ]]; then
      # Client secret file — not directly used by deploy-all.sh
      # but kept as a temp file in case needed
      info "  ${CYAN}${var_name}${NC} → ${tmp} (temp file, reference only)"
    else
      file_var="${var_name%_JSON}_FILE"
      export "$file_var"="$tmp"
      EXPORTED_VARS+=("$file_var")
      info "  ${CYAN}${file_var}${NC} → ${tmp} (from ${var_name})"
    fi
  else
    export "$var_name"="$field_value"
    EXPORTED_VARS+=("$var_name")
    info "  ${CYAN}${var_name}${NC} ✓"
  fi
done

echo ""
info "Exported ${#EXPORTED_VARS[@]} secret(s) for instance ${BOLD}${INSTANCE}${NC}"
echo ""

# ---------------------------------------------------------------------------
# Run deploy-all.sh
# ---------------------------------------------------------------------------
info "Running: scripts/deploy-all.sh ${DEPLOY_ARGS[*]:-}"
echo ""

"${REPO_ROOT}/scripts/deploy-all.sh" "${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}"

echo ""
info "Deploy complete. Secrets cleaned up on exit."
