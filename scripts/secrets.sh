#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Auto-source .env-secrets if it exists
if [ -f "$REPO_ROOT/.env-secrets" ]; then
  echo "==> Loading .env-secrets"
  set -a
  . "$REPO_ROOT/.env-secrets"
  set +a
fi

# Auto-generate AUTH_TOKEN if not set
if [ -z "${AUTH_TOKEN:-}" ]; then
  AUTH_TOKEN="$(openssl rand -hex 32)"
  echo "==> Generated new AUTH_TOKEN"
  # Persist to .env-secrets so it survives across runs
  if [ -f "$REPO_ROOT/.env-secrets" ]; then
    echo "" >> "$REPO_ROOT/.env-secrets"
    echo "AUTH_TOKEN=$AUTH_TOKEN" >> "$REPO_ROOT/.env-secrets"
  else
    echo "AUTH_TOKEN=$AUTH_TOKEN" > "$REPO_ROOT/.env-secrets"
  fi
  echo "==> AUTH_TOKEN appended to .env-secrets"
else
  echo "==> Using existing AUTH_TOKEN"
fi

# Ensure namespace exists
kubectl apply -f "$REPO_ROOT/k8s/namespace.yaml"

# --- Brain secrets ---
# Needs: ANTHROPIC_*, VOYAGE_API_KEY, AUTH_TOKEN

BRAIN_ARGS=()

if [ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]; then
  BRAIN_ARGS+=(--from-literal="ANTHROPIC_OAUTH_TOKEN=$ANTHROPIC_OAUTH_TOKEN")
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  BRAIN_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
fi
if [ -n "${VOYAGE_API_KEY:-}" ]; then
  BRAIN_ARGS+=(--from-literal="VOYAGE_API_KEY=$VOYAGE_API_KEY")
fi
BRAIN_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")
if [ -n "${AGENT_NAME:-}" ]; then
  BRAIN_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")
fi

if [ ${#BRAIN_ARGS[@]} -lt 2 ]; then
  echo "Error: set ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY environment variable"
  exit 1
fi

echo "==> Creating bakerst-brain-secrets"
kubectl create secret generic bakerst-brain-secrets \
  "${BRAIN_ARGS[@]}" \
  -n bakerst \
  --dry-run=client -o yaml | kubectl apply -f -

# --- Worker secrets ---
# Needs: ANTHROPIC_*

WORKER_ARGS=()

if [ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]; then
  WORKER_ARGS+=(--from-literal="ANTHROPIC_OAUTH_TOKEN=$ANTHROPIC_OAUTH_TOKEN")
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  WORKER_ARGS+=(--from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
fi

if [ -n "${AGENT_NAME:-}" ]; then
  WORKER_ARGS+=(--from-literal="AGENT_NAME=$AGENT_NAME")
fi

if [ ${#WORKER_ARGS[@]} -eq 0 ]; then
  echo "Warning: no Anthropic keys for worker secret"
else
  echo "==> Creating bakerst-worker-secrets"
  kubectl create secret generic bakerst-worker-secrets \
    "${WORKER_ARGS[@]}" \
    -n bakerst \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# --- Gateway secrets ---
# Needs: TELEGRAM_*, DISCORD_*, AUTH_TOKEN

GATEWAY_ARGS=()

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  GATEWAY_ARGS+=(--from-literal="TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN")
fi
if [ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]; then
  GATEWAY_ARGS+=(--from-literal="TELEGRAM_ALLOWED_CHAT_IDS=$TELEGRAM_ALLOWED_CHAT_IDS")
fi
if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  GATEWAY_ARGS+=(--from-literal="DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN")
fi
if [ -n "${DISCORD_ALLOWED_CHANNEL_IDS:-}" ]; then
  GATEWAY_ARGS+=(--from-literal="DISCORD_ALLOWED_CHANNEL_IDS=$DISCORD_ALLOWED_CHANNEL_IDS")
fi
GATEWAY_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")

echo "==> Creating bakerst-gateway-secrets"
kubectl create secret generic bakerst-gateway-secrets \
  "${GATEWAY_ARGS[@]}" \
  -n bakerst \
  --dry-run=client -o yaml | kubectl apply -f -

# --- Voice secrets ---
# Needs: AUTH_TOKEN, optional OPENAI_API_KEY, ELEVENLABS_API_KEY for cloud STT/TTS

VOICE_ARGS=()
VOICE_ARGS+=(--from-literal="AUTH_TOKEN=$AUTH_TOKEN")

if [ -n "${OPENAI_API_KEY:-}" ]; then
  VOICE_ARGS+=(--from-literal="STT_API_KEY=$OPENAI_API_KEY")
  VOICE_ARGS+=(--from-literal="TTS_API_KEY=$OPENAI_API_KEY")
elif [ -n "${STT_API_KEY:-}" ]; then
  VOICE_ARGS+=(--from-literal="STT_API_KEY=$STT_API_KEY")
fi

if [ -n "${TTS_API_KEY:-}" ]; then
  # Explicit TTS_API_KEY overrides the OPENAI_API_KEY fallback for TTS
  VOICE_ARGS+=(--from-literal="TTS_API_KEY=$TTS_API_KEY")
elif [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  VOICE_ARGS+=(--from-literal="TTS_API_KEY=$ELEVENLABS_API_KEY")
fi

echo "==> Creating bakerst-voice-secrets"
kubectl create secret generic bakerst-voice-secrets \
  "${VOICE_ARGS[@]}" \
  -n bakerst \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> All scoped secrets created/updated in namespace bakerst"
