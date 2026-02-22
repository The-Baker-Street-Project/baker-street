---
name: typescript-quality
description: "TypeScript quality specialist — strict mode compliance, type safety, import hygiene, ESM patterns"
---

# TypeScript Quality Specialist

Reviews all TypeScript/TSX files for type safety, strict mode compliance, and import hygiene. These rules are universal to any TypeScript project.

## Scope

All `*.ts` and `*.tsx` files in source roots identified during project discovery (see orchestrator's Project Discovery step).

## Context Required

Before applying rules, read:
- **CLAUDE.md** — for project-specific import conventions, package boundaries, logging patterns
- **Workspace config** — to identify package boundaries and the shared package

## Rules

### 1. No `any` Type (High, 0.92+)
```typescript
// VIOLATION
const data: any = response;
function process(input: any): any { ... }

// ALLOWED
const data: unknown = response;
function process(input: unknown): ProcessedData { ... }
```
Exception: Third-party library types that genuinely require `any` (must have justifying comment).

### 2. No `@ts-ignore` Without Justification (Medium, 0.90+)
```typescript
// VIOLATION
// @ts-ignore
const value = obj.prop;

// ALLOWED — @ts-expect-error with explanation
// @ts-expect-error — library types incompatible with current TS version, see issue #42
const value = obj.prop;
```

### 3. No `console.log` in Production Code (Medium, 0.90)
Check CLAUDE.md for the project's logging convention. If a structured logger is configured (pino, winston, bunyan, etc.), console.log is a violation in service code.
```typescript
// VIOLATION (when project has a configured logger)
console.log('debug:', data);
console.error('failed');

// CORRECT — use project's logger (example shown; actual import from CLAUDE.md)
log.debug({ data }, 'Processing');
log.error({ err }, 'Operation failed');
```
Exception: Test files, scripts, and CLI tools may use console.

### 4. No Cross-Package Boundary Imports (High, 0.95)
Workspace packages must not import directly from each other's internals — only from the designated shared package or via the package's public exports.

Identify boundaries from the workspace config. The shared package (auto-detected or from `.code-review/config.json`) is always importable by all packages.

```typescript
// VIOLATIONS — importing across workspace boundaries
import { something } from '../../../other-package/src/internal';  // relative cross-boundary
import { handler } from '@myapp/server';  // in a client package

// ALLOWED
import { SharedType } from '@myapp/shared';        // shared package
import { type AppRouter } from '@myapp/server';     // type-only imports (no runtime coupling)
```

### 5. ESM Import Extensions (Medium, 0.85)
For projects using TypeScript ESM (`"type": "module"` in package.json with `NodeNext` module resolution), relative imports require `.js` extensions:
```typescript
// VIOLATION (in ESM projects)
import { createAgent } from './agent';

// CORRECT
import { createAgent } from './agent.js';
```
Exception: Package imports (bare specifiers like `pino`, `express`) do not need extensions. Skip this rule entirely if the project uses CJS or bundler module resolution.

### 6. `noUncheckedIndexedAccess` Compliance (Medium, 0.80)
```typescript
// VIOLATION
const items: string[] = getItems();
const first = items[0].toUpperCase(); // items[0] could be undefined

// CORRECT
const first = items[0];
if (first) {
  return first.toUpperCase();
}
```
Only apply if the project's tsconfig has `noUncheckedIndexedAccess: true` or `strict: true` with this enabled.

### 7. Non-null Assertion Hiding Real Bugs (Medium, 0.75)
```typescript
// SUSPICIOUS
const user = users.find(u => u.id === id)!;
return user.name;

// BETTER
const user = users.find(u => u.id === id);
if (!user) {
  throw new Error(`User ${id} not found`);
}
return user.name;
```
Confidence lower because non-null assertions are sometimes legitimate (e.g., after a guard clause in a parent scope).

### 8. Unused Imports and Variables (Low, 0.90)
```typescript
// VIOLATION
import { foo, bar } from './utils.js';  // bar never used
const unused = computeValue();           // unused never read
```
Most projects catch this via linting — only flag if no linter is configured.

## Output

Emit findings conforming to `foundations/finding-schema.md` with domain `typescript-quality`.
