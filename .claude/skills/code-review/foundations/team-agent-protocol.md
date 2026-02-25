# Team Agent Protocol

This document defines how team agents interact with the code review skill. Team agents read this as part of their system instructions.

## Overview

You have access to the `/code-review` skill for quality assurance. Use it **periodically during development**, not just when you think you're done. The skill writes a structured verdict file that you read and act on.

## When to Invoke

| Moment | Mode | Why |
|--------|------|-----|
| Mid-development, after completing a logical chunk | `/code-review --quick` | Catch issues early before they compound |
| When you believe a feature is complete | `/code-review` (full) | Full review before PR |
| After fixing reported issues | `/code-review --verify` | Targeted re-check of your fixes |

**Do not wait until the end to review.** Periodic `--quick` checks prevent expensive rewrites.

## Reading the Verdict

After invoking the skill, read `.code-review/review-latest.json`. The `verdict` field tells you what to do:

### PASS

All clear. Proceed to create the PR.

- Include the `reportPath` value in your PR description
- Example: "Code review report: docs/code-reviews/2026-02-16-changeset-a3f8c12b.md"

### WARN

No blockers, but High-severity issues exist that should be fixed.

1. Fix all findings with `severity: "High"` (required)
2. Fix findings with `severity: "Medium"` (recommended)
3. `Low` and `Info` are optional
4. Mark each fixed finding (see "Marking Fixes" below)
5. Run `/code-review --verify`
6. Repeat until no `High` findings remain
7. Proceed to PR

### FAIL

Blockers exist. Evaluate each Blocker:

- **If the Blocker is something you can fix** (missing validation, raw error throw, pattern violation):
  1. Fix all Blockers first, then High, then Medium
  2. Mark each fixed finding
  3. Run `/code-review --verify`
  4. Repeat until verdict improves to PASS or WARN-with-no-High

- **If the Blocker is system-breaking** (architectural flaw, data loss risk, security vulnerability you can't safely fix):
  1. Do NOT attempt the fix
  2. Set the verdict to ABORT (see ABORT section)

### ABORT

A system-breaking issue was found. Stop all work.

1. Do not attempt any fixes
2. Write `.code-review/abort-reason.md` with:
   - Which Blocker(s) triggered the abort
   - What you were working on when the abort occurred
   - Your assessment of the root cause
   - Suggested next steps (if any)
3. Halt and wait for the orchestrator or human to intervene

## After a Quick Check (--quick)

Quick checks are lightweight — act proportionally:

| Finding Severity | Action |
|-----------------|--------|
| Blocker | Stop current work. Fix immediately before continuing. |
| High | Fix before moving on to your next feature chunk. |
| Medium | Note for later. Continue working. |
| Low / Info | Ignore during development. Address in full review if flagged. |

## Marking Fixes

After fixing issues, update the verdict file so the skill knows what to re-check.

### Steps

1. Read `.code-review/review-latest.json`
2. For each finding you fixed, change `"status": "open"` to `"status": "fixed"`
3. If you believe a finding is a false positive, set `"status": "wont_fix"`
4. Write the file back
5. Do NOT modify any field other than `status` — the skill owns all other fields

### Example

Before your fix:
```json
{
  "id": "api-patterns-a1b2c3d4-45-47",
  "status": "open",
  ...
}
```

After your fix:
```json
{
  "id": "api-patterns-a1b2c3d4-45-47",
  "status": "fixed",
  ...
}
```

Then run `/code-review --verify`. The skill will check each `"fixed"` item and update it to either `"verified"` (resolved) or `"reopened"` (still present).

## Fix Priority Order

When multiple findings exist, fix in this order:

1. **Blockers** — these prevent merge
2. **High** — these trigger WARN verdict
3. **Medium** — recommended but not blocking
4. **Low / Info** — optional

Within the same severity, prioritize higher confidence findings first (they are more likely to be real issues).

## Lifecycle Example

```
# Development phase — periodic checks
[write feature code]
/code-review --quick           → WARN (1 High: missing input validation)
[fix the validation]
[continue developing]
/code-review --quick           → PASS
[continue developing]

# Completion phase — full review
/code-review                   → FAIL (1 Blocker, 2 High, 1 Medium)
[read .code-review/review-latest.json]
[fix blocker + 2 highs + medium]
[update status fields to "fixed"]
/code-review --verify          → WARN (blocker verified, 1 high reopened)
[re-fix the reopened high]
[update status to "fixed"]
/code-review --verify          → PASS
[create PR]
```
