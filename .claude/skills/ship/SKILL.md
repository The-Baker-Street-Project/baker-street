---
name: ship
description: Use when work is done and ready to ship — commits, creates PR, waits for CI, squash-merges, pulls main, and builds the installer release binary. Triggers on /ship or /shipit.
---

# /ship — Ship It

**Purpose:** End-to-end ship: commit, PR, CI, merge, build installer. One command to go from working tree changes to a merged PR with release binary.

## Arguments

- `--skip-checkpoint` — skip quality gate before push
- `--skip-build` — skip installer release build after merge
- `--draft` — create PR as draft and stop (no merge)

## Workflow

Execute in order. Stop and report on failure.

### Step 1: Branch

```bash
git branch --show-current
```

If on `main`: ask user for branch name, create with `git checkout -b <name>`.

### Step 2: Stage & Commit

```bash
git status
git diff HEAD
git log --oneline -5
```

If changes exist:
- Stage relevant files (`git add <files>` — avoid untracked junk, .exe, .zip, Zone.Identifier files)
- Generate commit message (check recent log for style — this project uses Conventional Commits)
- Commit

If no changes and no commits ahead of origin: stop — nothing to ship.

### Step 3: Quality Gate (unless --skip-checkpoint)

Invoke `/checkpoint`. If it fails, stop before push.

### Step 4: Push & Create PR

```bash
git push -u origin HEAD
```

Generate PR title (< 70 chars) and body:

```markdown
## Summary
- <what changed>
- <why>

## Test plan
- [ ] <verification items>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Create with `gh pr create`. If `--draft`, stop here and report URL.

### Step 5: Wait for CI

```bash
gh pr checks <number> --watch
```

If CI fails: report the failure URL. Do not merge. Stop.

### Step 6: Squash Merge

```bash
gh pr merge <number> --squash --admin
```

If merge fails (branch protection, conflicts): report error and stop.

### Step 7: Pull Main

```bash
git checkout main
git pull
```

### Step 8: Build Installer (unless --skip-build)

```bash
cd tools/installer && cargo build --release
```

Report binary location and size:
```bash
ls -lh tools/installer/target/release/bakerst-install
```

### Done

Report summary:
- PR number and URL
- Commit hash on main
- Installer binary path and size

## Error Handling

| Error | Action |
|---|---|
| Push rejected | Suggest `git pull --rebase origin <branch>` |
| PR already exists | Report existing URL, ask to update |
| CI fails | Report failure URL, stop |
| Merge blocked | Report reason (conflicts, required reviews), stop |
| Cargo build fails | Report error, suggest `cargo test` first |

## Notes

- Always squash-merge to keep main clean
- Uses `--admin` on merge to bypass branch protection (repo owner workflow)
- Installer build is Rust — expects working cargo toolchain
- The release binary at `tools/installer/target/release/bakerst-install` is ~14MB
