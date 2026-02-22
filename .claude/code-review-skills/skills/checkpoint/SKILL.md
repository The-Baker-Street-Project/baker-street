---
name: checkpoint
description: "Quality gate before creating PR. Discovers project tooling from CLAUDE.md and runs: linter, typecheck, tests for changed packages, and review skills based on changed files. Shows summary of files changed, tests passed, and any violations found."
---

# /checkpoint — Quality Gate Before PR

**Purpose:** Run all verification checks before creating a pull request.

## When to Run

- Before creating any PR
- After completing a feature
- When ready to merge to the main branch

## How It Works

1. **Read `CLAUDE.md`** to discover the project's build tooling:
   - Linter/formatter (Biome, ESLint+Prettier, etc.) and its check command
   - TypeScript check command (`tsc --noEmit`, `turbo typecheck`, etc.)
   - Test runner command (`pnpm test`, `vitest`, `jest`, etc.)
   - Package manager (`pnpm`, `npm`, `yarn`, `bun`)
   - Monorepo tool (Turborepo, Nx, Lerna, or none)
   - Workspace package names and paths

2. **Read `.code-review/config.json`** if it exists for team mappings

3. **Detect changed files** relative to the main branch

4. **Run the checks below** using the discovered tooling

## Team Agent Integration

If you are a team agent, use `/code-review` alongside `/checkpoint` for structured feedback:

- **During development:** Use `/code-review --quick` for periodic lightweight checks
- **At completion:** Run `/checkpoint` for build/test verification, then `/code-review` for structured code quality review
- **After fixing issues:** Use `/code-review --verify` to re-check only the items you fixed

The `/checkpoint` skill verifies the build is healthy (lint, types, tests). The `/code-review` skill analyzes code quality and writes a structured verdict file (`.code-review/review-latest.json`) that you read and act on.

See `skills/code-review/foundations/team-agent-protocol.md` for the full action protocol, including how to mark fixes and handle each verdict (PASS/WARN/FAIL/ABORT).

## Checks Performed

### 1. Lint + Format

Run the project's linter/formatter in check mode (discovered from CLAUDE.md):

```bash
# Examples — adapt to project:
# pnpm biome check .
# pnpm eslint .
# pnpm lint
```

**Must pass with no errors.** Auto-fix if the tool supports it.

### 2. TypeScript Typecheck

```bash
# Examples — adapt to project:
# pnpm tsc --noEmit
# pnpm turbo typecheck
# npx tsc -b
```

**Must pass with no errors.** All packages must compile.

### 3. Tests for Changed Packages

Identify changed packages from `git diff`:

```bash
# Get changed files compared to main branch
git diff origin/main --name-only
```

If the project uses a monorepo tool with filtering:
```bash
# Run tests only for affected packages
# pnpm turbo test --filter=<changed-package>
# npx nx affected --target=test
```

Otherwise, run the full test suite:
```bash
# pnpm test
# npm test
```

### 4. Run Appropriate Review Skills

Based on changed file types:

- **If UI/component files changed** → Run `/review-design` (if available)
- **If backend/API files changed** → Run `/review-api` (if available)
- **If database/schema files changed** → Run `/review-db` (if available)
- **If test files changed** → Run `/review-tests` (if available)

### 5. Summary Report

Generate summary of:
- Files changed
- Lines added/removed
- Tests run and passed
- Any violations found

## Checkpoint Process

```
1. Detect changes:
   git diff origin/{main-branch} --name-only
   git diff origin/{main-branch} --stat

2. Run linter:
   {lint-command from CLAUDE.md}

3. Run typecheck:
   {typecheck-command from CLAUDE.md}

4. Run tests for changed packages:
   {test-command from CLAUDE.md, filtered if monorepo}

5. Run applicable review skills based on changed files

6. Report summary:
   - Files changed: N
   - Checks failed: N
   - Warnings: N
   - CHECKPOINT PASSED / FAILED
```

## Quick Checkpoint Commands

### Minimal Check (fast)
```bash
# Adapt to project tooling:
# {lint-command} && {typecheck-command}
```

### Full Check (with tests)
```bash
# {lint-command} && {typecheck-command} && {test-command}
```

## Integration

Add to the project's `package.json`:

```json
{
  "scripts": {
    "checkpoint": "bash scripts/checkpoint.sh",
    "check": "{lint-command} && {typecheck-command}",
    "check:fix": "{lint-fix-command} && {typecheck-command}"
  }
}
```

## PR Checklist

After checkpoint passes, verify:

- [ ] Branch name follows project convention
- [ ] Commit messages follow project convention (Conventional Commits, etc.)
- [ ] PR title is descriptive and under 72 characters
- [ ] PR description explains what and why
- [ ] No console.log or debugging code left in
- [ ] No TODO comments for this feature (either done or tracked in issue)
- [ ] New code has appropriate test coverage
- [ ] Documentation updated if needed

## Pre-Push Hook (Optional)

Add to `.husky/pre-push` or equivalent:

```bash
#!/bin/bash
# {lint-command}
# {typecheck-command}
```

This ensures code passes checks before pushing.
