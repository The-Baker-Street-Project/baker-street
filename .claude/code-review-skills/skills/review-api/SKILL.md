---
name: review-api
description: "API/service pattern compliance checker. Quick manual check for backend code. Reads CLAUDE.md for project-specific patterns and verifies: shared types usage, error handling, logging, auth, input validation."
---

# /review-api — API/Service Pattern Compliance Checker

**Purpose:** Quick manual verification that backend code follows the project's established patterns before PRs.

## When to Run

- Before creating any PR that touches backend/service code
- After completing any API route, service, or handler
- As a lightweight alternative to `/code-review` for focused backend checks

## How It Works

1. **Read `CLAUDE.md`** to discover the project's conventions:
   - Framework (Express, Fastify, tRPC, etc.)
   - Error handling pattern (custom error classes, raw errors, etc.)
   - Logging convention (pino, winston, console, etc.)
   - Shared package name and import conventions
   - Auth middleware pattern
   - Validation approach (Zod, Joi, manual, etc.)

2. **Identify backend packages** from the workspace config (pnpm-workspace.yaml or package.json workspaces)

3. **Run the checks below** against those packages

## Checks Performed

### 1. Shared Types — Not Locally Redefined

All cross-package types and schemas must come from the shared package:

```bash
# Find the shared package (read from CLAUDE.md or infer from workspace config)
# Then check for local type redefinitions that shadow shared exports
```

**Pass:** No local redefinitions of shared types.
**Fail:** Report file:line for locally defined types that exist in the shared package.

### 2. Error Handling Convention

Check CLAUDE.md for the project's error handling pattern, then verify compliance:

```bash
# If project uses a custom error class (AppError, HttpError, etc.):
# Find raw Error throws in service code (violations)
grep -rn "throw new Error(" --include="*.ts" {service-dirs}/

# If project uses raw errors, check they include context:
# throw new Error(`Entity ${id} not found`)  ← good
# throw new Error('not found')               ← bad (no context)
```

**Pass:** All errors follow the project's convention.
**Fail:** Report file:line for violations.

### 3. Logger Instead of console.log

```bash
# Check CLAUDE.md for logger convention, then:
grep -rn "console\.log\|console\.error\|console\.warn" --include="*.ts" {service-dirs}/
```

**Pass:** No console.* calls in production code (test files excluded).
**Fail:** Report file:line for console.* usage.

### 4. Auth on Endpoints

Check that API endpoints use the project's auth middleware:

```bash
# Look for routes without auth (pattern depends on framework)
# Express: routes without authMiddleware
# tRPC: publicProcedure instead of protectedProcedure
# Fastify: routes without preHandler auth hook
```

**Pass:** All sensitive routes use auth.
**Fail:** Report unprotected routes.

### 5. Input Validation

Check that user-facing endpoints validate input:

```bash
# Express: check for raw req.body usage without validation
# tRPC: check for mutations without .input()
# Fastify: check for routes without JSON schema
```

**Pass:** All endpoints validate input.
**Fail:** Report endpoints with unvalidated input.

### 6. Async Error Handling

Check that async route handlers have proper error handling:

```bash
# Find async handlers without try-catch (Express)
# Or without error middleware registration
```

**Pass:** All async handlers have error handling.
**Fail:** Report unprotected async handlers.

## Output Format

```
## API Review Results

### Summary
- Total checks: 6
- Passed: X
- Failed: X

### Violations

#### [FAIL] Raw Error Throws
- src/services/auth.ts:45 — throw new Error(), use project's error convention

#### [PASS] Logger Usage
No console.* calls found.

#### [PASS] Auth Middleware
All routes use auth middleware.

### Recommendations
1. Replace Error with project's error convention
```

## Integration

The `/code-review` skill provides a more comprehensive, structured version of these checks with severity ratings and verdict files. Use `/review-api` for quick manual checks during development; use `/code-review` for formal pre-PR review.
