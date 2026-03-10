#!/usr/bin/env bash
# release.sh — Tag a release and push to GitHub to trigger the CI/CD pipeline.
#
# Usage: scripts/release.sh [version]
#   version: semver (e.g. 0.5.1). Omit to auto-increment patch from latest tag.
#
# What it does:
#   1. Verifies you're on main, clean, and up-to-date with origin
#   2. Shows changelog (commits since last tag)
#   3. Confirms, then tags and pushes
#   4. Optionally watches the release pipeline via gh CLI
#
# The release workflow (.github/workflows/release.yml) then builds images,
# runs acceptance tests, and publishes a GitHub Release with all artifacts.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

die()  { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }
info() { echo -e "${CYAN}>> $1${NC}"; }
ok()   { echo -e "${GREEN}OK: $1${NC}"; }

cd "$(dirname "$0")/.."

# ── Preflight ────────────────────────────────────────────────────────────

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || die "Must be on main (currently on '$BRANCH')"

if [[ -n "$(git status --porcelain -- ':!docs/')" ]]; then
  die "Working tree has uncommitted changes. Commit or stash first."
fi

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[[ "$LOCAL" == "$REMOTE" ]] || die "Local main is behind origin. Run: git pull"

ok "On main, clean, up to date"

# ── Determine version ───────────────────────────────────────────────────

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
info "Last release: $LAST_TAG"

if [[ -n "${1:-}" ]]; then
  VERSION="${1#v}"
else
  LAST="${LAST_TAG#v}"
  IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST"
  VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
fi

TAG="v$VERSION"
git rev-parse "$TAG" &>/dev/null && die "Tag $TAG already exists"

info "New version: $TAG"

# ── Changelog ────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}Changes since $LAST_TAG:${NC}"
git log --oneline "$LAST_TAG"..HEAD | head -20
COMMIT_COUNT=$(git rev-list --count "$LAST_TAG"..HEAD)
echo -e "${CYAN}($COMMIT_COUNT commits)${NC}"
echo ""

# ── Confirm ──────────────────────────────────────────────────────────────

read -rp "Release $TAG? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

# ── Tag and push ─────────────────────────────────────────────────────────

git tag -a "$TAG" -m "Release $TAG"
ok "Created tag $TAG"

git push origin "$TAG"
ok "Pushed tag to origin"

# ── Watch pipeline ───────────────────────────────────────────────────────

echo ""
info "Release pipeline triggered."

if command -v gh &>/dev/null; then
  read -rp "Watch the pipeline? [Y/n] " WATCH
  if [[ ! "$WATCH" =~ ^[nN]$ ]]; then
    echo ""
    RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
    gh run watch "$RUN_ID"
    echo ""
    CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion')
    if [[ "$CONCLUSION" == "success" ]]; then
      ok "Release $TAG complete!"
      echo ""
      echo -e "  ${CYAN}GitHub Release:${NC} https://github.com/The-Baker-Street-Project/baker-street/releases/tag/$TAG"
      echo -e "  ${CYAN}Install:${NC}"
      echo -e "    curl -fsSL https://github.com/The-Baker-Street-Project/baker-street/releases/latest/download/bakerst-install-linux-amd64 -o bakerst-install"
      echo -e "    chmod +x bakerst-install && ./bakerst-install install"
    else
      die "Pipeline failed: $CONCLUSION"
    fi
  fi
else
  info "Install gh CLI to watch pipeline, or check:"
  echo "  https://github.com/The-Baker-Street-Project/baker-street/actions"
fi
