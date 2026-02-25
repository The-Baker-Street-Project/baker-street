# Code Review Report Template

Use this template for generating reports in `docs/code-reviews/`.

## Filename Convention

`docs/code-reviews/{YYYY-MM-DD}-{scope}-{target}.md`

Examples:
- `2026-02-15-changeset-a3f8c12b.md`
- `2026-02-15-package-api.md`
- `2026-02-15-team-team-1.md`

## Template

```markdown
# Code Review Report

| Field | Value |
|-------|-------|
| **Run ID** | {runId} |
| **Generated** | {YYYY-MM-DD HH:mm} |
| **Scope** | {mode}: {description} |
| **Verdict** | {PASS / WARN / FAIL / ABORT} |

## Summary

| Severity | Count |
|----------|-------|
| Blocker | {n} |
| High | {n} |
| Medium | {n} |
| Low | {n} |
| Info | {n} |
| **Total** | **{n}** |

## Specialists Run

| Specialist | Files Reviewed | Findings |
|-----------|---------------|----------|
| typescript-quality | {n} | {n} |
| api-patterns | {n} | {n} |
| ui-design-compliance | {n} | {n} |
| security | {n} | {n} |
| test-quality | {n} | {n} |

## Findings

### Blockers

> **{title}**
> - **Domain:** {domain} | **Confidence:** {confidence}
> - **File:** `{file}`:{lineRange}
> - **Rule:** {ruleRef}
>
> **Evidence:**
> ```{lang}
> {evidence}
> ```
>
> **Rationale:** {rationale}
>
> **Recommendation:** {recommendation}
>
> **Suggested Fix:**
> ```diff
> {suggestedPatch}
> ```

### High

{repeat finding format}

### Medium

{repeat finding format}

### Low

{repeat finding format}

### Info

{repeat finding format}

## Files Reviewed

{list of all files in scope}

## Notes

{any additional observations, positive feedback, or meta-comments}
```
