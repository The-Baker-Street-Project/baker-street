# Test Plan Report Template

Use this template for generating reports in `docs/test-plans/`.

## Filename Convention

`docs/test-plans/{YYYY-MM-DD}-{entity}-{layer}-{planId}.md`

Examples:
- `2026-02-18-vendor-service-b7e4f1a2.md`
- `2026-02-18-rfi-router-c3d4e5f6.md`
- `2026-02-18-task-schema-a1b2c3d4.md`

## Template

```markdown
# Test Plan Report

| Field | Value |
|-------|-------|
| **Plan ID** | {planId} |
| **Generated** | {YYYY-MM-DD HH:mm} |
| **Mode** | {full / validate / refresh} |
| **Task** | {task description} |
| **Entity** | {entity} |
| **Package** | {package} |
| **Layer** | {layer} |
| **Verdict** | {READY / PARTIAL / BLOCKED} |

## Summary

| Priority | Count |
|----------|-------|
| P1 (Must Have) | {n} |
| P2 (Should Have) | {n} |
| P3 (Nice to Have) | {n} |
| **Total** | **{n}** |

## Analysts Run

| Analyst | Specs Produced |
|---------|---------------|
| contract-compliance | {n} |
| state-lifecycle | {n} |
| boundary-validation | {n} |
| integration-surface | {n} |

## Generated Test Files

| File | Tests | Todos | Status |
|------|-------|-------|--------|
| `{path}` | {n} | {n} | {ready / partial} |

## Test Specifications

### P1 — Must Have

#### {describeBlock}

- **{testName}**
  - Analyst: {analyst} | Category: {category}
  - Arrangement: {arrangement}
  - Action: {action}
  - Assertions:
    - {assertion.description}
    - {assertion.description}
  - Traceability: {traceability}

### P2 — Should Have

{repeat spec format}

### P3 — Nice to Have

{repeat spec format}

## Validation Results (validate mode only)

| Metric | Value |
|--------|-------|
| Passed | {n} |
| Failed | {n} |
| Todo | {n} |
| Verdict | {ALL_PASS / PARTIAL_PASS / FAILING} |

### Failed Tests

- `{testFile}` > {describeBlock} > {testName}
  - Error: {error message}

## Context Sources

- Task description: {source}
- Zod schemas read: {list}
- DB schema read: {list}
- Reference implementations: {list}
- CLAUDE.md sections: {list}

## Next Steps

{Actionable guidance based on verdict}
```

## Mode-Specific Behavior

### Full Mode
- Generate the complete report with all sections
- Write to `docs/test-plans/` with timestamp filename
- Update `docs/test-plans/index.md` and `docs/test-plans/latest.md`

### Validate Mode
- Only include Summary, Generated Test Files, and Validation Results sections
- Do NOT write a new markdown report file
- Update `plan-latest.json` with validation results in place

### Refresh Mode
- Generate the complete report (same as full mode)
- Note which specs were added, removed, or modified since the previous plan
- Archive previous plan before writing new one
