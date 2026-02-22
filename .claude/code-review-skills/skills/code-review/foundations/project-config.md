# Project Configuration

The code review skill adapts to any project by reading configuration from three sources (in priority order):

1. **`.code-review/config.json`** — explicit overrides (team mappings, scope)
2. **`CLAUDE.md`** — project conventions (logging, error handling, key patterns)
3. **Workspace structure** — inferred from `pnpm-workspace.yaml`, `package.json` workspaces, or directory layout

## `.code-review/config.json` (Optional)

Projects may place this file in the repo root. All fields are optional.

```json
{
  "teams": {
    "team-1": {
      "name": "Core",
      "paths": ["services/brain", "packages/shared"]
    },
    "team-2": {
      "name": "Execution",
      "paths": ["services/worker", "plugins/*"]
    },
    "team-3": {
      "name": "Interface",
      "paths": ["services/gateway", "services/ui"]
    }
  },
  "sharedPackage": "packages/shared",
  "sourceRoots": ["packages/*/src", "services/*/src", "plugins/*/src"],
  "specialists": {
    "api-patterns": {
      "enabled": true,
      "extraScope": ["lib/server/**"]
    },
    "ui-design-compliance": {
      "enabled": true,
      "scope": ["apps/web/src/**/*.tsx"]
    },
    "test-quality": {
      "enabled": true
    }
  }
}
```

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `teams` | `Record<string, { name: string, paths: string[] }>` | inferred | Team-to-path mappings for `--scope=team` |
| `sharedPackage` | `string` | auto-detect | Path to the shared/common package (cross-import boundary) |
| `sourceRoots` | `string[]` | auto-detect from workspaces | Glob patterns for source directories |
| `specialists.{name}.enabled` | `boolean` | `true` | Enable/disable a specialist |
| `specialists.{name}.scope` | `string[]` | see specialist SKILL.md | Override the specialist's default scope |
| `specialists.{name}.extraScope` | `string[]` | `[]` | Add paths to the specialist's default scope |

### `.code-review/` Directory

```
.code-review/
├── config.json               # project config (optional, checked in)
├── review-latest.json        # active verdict (mutable, gitignored)
├── review-{reviewId}.json    # archived snapshots (gitignored)
└── abort-reason.md           # only if ABORT triggered (gitignored)
```

Add to `.gitignore`:
```
.code-review/review-*.json
.code-review/abort-reason.md
```

The `config.json` file IS checked in — it's shared project configuration.

## Inference Rules

When no config exists, the orchestrator infers structure:

### Workspace Detection
1. Read `pnpm-workspace.yaml` → extract `packages:` globs
2. Else read root `package.json` → extract `workspaces` field
3. Else scan for `*/package.json` at depth 1-2

### Shared Package Detection
Look for a workspace package whose name contains `shared`, `common`, or `core`, or whose path is `packages/shared`, `libs/shared`, etc.

### Team Inference (Fallback)
If no `teams` config exists, `--scope=team` is unavailable. The orchestrator will report this and suggest creating a config.

## How Specialists Use Project Context

Specialists do NOT hardcode project-specific conventions. Instead they:

1. **Read `CLAUDE.md`** at the start of each review to learn:
   - Logging conventions (what logger, what patterns)
   - Error handling conventions
   - Import rules and package boundaries
   - Framework-specific patterns (Express, Fastify, tRPC, etc.)
   - Key architectural decisions

2. **Read workspace config** to understand:
   - Package boundaries (what can import what)
   - Source root locations
   - Shared package identity

3. **Apply universal rules** that hold for any TypeScript project:
   - No `any` type
   - No unhandled errors in async code
   - No secrets in source
   - Tests exist for core logic
   - etc.

4. **Apply convention rules** derived from CLAUDE.md:
   - "Use the project's logger instead of console.log"
   - "Follow the project's error handling pattern"
   - "Import shared types from the designated shared package"
