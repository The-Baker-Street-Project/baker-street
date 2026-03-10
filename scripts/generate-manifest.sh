#!/usr/bin/env bash
# generate-manifest.sh — Runs in CI after images are built.
# Queries GHCR for image availability/architectures and produces manifest.json.
#
# Required env vars:
#   VERSION              — release version (from git tag)
#   GITHUB_REPOSITORY    — org/repo (e.g. The-Baker-Street-Project/baker-street)
#   SERVICES             — space-separated list of service names that were built
#
# Optional env vars:
#   INSTALLER_LINUX_AMD64_SHA256    — sha256 of linux amd64 installer binary
#   INSTALLER_DARWIN_ARM64_SHA256   — sha256 of darwin arm64 installer binary
#   OUTPUT                          — output file path (default: manifest.json)

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${SERVICES:?SERVICES is required (space-separated list of service names)}"

# Strip leading 'v' if present (git tags use v0.5.0, we want 0.5.0)
VERSION="${VERSION#v}"

OUTPUT="${OUTPUT:-manifest.json}"
REGISTRY="ghcr.io/$(echo "${GITHUB_REPOSITORY}" | tr '[:upper:]' '[:lower:]')"
INSTALLER_LINUX_AMD64_SHA256="${INSTALLER_LINUX_AMD64_SHA256:-}"
INSTALLER_DARWIN_ARM64_SHA256="${INSTALLER_DARWIN_ARM64_SHA256:-}"

# Required images — these must be present for a valid release
REQUIRED_IMAGES="brain worker ui nats-sidecar"

# Cross-platform sha256sum
sha256() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "error: neither sha256sum nor shasum found" >&2
    exit 1
  fi
}

# Query architectures for a given image:tag via docker manifest inspect
get_architectures() {
  local image="$1"
  local tag="$2"
  local full="${REGISTRY}/${image}:${tag}"

  if docker manifest inspect "$full" &>/dev/null; then
    docker manifest inspect "$full" 2>/dev/null \
      | jq -r '[.manifests[]? | "\(.platform.os)/\(.platform.architecture)"] // ["unknown"]' 2>/dev/null \
      || echo '["unknown"]'
  else
    echo "warning: could not inspect $full — marking architectures as unknown" >&2
    echo '["unknown"]'
  fi
}

# Determine if a service is required
is_required() {
  local name="$1"
  for req in $REQUIRED_IMAGES; do
    if [[ "$name" == "$req" ]]; then
      echo "true"
      return
    fi
  done
  echo "false"
}

# Compute template tarball sha256 if the file exists
TEMPLATE_SHA256=""
if [[ -f "install-template.tar.gz" ]]; then
  TEMPLATE_SHA256=$(sha256 "install-template.tar.gz")
fi

echo "==> Generating manifest for version $VERSION"
echo "    Services: $SERVICES"
echo "    Registry: $REGISTRY"

# Build images array
IMAGES_JSON="[]"
for service in $SERVICES; do
  image_name="bakerst-${service}"
  required=$(is_required "$service")
  archs=$(get_architectures "$image_name" "$VERSION")

  IMAGES_JSON=$(echo "$IMAGES_JSON" | jq \
    --arg name "$service" \
    --arg image "${REGISTRY}/${image_name}" \
    --arg tag "$VERSION" \
    --argjson required "$required" \
    --argjson archs "$archs" \
    '. + [{
      name: $name,
      image: $image,
      tag: $tag,
      required: $required,
      architectures: $archs
    }]')
done

# Build installers array
INSTALLERS_JSON="[]"

if [[ -n "$INSTALLER_LINUX_AMD64_SHA256" ]]; then
  INSTALLERS_JSON=$(echo "$INSTALLERS_JSON" | jq \
    --arg url "https://github.com/${GITHUB_REPOSITORY}/releases/download/v${VERSION}/baker-install-linux-amd64" \
    --arg sha256 "$INSTALLER_LINUX_AMD64_SHA256" \
    '. + [{
      os: "linux",
      arch: "amd64",
      url: $url,
      sha256: $sha256
    }]')
fi

if [[ -n "$INSTALLER_DARWIN_ARM64_SHA256" ]]; then
  INSTALLERS_JSON=$(echo "$INSTALLERS_JSON" | jq \
    --arg url "https://github.com/${GITHUB_REPOSITORY}/releases/download/v${VERSION}/baker-install-darwin-arm64" \
    --arg sha256 "$INSTALLER_DARWIN_ARM64_SHA256" \
    '. + [{
      os: "darwin",
      arch: "arm64",
      url: $url,
      sha256: $sha256
    }]')
fi

# Assemble final manifest
RELEASE_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --argjson schemaVersion 1 \
  --arg version "$VERSION" \
  --arg releaseDate "$RELEASE_DATE" \
  --arg templateUrl "https://github.com/${GITHUB_REPOSITORY}/releases/download/v${VERSION}/install-template.tar.gz" \
  --arg templateSha256 "$TEMPLATE_SHA256" \
  --argjson images "$IMAGES_JSON" \
  --argjson installers "$INSTALLERS_JSON" \
  '{
    schemaVersion: $schemaVersion,
    version: $version,
    releaseDate: $releaseDate,
    templateUrl: $templateUrl,
    templateSha256: $templateSha256,
    images: $images,
    installers: $installers
  }' > "$OUTPUT"

echo "==> Manifest written to $OUTPUT"
echo "    Images: $(echo "$IMAGES_JSON" | jq length)"
echo "    Installers: $(echo "$INSTALLERS_JSON" | jq length)"
