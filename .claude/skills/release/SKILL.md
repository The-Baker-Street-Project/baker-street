---
name: release
description: Tag and publish a release — runs scripts/release.sh logic to create a version tag, push it to trigger the CI/CD release pipeline, and optionally watches the pipeline to completion. Use when the user says /release, "cut a release", "tag a release", "publish a release", "create a new version", or wants to go from merged main to a GitHub Release. Typically used after /ship.
---

# /release — Cut a Release

**Purpose:** Tag a version on main and push it to trigger the CI/CD release pipeline. One command to go from merged code on main to a published GitHub Release with installer binaries.

## Arguments

- `[version]` — explicit semver (e.g. `0.5.1`). Omit to auto-increment patch from latest tag.
- `--skip-watch` — push the tag and exit without watching the pipeline
- `--dry-run` — show what would happen without creating or pushing the tag

## Workflow

Execute in order. Stop and report on failure.

### Step 1: Verify on main

```bash
git branch --show-current
```

Must be on `main`. If not, ask the user if they want to `git checkout main && git pull` first.

### Step 2: Verify clean and up-to-date

```bash
git status --porcelain -- ':!docs/'
git fetch origin main --quiet
```

- Working tree must be clean (docs/ changes are OK to ignore)
- Local main must match `origin/main` — if behind, suggest `git pull`

### Step 3: Determine version

```bash
git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"
```

- If `[version]` argument provided: use it (strip leading `v` if present)
- Otherwise: auto-increment patch from latest tag (e.g. `v0.5.0` → `v0.5.1`)
- Verify the tag doesn't already exist

Report: `Last release: vX.Y.Z → New release: vX.Y.W`

### Step 4: Show changelog

```bash
git log --oneline <last-tag>..HEAD | head -20
git rev-list --count <last-tag>..HEAD
```

Display the commits and count. If `--dry-run`, stop here and report what would be tagged.

### Step 5: Confirm

Ask the user to confirm the release. Show:
- Version tag to be created
- Number of commits included
- That this will trigger the CI/CD pipeline

### Step 6: Tag and push

```bash
git tag -a "v<version>" -m "Release v<version>"
git push origin "v<version>"
```

### Step 7: Watch pipeline (unless --skip-watch)

```bash
# Find the triggered workflow run
gh run list --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch <run-id>
```

If pipeline fails: report the failure and link to the Actions run. Stop.

### Step 8: Report

On success, report:
- Version tag
- GitHub Release URL: `https://github.com/The-Baker-Street-Project/baker-street/releases/tag/v<version>`
- Install command:
  ```
  curl -fsSL https://github.com/The-Baker-Street-Project/baker-street/releases/latest/download/bakerst-install-linux-amd64 -o bakerst-install
  chmod +x bakerst-install && ./bakerst-install install
  ```

## Error Handling

| Error | Action |
|---|---|
| Not on main | Offer to checkout main and pull |
| Dirty working tree | List changed files, ask to commit or stash |
| Behind origin | Suggest `git pull` |
| Tag exists | Report existing tag, suggest next version |
| Push rejected | Check permissions, suggest `git push origin v<version>` manually |
| Pipeline fails | Report failure URL, link to Actions page |
| gh CLI missing | Tag and push still work, just skip the watch step |

## Notes

- This skill wraps the logic from `scripts/release.sh` — it exists so you can release conversationally without leaving Claude
- The release pipeline (`.github/workflows/release.yml`) builds multi-arch images, generates manifest.json, builds installer binaries, runs acceptance tests, and publishes a GitHub Release
- Pair with `/ship` for the full workflow: `/ship` merges your PR, then `/release` tags and publishes
- The pipeline takes ~15-20 minutes (multi-arch builds + acceptance tests)
