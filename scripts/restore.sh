#!/usr/bin/env bash
# scripts/restore.sh — Restore Baker Street from a backup directory
set -euo pipefail

BACKUP_DIR="${1:?Usage: restore.sh <backup-directory>}"
NAMESPACE="${NAMESPACE:-bakerst}"

if [ ! -d "${BACKUP_DIR}" ]; then
  echo "Error: backup directory not found: ${BACKUP_DIR}"
  exit 1
fi

echo "=== Baker Street Restore ==="
echo "Source: ${BACKUP_DIR}"
echo "Namespace: ${NAMESPACE}"
echo ""

# Verify backup contents
if [ ! -f "${BACKUP_DIR}/bakerst.db" ] && [ ! -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ]; then
  echo "Error: no backup files found in ${BACKUP_DIR}"
  echo "Expected: bakerst.db and/or qdrant-bakerst_memories.snapshot"
  exit 1
fi

echo "Found:"
[ -f "${BACKUP_DIR}/bakerst.db" ] && echo "  - bakerst.db ($(du -h "${BACKUP_DIR}/bakerst.db" | cut -f1))"
[ -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ] && echo "  - qdrant snapshot ($(du -h "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" | cut -f1))"
echo ""

read -p "This will overwrite current state. Continue? [y/N] " confirm
if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# 1. Scale down brain to avoid SQLite corruption
echo "[restore] Scaling down brain..."
kubectl -n "${NAMESPACE}" scale deployment brain-blue --replicas=0 2>/dev/null || true
kubectl -n "${NAMESPACE}" scale deployment brain-green --replicas=0 2>/dev/null || true
kubectl -n "${NAMESPACE}" rollout status deployment/brain-blue --timeout=30s 2>/dev/null || true

# 2. Restore SQLite via a temporary pod
if [ -f "${BACKUP_DIR}/bakerst.db" ]; then
  echo "[restore] Restoring SQLite database..."

  # Create a temporary pod that mounts brain-data PVC
  kubectl -n "${NAMESPACE}" run restore-tmp --image=alpine:3.19 \
    --restart=Never \
    --overrides='{
      "spec": {
        "securityContext": {
          "runAsNonRoot": true,
          "runAsUser": 1000,
          "fsGroup": 1000,
          "seccompProfile": {"type": "RuntimeDefault"}
        },
        "containers": [{
          "name": "restore-tmp",
          "image": "alpine:3.19",
          "command": ["sleep", "300"],
          "volumeMounts": [{"name": "brain-data", "mountPath": "/data"}],
          "securityContext": {
            "allowPrivilegeEscalation": false,
            "capabilities": {"drop": ["ALL"]}
          }
        }],
        "volumes": [{"name": "brain-data", "persistentVolumeClaim": {"claimName": "brain-data"}}]
      }
    }' 2>/dev/null || true

  kubectl -n "${NAMESPACE}" wait --for=condition=Ready pod/restore-tmp --timeout=30s
  kubectl -n "${NAMESPACE}" cp "${BACKUP_DIR}/bakerst.db" restore-tmp:/data/bakerst.db
  kubectl -n "${NAMESPACE}" delete pod restore-tmp --grace-period=0

  echo "[restore] SQLite restored."
fi

# 3. Restore Qdrant snapshot
if [ -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ]; then
  echo "[restore] Restoring Qdrant snapshot..."

  # Port-forward to Qdrant
  kubectl -n "${NAMESPACE}" port-forward svc/qdrant 6333:6333 &
  PF_PID=$!
  sleep 2

  # Upload snapshot
  curl -sf -X POST "http://localhost:6333/collections/bakerst_memories/snapshots/upload" \
    -H "Content-Type: multipart/form-data" \
    -F "snapshot=@${BACKUP_DIR}/qdrant-bakerst_memories.snapshot"

  kill "${PF_PID}" 2>/dev/null || true
  echo "[restore] Qdrant restored."
fi

# 4. Scale brain back up
echo "[restore] Scaling brain back up..."
kubectl -n "${NAMESPACE}" scale deployment brain-blue --replicas=1
kubectl -n "${NAMESPACE}" rollout status deployment/brain-blue --timeout=120s

# 5. Health check
echo "[restore] Verifying health..."
sleep 5
kubectl -n "${NAMESPACE}" get pods -l app=brain

echo ""
echo "=== Restore complete ==="
