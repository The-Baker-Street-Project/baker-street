#!/usr/bin/env bash
# release.sh — Tag a release, push to GitHub, and trigger the CI/CD pipeline.
# Usage: scripts/release.sh [version]
#   version: semver tag (e.g. 0.4.0). Omit to auto-increment the patch version.
#
# What it does:
#   1. Verifies you're on main, clean, and up to date with origin
#   2. Shows changes since the last release tag
#   3. Updates the version in release-manifest.json
#   4. Commits the version bump, tags, and pushes
#   5. Optionally watches the release pipeline
#
# The release pipeline (.github/workflows/release.yml) then:
#   - Builds all service images to GHCR
#   - Builds installer binaries for linux/darwin (amd64/arm64)
#   - Creates a GitHub Release with the installer attached

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/tools/installer/release-manifest.json"

die() { echo -e "${RED}✗ $1${NC}" >&2; exit 1; }
info() { echo -e "${CYAN}→ $1${NC}"; }
ok() { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

# --- Preflight checks ---

cd "$REPO_ROOT"

# Must be on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || die "Must be on main (currently on '$BRANCH')"

# Must be clean
if [[ -n "$(git status --porcelain -- ':!docs/')" ]]; then
    die "Working tree has uncommitted changes (ignoring docs/). Commit or stash first."
fi

# Must be up to date
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[[ "$LOCAL" == "$REMOTE" ]] || die "Local main is not up to date with origin. Pull first."

ok "On main, clean, up to date"

# --- Determine version ---

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
info "Last release: $LAST_TAG"

if [[ -n "${1:-}" ]]; then
    VERSION="$1"
    # Strip leading v if provided
    VERSION="${VERSION#v}"
else
    # Auto-increment patch version
    LAST="${LAST_TAG#v}"
    IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST"
    PATCH=$((PATCH + 1))
    VERSION="$MAJOR.$MINOR.$PATCH"
fi

TAG="v$VERSION"

# Check tag doesn't already exist
if git rev-parse "$TAG" &>/dev/null; then
    die "Tag $TAG already exists"
fi

info "New version: $TAG"

# --- Show changes since last release ---

echo ""
echo -e "${CYAN}Changes since $LAST_TAG:${NC}"
git log --oneline "$LAST_TAG"..HEAD | head -20
COMMIT_COUNT=$(git rev-list --count "$LAST_TAG"..HEAD)
echo -e "${CYAN}($COMMIT_COUNT commits)${NC}"
echo ""

# --- Confirm ---

read -rp "Release $TAG? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

# --- Update manifest version ---

if command -v jq &>/dev/null; then
    TMP=$(mktemp)
    jq --arg v "$VERSION" '.version = $v' "$MANIFEST" > "$TMP" && mv "$TMP" "$MANIFEST"
    # Also update image versions
    TMP=$(mktemp)
    jq --arg v "$VERSION" '.images[].version = $v' "$MANIFEST" > "$TMP" && mv "$TMP" "$MANIFEST"
    ok "Updated release-manifest.json to $VERSION"

    git add "$MANIFEST"
    git commit -m "chore: bump version to $VERSION"
    ok "Committed version bump"
else
    warn "jq not found — skipping manifest version update. Install jq for automatic version bumps."
fi

# --- Tag and push ---

git tag -a "$TAG" -m "Release $TAG"
ok "Created tag $TAG"

git push origin main "$TAG"
ok "Pushed to origin"

# --- Watch pipeline ---

echo ""
info "Release pipeline triggered. Images will be built and pushed to GHCR."

if command -v gh &>/dev/null; then
    read -rp "Watch the pipeline? [Y/n] " WATCH
    if [[ ! "$WATCH" =~ ^[nN]$ ]]; then
        echo ""
        RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
        gh run watch "$RUN_ID"
        echo ""
        CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion')
        if [[ "$CONCLUSION" == "success" ]]; then
            ok "Release $TAG complete! Images are on GHCR."
            echo ""
            echo -e "  ${CYAN}GitHub Release:${NC} https://github.com/The-Baker-Street-Project/baker-street/releases/tag/$TAG"
            echo -e "  ${CYAN}Install on a new machine:${NC}"
            echo -e "    curl -fsSL https://github.com/The-Baker-Street-Project/baker-street/releases/latest/download/bakerst-install-\$(uname -s | tr A-Z a-z)-\$(uname -m) -o bakerst-install"
            echo -e "    chmod +x bakerst-install && ./bakerst-install install"
        else
            die "Pipeline failed with conclusion: $CONCLUSION"
        fi
    fi
else
    warn "gh CLI not found — check pipeline status at:"
    echo "  https://github.com/The-Baker-Street-Project/baker-street/actions"
fi
