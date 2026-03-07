---
name: checkpoint
description: "Quality gate: discovers project tooling, runs linter, typecheck/build, and tests for changed packages. Use before pushing or creating PRs."
---

# /checkpoint — Quality Gate

**Purpose:** Fast quality gate that runs lint, build, and tests for changed packages. Does NOT run code review — use `/code-review` separately for that.

## Workflow

Execute these steps in order. Report results at the end.

### Step 1: Discover Tooling

Read `CLAUDE.md` and root `package.json` to identify:
- **Lint command**: e.g., `pnpm -r lint`, `pnpm lint`
- **Build command**: e.g., `pnpm -r build`
- **Test command**: e.g., `pnpm --filter <pkg> test -- --run`
- **Package manager**: pnpm, npm, yarn, bun

If `CLAUDE.md` lists build/test commands, use those. Otherwise fall back to `package.json` scripts.

### Step 2: Identify Changed Packages

```bash
git diff origin/main --name-only
```

Extract unique package/service paths from the changed files. For a pnpm monorepo, map file paths to their workspace package names (check `pnpm-workspace.yaml` and each package's `package.json`).

If no changes vs origin/main, check for uncommitted changes:
```bash
git diff --name-only
git diff --cached --name-only
```

Report: "N files changed across M packages: [list]"

### Step 3: Run Linter (if configured)

```bash
pnpm -r lint
```

Or the project-specific lint command from Step 1.

- If no lint script exists, skip and note "No linter configured."
- If lint fails, record the output but continue to build.

### Step 4: Run Build / Typecheck

```bash
pnpm -r build
```

Or the project-specific build command from Step 1.

- If build fails, record the output but continue to tests.

### Step 5: Run Tests for Changed Packages

For each changed package identified in Step 2:

```bash
pnpm --filter <package-name> test -- --run
```

- Use `--run` to prevent vitest from entering watch mode.
- If a package has no test script, skip it and note "No tests for <package>."
- If tests fail, record the output.

### Step 6: Report

Output a summary:

```
## Checkpoint Results

**Files changed:** N files across M packages
**Packages:** [list]

| Check      | Result | Details          |
|------------|--------|------------------|
| Lint       | PASS/FAIL/SKIP | [summary]  |
| Build      | PASS/FAIL | [summary]       |
| Tests      | PASS/FAIL/SKIP | [summary]  |

**Verdict: PASS / FAIL**
```

- **PASS**: All checks passed (or skipped with no failures).
- **FAIL**: Any check failed. List each failure with relevant output.

## Notes

- This is the fast gate. It does NOT run `/code-review`.
- `/pr` and `/ship` call this skill as a prerequisite.
- Known pre-existing test failures (documented in CLAUDE.md or auto-memory) should be noted but not block the verdict unless they are new regressions.
