# Team-Agent Integration Protocol — Design

**Date:** 2026-02-16
**Status:** Approved

## Context

The code review skills system runs multi-specialist reviews and produces structured findings. Team agents operate in separate git worktree sessions. This design adds a machine-readable feedback loop so team agents can invoke reviews, receive structured verdicts, fix issues iteratively, and proceed to PR only when quality gates pass.

## Verdict File Contract

The skill writes `.code-review/review-latest.json` to the worktree root.

```typescript
interface ReviewVerdict {
  reviewId: string;          // 8-char hex, matches markdown report
  timestamp: string;         // ISO 8601
  scope: 'changeset' | 'package' | 'team' | 'file';
  target: string;
  mode: 'full' | 'quick' | 'verify';
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'ABORT';
  summary: {
    blocker: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  reportPath: string;        // relative path to markdown report (empty for quick mode)
  findings: ReviewFinding[];
}

interface ReviewFinding {
  id: string;                // deterministic: "{domain}-{file-hash}-{lineRange}"
  domain: string;
  severity: 'Blocker' | 'High' | 'Medium' | 'Low' | 'Info';
  confidence: number;
  file: string;
  lineRange?: string;
  title: string;
  recommendation: string;
  status: 'open' | 'fixed' | 'verified' | 'reopened' | 'wont_fix';
}
```

- Finding `id` is deterministic from domain + file + line range (stable across re-runs).
- `status` starts as `"open"`. Team agent sets to `"fixed"`. Skill sets to `"verified"` or `"reopened"`.
- Team agent may set `"wont_fix"` for false positives — skill notes it but does not re-check.

## Invocation Modes

### Full Review (existing, enhanced)
```
/code-review
```
- Runs full FSM, writes markdown report + verdict JSON.
- Archives previous `review-latest.json` to `review-{reviewId}.json`.
- Returns path to verdict file.

### Verify Fixes
```
/code-review --verify
```
- Reads `review-latest.json`, re-checks only findings with `status: "fixed"`.
- Updates each to `"verified"` or `"reopened"`.
- Recalculates verdict from remaining open + reopened findings.
- Mutates `review-latest.json` in place.

### Quick Check (lightweight, mid-development)
```
/code-review --quick
```
- Runs only `typescript-quality` and `security` specialists.
- Scoped to uncommitted changes only.
- Writes verdict file tagged `mode: "quick"` (no markdown report).
- Quick checks are ephemeral — not archived, replaced by next full review.

## Team Agent Action Protocol

### After Full Review or Verify

```
PASS    → Proceed to PR. Include reportPath in PR description.

WARN    → Fix all High findings (required).
          Fix Medium findings (recommended).
          Low/Info optional.
          Mark fixed in verdict file, run --verify.
          Once no High remain → proceed to PR.

FAIL    → Any system-breaking Blockers?
            YES → ABORT. Write .code-review/abort-reason.md. Halt.
            NO  → Fix Blockers first, then High, then Medium.
                  Mark fixed, run --verify. Repeat until PASS or WARN-with-no-High.

ABORT   → Do not attempt fixes.
          Write .code-review/abort-reason.md with:
            - Which Blocker(s) triggered abort
            - What team was working on
            - Suggested next steps
          Halt.
```

### After Quick Check

```
Blocker → Stop current work, fix immediately.
High    → Fix before moving to next feature chunk.
Medium/Low/Info → Note for later, continue working.
```

### How Team Agent Marks Fixes

Read verdict JSON → update `status` from `"open"` to `"fixed"` for addressed items → write file back. Team agent does NOT modify any other fields — the skill owns everything except `status`.

## Verdict File Lifecycle

```
.code-review/
├── review-latest.json        # current active verdict (mutable)
├── review-{reviewId}.json    # archived snapshots (immutable)
└── abort-reason.md           # only exists if ABORT triggered
```

1. **Full review:** Archive current to `review-{reviewId}.json`, write fresh `review-latest.json`.
2. **Verify:** Mutate `review-latest.json` in place, bump timestamp.
3. **Quick check:** Write `review-latest.json` with `mode: "quick"`. Not archived — replaced by next full review.
4. **ABORT:** Write `abort-reason.md`. Verdict stays with `verdict: "ABORT"`.
5. **`.code-review/` is gitignored.** Working files only. Markdown reports in `docs/code-reviews/` are the permanent record.

## Files to Create

| File | Purpose |
|------|---------|
| `skills/code-review/foundations/verdict-schema.md` | JSON verdict file contract |
| `skills/code-review/foundations/team-agent-protocol.md` | Action protocol for team agents |

## Files to Modify

| File | Change |
|------|--------|
| `skills/code-review/SKILL.md` | Add --verify and --quick modes, ABORT verdict, verdict file output |
| `skills/code-review/report-writer/SKILL.md` | Write verdict JSON alongside markdown, archive logic |
| `skills/checkpoint/SKILL.md` | Reference /code-review for structured output, link to team-agent-protocol |
