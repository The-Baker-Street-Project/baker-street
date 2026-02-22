# Verdict Schema

The code review skill writes a structured JSON verdict file to `.code-review/review-latest.json` in the worktree root. This is the machine-readable contract between the skill and team agents.

## Directory Structure

```
.code-review/
├── review-latest.json        # current active verdict (mutable)
├── review-{reviewId}.json    # archived snapshots (immutable)
└── abort-reason.md           # only exists if ABORT triggered
```

`.code-review/` MUST be gitignored. These are working files for the agent loop. The markdown reports in `docs/code-reviews/` are the permanent record.

## ReviewVerdict

```typescript
interface ReviewVerdict {
  reviewId: string;          // 8-char hex, matches the markdown report ID
  timestamp: string;         // ISO 8601
  scope: 'changeset' | 'package' | 'team' | 'file';
  target: string;            // e.g., "origin/master..HEAD", "packages/api"
  mode: 'full' | 'quick' | 'verify';
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'ABORT';
  summary: {
    blocker: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  reportPath: string;        // relative path to markdown report ("" for quick mode)
  findings: ReviewFinding[];
}
```

## ReviewFinding

```typescript
interface ReviewFinding {
  id: string;                // deterministic: "{domain}-{file-hash}-{lineRange}"
  domain: string;            // specialist that produced this finding
  severity: 'Blocker' | 'High' | 'Medium' | 'Low' | 'Info';
  confidence: number;        // 0.50-1.00
  file: string;              // repo-relative path
  lineRange?: string;        // e.g., "42-58" or "42"
  title: string;             // max 120 chars
  recommendation: string;    // concrete fix instruction
  status: 'open' | 'fixed' | 'verified' | 'reopened' | 'wont_fix';
}
```

## Finding ID Generation

The `id` field MUST be deterministic so findings are stable across review runs:

```
{domain}-{first8CharsOfSha256(file)}-{lineRange or "0"}
```

Example: `api-patterns-a1b2c3d4-45-47`

## Status Field Ownership

| Status | Set by | Meaning |
|--------|--------|---------|
| `open` | Skill | Finding is new or unaddressed |
| `fixed` | Team agent | Team claims to have resolved this finding |
| `verified` | Skill (--verify) | Skill confirmed the fix resolves the finding |
| `reopened` | Skill (--verify) | Skill checked and the issue is still present |
| `wont_fix` | Team agent | Team believes this is a false positive or intentional |

The team agent ONLY modifies the `status` field. All other fields are owned by the skill.

## Verdict Calculation

Verdict is calculated from findings where `status` is `open` or `reopened` (not `fixed`, `verified`, or `wont_fix`):

| Condition | Verdict |
|-----------|---------|
| 0 Blockers AND 0 High | **PASS** |
| 0 Blockers AND >=1 High | **WARN** |
| >=1 Blocker (non-system-breaking) | **FAIL** |
| >=1 Blocker (system-breaking) | **ABORT** |

`ABORT` is reserved for Blockers that indicate fundamental architectural problems, data loss risk, or security vulnerabilities that the team agent should not attempt to fix autonomously.

## Lifecycle Rules

1. **Full review (`/code-review`):** If `review-latest.json` exists, archive it to `review-{reviewId}.json` using the existing file's `reviewId`. Write fresh `review-latest.json` with all findings at `status: "open"`.

2. **Verify (`/code-review --verify`):** Mutate `review-latest.json` in place. Update statuses. Recalculate verdict. Bump `timestamp`.

3. **Quick check (`/code-review --quick`):** Write `review-latest.json` with `mode: "quick"`. Not archived — next full review replaces it.

4. **ABORT:** Write `abort-reason.md` alongside verdict file. Verdict file stays with `verdict: "ABORT"`.

## Example Verdict File

```json
{
  "reviewId": "a3f8c12b",
  "timestamp": "2026-02-16T14:30:00Z",
  "scope": "changeset",
  "target": "origin/master..HEAD",
  "mode": "full",
  "verdict": "WARN",
  "summary": {
    "blocker": 0,
    "high": 2,
    "medium": 3,
    "low": 1,
    "info": 0
  },
  "reportPath": "docs/code-reviews/2026-02-16-changeset-a3f8c12b.md",
  "findings": [
    {
      "id": "api-patterns-a1b2c3d4-45-50",
      "domain": "api-patterns",
      "severity": "High",
      "confidence": 0.90,
      "file": "src/api/routes.ts",
      "lineRange": "45-50",
      "title": "Missing error handling on async route handler",
      "recommendation": "Wrap the route handler in try-catch, log with the project's logger, and return a 500 response",
      "status": "open"
    }
  ]
}
```
