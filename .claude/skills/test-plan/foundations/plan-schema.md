# Plan Schema

The test-plan skill writes a structured JSON plan file to `.test-plan/plan-latest.json` in the worktree root. This is the machine-readable contract between the skill and team agents.

## Directory Structure

```
.test-plan/
├── config.json               # project config (checked in)
├── plan-latest.json           # active plan (mutable, gitignored)
└── plan-{planId}.json         # archived snapshots (gitignored)
```

`.test-plan/plan-*.json` files MUST be gitignored. These are working files for the agent loop. The markdown reports in `docs/test-plans/` are the permanent record. The `config.json` file IS checked in.

## TestPlan

```typescript
interface TestPlan {
  planId: string;              // 8-char hex, matches the markdown report ID
  timestamp: string;           // ISO 8601
  mode: 'full' | 'validate' | 'refresh';
  taskContext: {
    description: string;       // original task description
    entity: string;            // primary entity (e.g., "vendor", "rfi", "task")
    package: string;           // target package (e.g., "packages/api")
    layer: string;             // target layer: "service" | "router" | "schema" | "component"
  };
  verdict: 'READY' | 'PARTIAL' | 'BLOCKED';
  summary: {
    total: number;
    p1: number;
    p2: number;
    p3: number;
    byAnalyst: Record<string, number>;
    byCategory: Record<string, number>;
  };
  validation?: {
    passed: number;
    failed: number;
    todo: number;
    verdict: 'ALL_PASS' | 'PARTIAL_PASS' | 'FAILING';
  };
  generatedFiles: GeneratedFile[];
  reportPath: string;          // relative path to markdown report
  specifications: TestSpecification[];
}

interface GeneratedFile {
  path: string;                // repo-relative path to generated .test.ts file
  testCount: number;           // total it() + it.todo() count
  todoCount: number;           // it.todo() count (not yet implemented)
}
```

## Plan Verdicts

### Full Mode (`/test-plan --task="..."`)

| Condition | Verdict |
|-----------|---------|
| All P1 specs generated, context complete | **READY** |
| Some context missing, P1 generated but P2/P3 incomplete | **PARTIAL** |
| Critical context missing, cannot generate P1 specs | **BLOCKED** |

### Validate Mode (`/test-plan --validate`)

Runs the generated test files and reports results:

| Condition | Verdict |
|-----------|---------|
| All non-todo tests pass | **ALL_PASS** |
| Some pass, some fail | **PARTIAL_PASS** |
| >50% fail | **FAILING** |

The `validation` field is only present in validate mode.

### Refresh Mode (`/test-plan --refresh`)

Re-analyzes the task after implementation changes. Updates specs, removes obsolete ones, adds new ones discovered from the actual implementation. Uses the same verdicts as full mode.

## Lifecycle Rules

1. **Full plan (`/test-plan --task="..."`):** If `plan-latest.json` exists, archive it to `plan-{planId}.json` using the existing file's `planId`. Write fresh `plan-latest.json` with all specifications.

2. **Validate (`/test-plan --validate`):** Read `plan-latest.json`, run tests, add the `validation` field. Mutate in place, bump `timestamp`.

3. **Refresh (`/test-plan --refresh`):** Read `plan-latest.json`, re-analyze, update specifications. Archive old, write new `plan-latest.json`.

## Example Plan File

```json
{
  "planId": "b7e4f1a2",
  "timestamp": "2026-02-18T10:30:00Z",
  "mode": "full",
  "taskContext": {
    "description": "Implement vendor CRUD service with rating calculation",
    "entity": "vendor",
    "package": "packages/api",
    "layer": "service"
  },
  "verdict": "READY",
  "summary": {
    "total": 18,
    "p1": 8,
    "p2": 7,
    "p3": 3,
    "byAnalyst": {
      "contract-compliance": 7,
      "boundary-validation": 6,
      "state-lifecycle": 2,
      "integration-surface": 3
    },
    "byCategory": {
      "happy-path": 5,
      "error-path": 6,
      "edge-case": 3,
      "state-transition": 2,
      "integration": 2
    }
  },
  "generatedFiles": [
    {
      "path": "packages/api/src/services/vendor.service.test.ts",
      "testCount": 15,
      "todoCount": 15
    },
    {
      "path": "packages/api/src/routers/vendor.router.test.ts",
      "testCount": 3,
      "todoCount": 3
    }
  ],
  "reportPath": "docs/test-plans/2026-02-18-vendor-service-b7e4f1a2.md",
  "specifications": []
}
```
