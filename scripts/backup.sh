#!/bin/sh
# scripts/backup.sh — Baker Street nightly backup
# Runs inside a minimal alpine container with curl and sqlite3
set -e

BACKUP_ROOT="${BACKUP_PATH:-/backups}"
BRAIN_DATA="${BRAIN_DATA_PATH:-/brain-data}"
QDRANT_HOST="${QDRANT_HOST:-http://qdrant:6333}"
COLLECTION="${QDRANT_COLLECTION:-bakerst_memories}"
RETENTION=${BACKUP_RETENTION:-7}

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

echo "[backup] Starting backup to ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# 1. SQLite backup (safe hot copy via .backup command)
echo "[backup] Backing up SQLite database..."
if [ -f "${BRAIN_DATA}/bakerst.db" ]; then
  sqlite3 "${BRAIN_DATA}/bakerst.db" ".backup '${BACKUP_DIR}/bakerst.db'"
  echo "[backup] SQLite backup complete ($(du -h "${BACKUP_DIR}/bakerst.db" | cut -f1))"
else
  echo "[backup] WARNING: No database found at ${BRAIN_DATA}/bakerst.db"
fi

# 2. Qdrant snapshot
echo "[backup] Creating Qdrant snapshot..."
SNAP_RESPONSE=$(curl -sf -X POST "${QDRANT_HOST}/collections/${COLLECTION}/snapshots" 2>/dev/null || echo "")
if [ -n "${SNAP_RESPONSE}" ]; then
  SNAP_NAME=$(echo "${SNAP_RESPONSE}" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "${SNAP_NAME}" ]; then
    curl -sf "${QDRANT_HOST}/collections/${COLLECTION}/snapshots/${SNAP_NAME}" \
      -o "${BACKUP_DIR}/qdrant-${COLLECTION}.snapshot"
    echo "[backup] Qdrant snapshot saved ($(du -h "${BACKUP_DIR}/qdrant-${COLLECTION}.snapshot" | cut -f1))"
  else
    echo "[backup] WARNING: Could not parse snapshot name from Qdrant response"
  fi
else
  echo "[backup] WARNING: Qdrant snapshot failed (is Qdrant running?)"
fi

# 3. Metadata
cat > "${BACKUP_DIR}/manifest.json" << MANIFEST_EOF
{"timestamp":"${TIMESTAMP}","version":"$(date +%s)"}
MANIFEST_EOF

# 4. Rotate: keep last N backups
echo "[backup] Rotating backups (keeping last ${RETENTION})..."
ls -dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +$((RETENTION + 1)) | while read dir; do
  echo "[backup] Removing old backup: ${dir}"
  rm -rf "${dir}"
done

echo "[backup] Backup complete: ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}/"
