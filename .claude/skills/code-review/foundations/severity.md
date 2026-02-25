# Severity Rubric & Confidence Calibration

## Severity Levels

| Level | Description | Merge Impact |
|-------|------------|-------------|
| **Blocker** | Security vulnerability, data loss risk, or guaranteed runtime crash. Must fix before merge. | Blocks merge |
| **High** | Significant bug, pattern violation that causes maintenance burden, or missing required functionality. Should fix before merge. | Warns, strongly recommended fix |
| **Medium** | Code quality issue, minor pattern deviation, or missing best practice. Fix recommended but not blocking. | Noted in report |
| **Low** | Style preference, minor optimization opportunity, or documentation gap. Fix at convenience. | Noted in report |
| **Info** | Observation, suggestion, or positive feedback. No action required. | Noted in report |

## Confidence Calibration

Every finding includes a confidence score (0.50 - 1.00):

| Range | Meaning | Guidelines |
|-------|---------|-----------|
| 0.90 - 1.00 | Certain | Clear pattern match, no ambiguity. E.g., `any` type found, raw hex in TSX. |
| 0.75 - 0.89 | High confidence | Strong signal but some context could change interpretation. |
| 0.60 - 0.74 | Moderate | Likely an issue but needs human judgment. E.g., "this might be intentional." |
| 0.50 - 0.59 | Low confidence | Possible issue, flagging for review. Might be false positive. |

**Never emit findings below 0.50 confidence.** If unsure, don't report it.

## Deduplication Rules

1. **Same file + overlapping lines + same domain** → Keep the finding with higher severity. If equal severity, keep higher confidence.
2. **Same file + overlapping lines + different domains** → Keep BOTH findings. Cross-domain issues are distinct concerns.
3. **Same pattern across multiple files** → Collapse into ONE finding. List all affected files in the evidence field. Use the highest severity found.

## Interaction Rules

- Blocker + any lower severity on same line → Only report the Blocker
- Multiple Info findings from same specialist → Collapse into summary
- If total findings exceed cap, drop lowest severity + lowest confidence first
