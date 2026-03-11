#!/usr/bin/env bash
# bundle-template.sh — Runs in CI to create install-template.tar.gz.
# Bundles config-schema.json, K8s manifests, and operating_system files
# into a versioned tarball for the installer to download at install time.
#
# Optional env vars:
#   VERSION   — version stamp (default: dev)
#   OUTPUT    — output file path (default: install-template.tar.gz)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-dev}"
OUTPUT="${OUTPUT:-install-template.tar.gz}"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/install-template"

# Config schema
cp "$REPO_ROOT/tools/install-template/config-schema.json" "$tmpdir/install-template/"

# K8s manifests — render kustomize overlays into flat YAML for the installer.
# The installer applies YAML files directly (no kustomize dependency).
# Create a wrapper overlay that remaps local image names to GHCR with the release version.
IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/the-baker-street-project/bakerst}"
wrapper=$(mktemp -d)
cat > "$wrapper/kustomization.yaml" <<KUSTEOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - $REPO_ROOT/k8s/overlays/remote
images:
  - name: bakerst-brain
    newName: ${IMAGE_PREFIX}-brain
    newTag: "${VERSION}"
  - name: bakerst-worker
    newName: ${IMAGE_PREFIX}-worker
    newTag: "${VERSION}"
  - name: bakerst-ui
    newName: ${IMAGE_PREFIX}-ui
    newTag: "${VERSION}"
  - name: bakerst-gateway
    newName: ${IMAGE_PREFIX}-gateway
    newTag: "${VERSION}"
  - name: bakerst-sysadmin
    newName: ${IMAGE_PREFIX}-brain
    newTag: "${VERSION}"
  - name: bakerst-nats-sidecar
    newName: ${IMAGE_PREFIX}-nats-sidecar
    newTag: "${VERSION}"
  - name: bakerst-ext-toolbox
    newName: ${IMAGE_PREFIX}-ext-toolbox
    newTag: "${VERSION}"
  - name: bakerst-ext-browser
    newName: ${IMAGE_PREFIX}-ext-browser
    newTag: "${VERSION}"
  - name: bakerst-ext-github
    newName: ${IMAGE_PREFIX}-ext-github
    newTag: "${VERSION}"
  - name: bakerst-ext-google-workspace
    newName: ${IMAGE_PREFIX}-ext-google-workspace
    newTag: "${VERSION}"
KUSTEOF
mkdir -p "$tmpdir/install-template/k8s/overlays/remote"
kubectl kustomize "$wrapper" \
  > "$tmpdir/install-template/k8s/overlays/remote/all.yaml"
rm -rf "$wrapper"

# Also bundle extension manifests (flat YAML, no kustomize needed)
if [[ -d "$REPO_ROOT/k8s/extensions" ]]; then
  mkdir -p "$tmpdir/install-template/k8s/extensions"
  for ext_dir in "$REPO_ROOT"/k8s/extensions/*/; do
    ext_name=$(basename "$ext_dir")
    mkdir -p "$tmpdir/install-template/k8s/extensions/$ext_name"
    kubectl kustomize "$ext_dir" \
      > "$tmpdir/install-template/k8s/extensions/$ext_name/all.yaml" 2>/dev/null \
      || cp "$ext_dir"/*.yaml "$tmpdir/install-template/k8s/extensions/$ext_name/" 2>/dev/null \
      || true
  done
fi

# Operating system files (for ConfigMap)
cp -r "$REPO_ROOT/operating_system" "$tmpdir/install-template/operating_system"

# Version stamp
echo "$VERSION" > "$tmpdir/install-template/VERSION"

tar -czf "$OUTPUT" -C "$tmpdir" install-template/

echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
