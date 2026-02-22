# Project Configuration

The test-plan skill adapts to any project by reading configuration from three sources (in priority order):

1. **`.test-plan/config.json`** — explicit overrides (analyst selection, layer mappings)
2. **`CLAUDE.md`** — project conventions (error handling, shared package, testing patterns)
3. **Workspace structure** — inferred from `pnpm-workspace.yaml`, `package.json` workspaces, or directory layout

## `.test-plan/config.json`

Projects place this file in the repo root. All fields are optional.

```json
{
  "teams": {
    "team-1": {
      "name": "API",
      "paths": ["packages/api", "packages/mcp-server"]
    },
    "team-2": {
      "name": "Web",
      "paths": ["apps/web", "packages/ui"]
    },
    "team-3": {
      "name": "Database",
      "paths": ["packages/db"]
    },
    "team-4": {
      "name": "Mobile",
      "paths": ["apps/mobile"]
    }
  },
  "sharedPackage": "packages/shared",
  "sourceRoots": ["packages/*/src", "apps/*/src", "apps/*/app"],
  "testFramework": "vitest",
  "testFilePattern": "{source}.test.ts",
  "analysts": {
    "contract-compliance": { "enabled": true },
    "state-lifecycle": { "enabled": true },
    "boundary-validation": { "enabled": true },
    "integration-surface": { "enabled": true }
  },
  "layerDetection": {
    "service": ["**/services/**/*.ts"],
    "router": ["**/routers/**/*.ts"],
    "schema": ["**/schema/**/*.ts"],
    "component": ["**/*.tsx"]
  }
}
```

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `teams` | `Record<string, { name, paths }>` | inferred | Team-to-path mappings |
| `sharedPackage` | `string` | auto-detect | Path to the shared/common package |
| `sourceRoots` | `string[]` | auto-detect | Glob patterns for source directories |
| `testFramework` | `string` | `"vitest"` | Test framework (`vitest`, `jest`) |
| `testFilePattern` | `string` | `"{source}.test.ts"` | How test files are named relative to source |
| `analysts.{name}.enabled` | `boolean` | `true` | Enable/disable an analyst |
| `layerDetection` | `Record<string, string[]>` | see above | Glob patterns to detect target layer |

### `.test-plan/` Directory

```
.test-plan/
├── config.json               # project config (checked in)
├── plan-latest.json           # active plan (mutable, gitignored)
└── plan-{planId}.json         # archived snapshots (gitignored)
```

Add to `.gitignore`:
```
.test-plan/plan-*.json
```

The `config.json` file IS checked in — it's shared project configuration.

## Inference Rules

When no config exists, the orchestrator infers structure.

### Layer Detection

Based on file path patterns:
- **service**: `**/services/**/*.ts`, `**/service.ts`
- **router**: `**/routers/**/*.ts`, `**/router.ts`, `**/routes/**/*.ts`
- **schema**: `**/schema/**/*.ts`, `**/schemas/**/*.ts`
- **component**: `**/*.tsx` in UI packages

When the task description mentions "service", "router", "schema", or "component", use that as the primary layer. Otherwise, infer from the target package.

### Analyst Selection by Layer

| Target Layer | Analysts |
|-------------|----------|
| service | contract-compliance, state-lifecycle, boundary-validation, integration-surface |
| router | contract-compliance, boundary-validation, integration-surface |
| schema | contract-compliance, boundary-validation |
| component | contract-compliance, boundary-validation, integration-surface |

### Entity Detection

Extract the primary entity from the task description:
- "Implement **vendor** CRUD service" → entity: `vendor`
- "Add **RFI** status transitions" → entity: `rfi`
- "Create **change-order** approval workflow" → entity: `change-order`

## How Analysts Use Project Context

Analysts do NOT hardcode project-specific conventions. Instead they:

1. **Read `CLAUDE.md`** to learn:
   - Error handling pattern (AppError, ErrorCode)
   - Shared package conventions (@buildflow/shared)
   - Testing conventions (Vitest, behavior-focused)
   - Logging conventions (logger, not console.log)

2. **Read Zod schemas** from the shared package to:
   - Enumerate required vs optional fields
   - Identify validation constraints (min, max, email, uuid)
   - Map field types to assertion types

3. **Read DB schema** from the database package to:
   - Identify status enum values and valid transitions
   - Find foreign key relationships
   - Discover default values and computed columns

4. **Read reference implementations** (existing services/routers) to:
   - Match function signatures
   - Follow established patterns
   - Identify test setup conventions
