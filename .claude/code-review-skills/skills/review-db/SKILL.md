---
name: review-db
description: "Database schema compliance checker. Reads CLAUDE.md for ORM conventions and verifies: primary keys, timestamps, indexes, relations, type exports, naming conventions."
---

# /review-db — Database Schema Compliance Checker

**Purpose:** Quick manual verification that database schema code follows the project's conventions before PRs.

## When to Run

- Before creating any PR that touches database schema files
- After completing any new table or migration
- When reviewing database-related work

## How It Works

1. **Read `CLAUDE.md`** to discover the project's database conventions:
   - ORM (Drizzle, Prisma, TypeORM, Knex, raw SQL, etc.)
   - Primary key pattern (UUID, auto-increment, ULID, etc.)
   - Timestamp conventions (created_at/updated_at, managed by ORM or manually)
   - Naming convention (snake_case columns, etc.)
   - Schema file location
   - Migration strategy

2. **Identify database packages** from the workspace config

3. **Run the checks below** adapted to the project's ORM

## Checks Performed

### 1. Primary Key Pattern

Verify all tables use the project's standard PK pattern:

```bash
# Drizzle: uuid('id').primaryKey().defaultRandom()
# Prisma: id String @id @default(uuid())
# Check CLAUDE.md for the specific pattern
grep -rn "primaryKey\|@id" --include="*.ts" {schema-dir}/
```

**Pass:** All tables use the standard PK pattern.
**Fail:** Report tables with non-standard PKs.

### 2. Timestamps on Every Table

Verify all tables have created/updated timestamps:

```bash
grep -rn "created_at\|createdAt\|updated_at\|updatedAt" --include="*.ts" {schema-dir}/
```

**Pass:** All tables have both timestamps.
**Fail:** Report tables missing timestamps.

### 3. Foreign Key Indexes

Many ORMs do NOT auto-index FK columns. Verify indexes exist:

```bash
# Find FK references
grep -rn "references\|@relation\|foreignKey" --include="*.ts" {schema-dir}/

# Find indexes
grep -rn "index\|@@index\|createIndex" --include="*.ts" {schema-dir}/
```

**Pass:** Every FK column has a corresponding index.
**Fail:** Report FK columns missing indexes.

### 4. Relations Defined

Verify all entity schemas define their relationships:

```bash
grep -rn "relations\|@relation\|hasMany\|belongsTo\|hasOne" --include="*.ts" {schema-dir}/
```

**Pass:** All entity files have relations defined.
**Fail:** Report schema files missing relations.

### 5. Types Exported

Verify schema files export inferred/generated types for use in application code:

```bash
# Drizzle: $inferSelect, $inferInsert
# Prisma: auto-generated
# Check for type exports in schema files
grep -rn "export type\|\$inferSelect\|\$inferInsert" --include="*.ts" {schema-dir}/
```

**Pass:** All schema files export both select and insert types.
**Fail:** Report files missing type exports.

### 6. Column Naming Convention

Verify SQL column names follow the project's convention (typically snake_case):

```bash
# Check column name strings in schema definitions
# Look for camelCase in SQL column names (common mistake)
```

**Pass:** All column names follow convention.
**Fail:** Report naming violations.

## Output Format

```
## Database Review Results

### Summary
- Total checks: 6
- Passed: X
- Failed: X

### Violations

#### [FAIL] Missing FK Index
- src/schema/orders.ts — vendor_id has no index

#### [PASS] Primary Keys
All tables use standard PK pattern.

#### [PASS] Timestamps
All tables have created_at and updated_at.
```

## Integration

This is a focused manual check for database work. For comprehensive automated review, use `/code-review` which includes database-related patterns in its specialists.
