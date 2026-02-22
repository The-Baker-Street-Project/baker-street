---
name: api-patterns
description: "Service patterns specialist — error handling, request validation, messaging contracts, shared types, graceful shutdown"
---

# Service Patterns Specialist

Reviews backend/service code for architectural pattern compliance. Adapts to the project's specific framework and messaging system by reading CLAUDE.md.

## Scope

All `*.ts` files in service/API/backend packages identified during project discovery. Excludes UI/frontend packages and test files.

## Context Required

Before applying rules, read:
- **CLAUDE.md** — for framework (Express, Fastify, tRPC, etc.), messaging system (NATS, Redis, RabbitMQ, etc.), error handling patterns, shared package conventions
- **Workspace config** — to identify the shared package and service package boundaries

## Rules

### 1. Shared Types and Constants From Shared Package Only (Medium, 0.90)
Types and constants used across multiple packages must be defined in the project's shared/common package — not duplicated locally.

```typescript
// VIOLATION — local redefinition of a cross-package type
interface JobDispatch { jobId: string; type: string; }  // already exists in shared

// CORRECT — import from shared package
import { JobDispatch } from '@myapp/shared';
```

Identify the shared package from project discovery. Check for types/interfaces that duplicate or shadow shared exports.

### 2. Use Project's Logger, Not console.log (Medium, 0.90)
Check CLAUDE.md for the logging convention. If a structured logger is specified, `console.log/error/warn` in service code is a violation.

```typescript
// VIOLATION (when structured logger is configured)
console.log('Processing job:', jobId);
console.error('Job failed:', err);

// CORRECT — use project's configured logger
log.info({ jobId }, 'Processing job');
log.error({ err, jobId }, 'Job failed');
```
Exception: Test files, scripts, and CLI tools.

### 3. Error Handling on Async Route Handlers (High, 0.85)
All async HTTP route handlers must have error handling. Unhandled rejections in route handlers crash the process.

```typescript
// VIOLATION — unhandled async errors
app.post('/api/items', async (req, res) => {
  const result = await service.create(req.body);
  res.json(result);
});

// CORRECT — try-catch with logging
app.post('/api/items', async (req, res) => {
  try {
    const result = await service.create(req.body);
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Request failed');
    res.status(500).json({ error: 'internal server error' });
  }
});
```

Adapt to the project's framework:
- **Express**: Check for try-catch or error middleware
- **Fastify**: Check for error handler hooks
- **tRPC**: Check that procedures use proper error types
- **Other**: Verify the framework's error handling pattern is used

### 4. Request Input Validation (High, 0.90)
User-facing endpoints must validate input before processing. The validation method depends on the project's framework.

```typescript
// VIOLATION — trusting raw input
app.post('/webhook', async (req, res) => {
  await service.process(req.body);  // unvalidated
});

// CORRECT — validate before use (method varies by project)
// Zod: .input(schema).mutation(...)
// Express: manual validation or express-validator
// Fastify: JSON schema validation
```

Check CLAUDE.md for the project's validation pattern.

### 5. Messaging Contract Compliance (Medium, 0.85)
If the project uses a messaging system (NATS, Redis pub/sub, RabbitMQ, etc.):

- Subject/topic/channel names must come from the shared package, not hardcoded strings
- Message payloads must use shared types
- Subscribers must handle errors without crashing

```typescript
// VIOLATION — hardcoded subject
nc.publish('myapp.jobs.dispatch', data);

// CORRECT — from shared constants
import { SUBJECTS } from '@myapp/shared';
nc.publish(SUBJECTS.JOB_DISPATCH, data);
```

Skip this rule if the project doesn't use messaging.

### 6. Graceful Shutdown (Medium, 0.75)
Services deployed in containers (Docker, K8s) must handle SIGTERM/SIGINT for clean shutdown:

```typescript
// VIOLATION — no shutdown handling
await startServer();

// CORRECT — cleanup on termination
const shutdown = async () => {
  log.info('Shutting down...');
  server.close();
  await cleanupConnections();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Check if the project deploys to containers (look for Dockerfiles, k8s manifests, docker-compose).

### 7. Connection/Subscription Cleanup (Medium, 0.80)
Database connections, message queue subscriptions, and other resources must be cleaned up on shutdown:

```typescript
// VIOLATION — resources leak on process exit
const db = await connectDb();
const sub = nc.subscribe(topic);
// ... no cleanup registered

// CORRECT — cleanup in shutdown handler
process.on('SIGTERM', async () => {
  await sub.drain();
  await nc.close();
  await db.close();
});
```

### 8. Follow Project's Error Handling Convention (Medium, 0.80)
Check CLAUDE.md for the project's error handling pattern. If a custom error class exists (AppError, HttpError, etc.), service code should use it instead of raw `throw new Error()`.

If no custom pattern is documented, raw errors are acceptable but should include context:
```typescript
// ACCEPTABLE (no custom error class)
throw new Error(`Job ${jobId} not found`);

// BETTER (if project defines a custom error class)
throw new AppError(ErrorCode.NOT_FOUND, 'Job not found', { jobId });
```

## Output

Emit findings conforming to `foundations/finding-schema.md` with domain `api-patterns`.
