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

# K8s manifests (full kustomize structure)
cp -r "$REPO_ROOT/k8s" "$tmpdir/install-template/k8s"

# Operating system files (for ConfigMap)
cp -r "$REPO_ROOT/operating_system" "$tmpdir/install-template/operating_system"

# Version stamp
echo "$VERSION" > "$tmpdir/install-template/VERSION"

tar -czf "$OUTPUT" -C "$tmpdir" install-template/

echo "Created $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
