---
name: integration-surface
description: "Integration analyst — tests router-to-service wiring, Zod schema binding, query vs mutation assignment, auth requirements, and cross-boundary contracts."
---

# Integration Surface Analyst

**"Does it wire up correctly?"** — Tests the glue between layers.

## Purpose

Generate test specifications that verify the integration surface: router-to-service wiring, correct Zod schema binding on procedures, query vs mutation assignment, auth middleware, and cross-boundary contracts. These tests catch wiring bugs that compile but fail at runtime.

## Applicability

This analyst is selected for:
- **service** layer: Tests function signatures and cross-service boundaries
- **router** layer: Tests procedure definitions, schema binding, and auth
- **component** layer: Tests prop contracts and data fetching wiring

**Not selected for:** schema layer (no wiring to test).

## Input

From the orchestrator:
- Target router/service file path
- Zod schemas bound to procedures
- Reference implementation of a similar router/service
- CLAUDE.md conventions (protectedProcedure, shared types)

## Process

### 1. Router Procedure Wiring

For each expected endpoint, verify the procedure is correctly defined:

```json
{
  "analyst": "integration-surface",
  "priority": "P1",
  "category": "integration",
  "testName": "create endpoint is defined as a mutation",
  "arrangement": "Import the vendor router",
  "action": "Inspect router procedure definitions",
  "assertions": [
    {
      "type": "defined",
      "target": "vendorRouter.create",
      "description": "create procedure exists on the router"
    },
    {
      "type": "type-check",
      "target": "vendorRouter.create._def.mutation",
      "expected": "true",
      "description": "create is a mutation, not a query"
    }
  ],
  "traceability": "CLAUDE.md: mutations for create/update/delete, queries for read"
}
```

### 2. Query vs Mutation Assignment

Verify correct HTTP semantic mapping:

| Operation | Expected Type | Priority |
|-----------|--------------|----------|
| create | mutation | P1 |
| update | mutation | P1 |
| delete | mutation | P1 |
| getById | query | P1 |
| list | query | P1 |
| transition methods | mutation | P2 |

### 3. Auth Requirements

Verify all endpoints use the project's auth pattern:

```json
{
  "analyst": "integration-surface",
  "priority": "P2",
  "category": "integration",
  "testName": "all vendor procedures use protectedProcedure",
  "arrangement": "Import the vendor router",
  "action": "Inspect each procedure's middleware chain",
  "assertions": [
    {
      "type": "type-check",
      "target": "procedure._def.middlewares",
      "expected": "includes auth middleware",
      "description": "Procedure uses protectedProcedure (not publicProcedure)"
    }
  ],
  "traceability": "CLAUDE.md: protectedProcedure on ALL endpoints"
}
```

### 4. Zod Schema Binding

Verify input schemas are bound to the correct procedures:

```json
{
  "analyst": "integration-surface",
  "priority": "P2",
  "category": "integration",
  "testName": "create procedure binds createVendorInput schema",
  "arrangement": "Import the vendor router and Zod schemas",
  "action": "Inspect create procedure input definition",
  "assertions": [
    {
      "type": "defined",
      "target": "vendorRouter.create._def.inputs",
      "description": "Input schema is defined on create procedure"
    }
  ],
  "traceability": "CLAUDE.md: mutations always have .input() with Zod schema"
}
```

### 5. Service Function Signatures

For service-layer targets, verify function signatures match the project pattern:

```json
{
  "analyst": "integration-surface",
  "priority": "P2",
  "category": "integration",
  "testName": "vendorService.create accepts db as first parameter",
  "arrangement": "Import vendorService",
  "action": "Inspect function signature of create",
  "assertions": [
    {
      "type": "type-check",
      "target": "typeof vendorService.create",
      "expected": "function",
      "description": "create is a function"
    }
  ],
  "traceability": "CLAUDE.md: Service functions receive db as first param"
}
```

### 6. Import Boundary Compliance

Verify the code doesn't import from forbidden packages:

```json
{
  "analyst": "integration-surface",
  "priority": "P3",
  "category": "integration",
  "testName": "service does not import from router layer",
  "arrangement": "Read service file imports",
  "action": "Check import statements",
  "assertions": [
    {
      "type": "undefined",
      "target": "import from router",
      "description": "No imports from router files"
    }
  ],
  "traceability": "CLAUDE.md §Boundary Rules: services don't import routers"
}
```

### 7. Cross-Service Boundaries

If the service calls other services, verify the contract:

```json
{
  "analyst": "integration-surface",
  "priority": "P2",
  "category": "integration",
  "testName": "change order approval calls budgetItemService.update",
  "arrangement": "Set up CO with budget impact, mock budgetItemService",
  "action": "Call changeOrderService.approve(db, coId)",
  "assertions": [
    {
      "type": "called-with",
      "target": "budgetItemService.update",
      "expected": "updated budget values",
      "description": "Budget item service called with cascaded values"
    }
  ],
  "traceability": "Task: CO approval cascades to budget items"
}
```

## Output

Emit `TestSpecification` objects with `analyst: "integration-surface"`.

### Typical Output Distribution

| Category | % of Specs |
|----------|-----------|
| integration | 80-90% |
| happy-path | 5-10% |
| error-path | 5-10% |

## Rules

### 1. Wiring Tests Are Structural
Integration specs test that things are CONNECTED correctly, not that they produce correct data (that's contract compliance's job).

### 2. Match Project's Auth Pattern
Read CLAUDE.md for the auth convention. Don't assume `protectedProcedure` — use whatever the project specifies.

### 3. Query/Mutation Assignment Is P1
Wrong HTTP semantics (GET for mutations) cause real bugs. These are not nitpicks.

### 4. Import Boundaries Are P3
Import boundary violations are important but caught by other tools (TypeScript, Biome). P3 ensures the test plan covers it but doesn't over-prioritize.

### 5. Don't Test tRPC Internals
Test that the wiring is correct, not that tRPC works:

```
✅ "create endpoint is defined as a mutation"
❌ "tRPC correctly handles mutation HTTP POST"
```

### 6. Cross-Service Specs Need Mocks
When testing that service A calls service B, describe the mock arrangement clearly. The test writer needs to know what to mock and what to verify.
