# Sprint 4: Tool Lazy Loading, Backup, K8s Detection, Standing Orders & Saved Prompts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce tool context overhead with lazy loading, add nightly backup/restore for brain state, improve installer K8s detection, enhance the standing orders system, and add saved prompts.

**Architecture:** Five independent features. Tool lazy loading (BAK-41) modifies the brain's agent loop to defer extension tools. Backup (BAK-42) adds a K8s CronJob + restore script. K8s detection (BAK-44) enhances installer preflight. Standing orders (BAK-12) extends the existing schedule system with delivery modes and self-healing. Saved prompts (BAK-24) adds a new DB table + brain tools + UI slash command handling.

**Tech Stack:** TypeScript ESM, Node.js 22, Rust (installer), Kubernetes, SQLite, Qdrant REST API, pnpm workspaces

---
<!-- Validated: 2026-03-04 | Design ✅ | Dev ✅ | Security ✅ | Backlog ✅ -->

## Task Order & Dependencies

| # | Ticket | Task | Depends On |
|---|--------|------|------------|
| 1 | BAK-41 | Tool Search Index (brain-side) | — |
| 2 | BAK-41 | Dual-strategy tool resolution | Task 1 |
| 3 | BAK-41 | Dynamic tool injection in agent loop | Task 2 |
| 4 | BAK-42 | Backup CronJob container & manifests | — |
| 5 | BAK-42 | Restore script | Task 4 |
| 6 | BAK-44 | K8s context detection & picker | — |
| 7 | BAK-12 | Standing orders: delivery & self-healing | — |
| 8 | BAK-24 | Saved prompts: DB + brain tools | — |
| 9 | BAK-24 | Saved prompts: UI slash command handling | Task 8 |

**Parallel groups:** Tasks 1, 4, 6, 7, 8 can start in parallel. Within each ticket, tasks are sequential.

---

## Task 1: Tool Search Index — brain-side search (BAK-41)

**Files:**
- Create: `services/brain/src/tool-search.ts`
- Test: `services/brain/src/tool-search.test.ts`

**Context:** Currently `resolveAllTools()` in `agent.ts:658-679` collects ALL tools (built-in + schedule + unified registry) and sends them all to the LLM on every call. Extension tools alone can be 83+ tools (~41K tokens). We need a search index that holds full schemas in memory but only exposes a single `search_tools` tool to the LLM for non-Anthropic providers.

**Step 1: Write the failing tests**

```typescript
// services/brain/src/tool-search.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolSearchIndex } from './tool-search.js';
import type { ToolDefinition } from '@bakerst/shared';

function makeTool(name: string, description: string): ToolDefinition {
  return { name, description, input_schema: { type: 'object' } };
}

describe('ToolSearchIndex', () => {
  let index: ToolSearchIndex;

  beforeEach(() => {
    index = new ToolSearchIndex();
  });

  it('returns empty array when no tools registered', () => {
    expect(index.search('anything')).toEqual([]);
  });

  it('indexes tools by server and finds by name match', () => {
    index.add('github', [
      makeTool('github_create_issue', 'Create a new GitHub issue'),
      makeTool('github_list_repos', 'List GitHub repositories'),
    ]);
    const results = index.search('create issue');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('github_create_issue');
  });

  it('scores server name matches', () => {
    index.add('github', [makeTool('create_item', 'Create something')]);
    index.add('browser', [makeTool('open_page', 'Open a web page')]);
    const results = index.search('github');
    expect(results[0].server).toBe('github');
  });

  it('removes tools by server', () => {
    index.add('github', [makeTool('github_create_issue', 'Create issue')]);
    index.remove('github');
    expect(index.search('github')).toEqual([]);
  });

  it('respects limit parameter', () => {
    index.add('test', Array.from({ length: 20 }, (_, i) =>
      makeTool(`tool_${i}`, `Tool number ${i} for testing`),
    ));
    const results = index.search('tool', 3);
    expect(results).toHaveLength(3);
  });

  it('returns full schema in results', () => {
    const tool = makeTool('my_tool', 'Does something');
    index.add('srv', [tool]);
    const results = index.search('my_tool');
    expect(results[0].fullSchema).toEqual(tool);
  });

  it('generates the search_tools tool definition', () => {
    const def = index.getSearchToolDefinition();
    expect(def.name).toBe('search_tools');
    expect(def.input_schema.properties).toHaveProperty('query');
  });

  it('count returns total indexed tools', () => {
    index.add('a', [makeTool('t1', 'd1')]);
    index.add('b', [makeTool('t2', 'd2'), makeTool('t3', 'd3')]);
    expect(index.count()).toBe(3);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd services/brain && npx vitest run src/tool-search.test.ts`
Expected: FAIL — module `./tool-search.js` not found

**Step 3: Implement ToolSearchIndex**

```typescript
// services/brain/src/tool-search.ts
import type { ToolDefinition } from '@bakerst/shared';

export interface ToolIndexEntry {
  name: string;
  description: string;
  server: string;
  fullSchema: ToolDefinition;
}

export class ToolSearchIndex {
  private entries: ToolIndexEntry[] = [];

  /** Register tools from a server (extension, plugin, etc.) */
  add(server: string, tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.entries.push({
        name: tool.name,
        description: tool.description,
        server,
        fullSchema: tool,
      });
    }
  }

  /** Remove all tools from a server (e.g. extension disconnect) */
  remove(server: string): void {
    this.entries = this.entries.filter((e) => e.server !== server);
  }

  /** Search tools by keyword. Scores name (3x), server (2x), description (1x). */
  search(query: string, limit = 5): ToolIndexEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    return this.entries
      .map((entry) => {
        const nameLower = entry.name.toLowerCase();
        const descLower = entry.description.toLowerCase();
        const serverLower = entry.server.toLowerCase();

        let score = 0;
        for (const term of terms) {
          if (nameLower.includes(term)) score += 3;
          if (serverLower.includes(term)) score += 2;
          if (descLower.includes(term)) score += 1;
        }
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  /** Total indexed tools */
  count(): number {
    return this.entries.length;
  }

  /** The single tool definition exposed to the LLM */
  getSearchToolDefinition(): ToolDefinition {
    // Build a category summary from registered servers
    const servers = [...new Set(this.entries.map((e) => e.server))];
    const categoryHint = servers.length > 0
      ? ` Available categories: ${servers.join(', ')}.`
      : '';

    return {
      name: 'search_tools',
      description:
        'Search for available tools by keyword or capability.' +
        categoryHint +
        ' Call this before attempting to use an extension tool.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: "What you want to do, e.g. 'create a github issue' or 'browse a website'",
          },
          limit: {
            type: 'number',
            description: 'Max results (default 5)',
          },
        },
        required: ['query'],
      },
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd services/brain && npx vitest run src/tool-search.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add services/brain/src/tool-search.ts services/brain/src/tool-search.test.ts
git commit -m "feat(brain): add ToolSearchIndex for lazy tool loading (BAK-41)"
```

---

## Task 2: Dual-strategy tool resolution (BAK-41)

**Files:**
- Modify: `services/brain/src/agent.ts:658-679` (resolveAllTools)
- Modify: `packages/shared/src/model-types.ts:130-138` (ToolDefinition — add optional `defer_loading`)
- Test: `services/brain/src/tool-search.test.ts` (add integration test)

**Context:** `resolveAllTools()` currently returns all tools in a flat array. We need to split tools into "core" (always sent) and "extension" (deferred), then choose strategy based on the active model's provider. The model provider is determined by `resolveModel()` in model-router.ts — each `ModelDefinition` has a `provider` field that maps to a provider config key.

**Step 1: Add `defer_loading` to ToolDefinition**

In `packages/shared/src/model-types.ts`, add the optional field:

```typescript
// packages/shared/src/model-types.ts:130-138
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** Anthropic-only: defer this tool's schema from context until discovered via tool_search */
  defer_loading?: boolean;
}
```

**Step 2: Modify resolveAllTools to return stratified tools**

Replace `resolveAllTools()` in `agent.ts` with a version that accepts a provider hint and returns the appropriate tool set.

The key insight: we don't know the provider at tool resolution time (it depends on conversation-level model override). So instead, we resolve all tools and tag extension tools, then `buildToolsForRequest()` filters at call time.

Add to `agent.ts` after the existing `resolveAllTools`:

```typescript
// New: import at top of agent.ts
import { ToolSearchIndex } from './tool-search.js';

// New: create tool search index instance (after createAgent function opening)
const toolSearchIndex = new ToolSearchIndex();

// New: populate index when extensions connect
// In the existing extensionManager callbacks or after resolveAllTools:
function updateToolSearchIndex(unifiedTools: ToolDefinition[]): void {
  // Clear and re-populate from unified registry
  // Extension tools have names like "github_*", "browser_*" etc.
  // We tag by the skill/extension source
  toolSearchIndex.remove('extensions');
  toolSearchIndex.add('extensions', unifiedTools);
}
```

Add a new function `buildToolsForRequest()` **inside the `createAgent` closure** (so it has access to `tools`, `scheduleManager`, `standingOrderTools`):

```typescript
/**
 * Given the resolved model's provider, build the tools array for the LLM call.
 * - Anthropic: send all tools with defer_loading=true on extension tools + native search tool
 * - Others: send core tools + search_tools only; extension tools held in search index
 *
 * IMPORTANT: This must be defined inside createAgent() to access closure variables.
 */
function buildToolsForRequest(
  allTools: ToolDefinition[],
  providerType: string,
  activatedTools: ToolDefinition[],
): { tools: ToolDefinition[]; usesSearchIndex: boolean } {
  // Core tools = built-in brain tools + schedule tools (always small, ~10-15)
  // Extension tools = everything from unified registry
  // `tools` and `scheduleManager` are in scope from the createAgent closure
  const coreToolNames = new Set([
    ...tools.map((t) => t.name),
    ...(scheduleManager ? standingOrderTools.map((t) => t.name) : []),
  ]);

  const coreTools = allTools.filter((t) => coreToolNames.has(t.name));
  const extensionTools = allTools.filter((t) => !coreToolNames.has(t.name));

  if (providerType === 'anthropic' || providerType === 'openrouter') {
    // Strategy 1: Anthropic native defer_loading
    return {
      tools: [
        ...coreTools,
        ...extensionTools.map((t) => ({ ...t, defer_loading: true })),
      ],
      usesSearchIndex: false,
    };
  }

  // Strategy 2: Brain-side search for OpenAI, Ollama, etc.
  // Update the search index with current extension tools
  toolSearchIndex.remove('extensions');
  if (extensionTools.length > 0) {
    toolSearchIndex.add('extensions', extensionTools);
  }

  return {
    tools: [
      ...coreTools,
      ...(extensionTools.length > 0 ? [toolSearchIndex.getSearchToolDefinition()] : []),
      ...activatedTools,
    ],
    usesSearchIndex: true,
  };
}
```

**Step 3: Write test for strategy selection**

Add to `tool-search.test.ts`:

```typescript
describe('buildToolsForRequest strategy selection', () => {
  // This is tested indirectly through integration — the key behavior is:
  // - Anthropic provider: all tools present, extension tools have defer_loading=true
  // - Other providers: only core + search_tools + activated tools
  // We verify the ToolSearchIndex is correctly populated and searched
  it('search index updates when extensions change', () => {
    const idx = new ToolSearchIndex();
    idx.add('ext', [makeTool('ext_a', 'Extension A')]);
    expect(idx.count()).toBe(1);
    idx.remove('ext');
    idx.add('ext', [makeTool('ext_b', 'Extension B'), makeTool('ext_c', 'Extension C')]);
    expect(idx.count()).toBe(2);
    expect(idx.search('ext_a')).toHaveLength(0);
    expect(idx.search('ext_b')).toHaveLength(1);
  });
});
```

**Step 4: Run tests**

Run: `cd services/brain && npx vitest run src/tool-search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/model-types.ts services/brain/src/agent.ts services/brain/src/tool-search.test.ts
git commit -m "feat(brain): dual-strategy tool resolution for lazy loading (BAK-41)"
```

---

## Task 3: Dynamic tool injection in agent loop (BAK-41)

**Files:**
- Modify: `services/brain/src/agent.ts:741-835` (chat loop) and `:887-1054` (chatStream loop)

**Context:** When using the brain-side search strategy (non-Anthropic), the model calls `search_tools`, we search the index, and inject matched tool schemas into the `tools` array for the next LLM iteration. This happens inside the existing agentic loop (max 10 iterations).

**Step 1: Modify the chat() loop**

In the `chat()` function at line 741, replace the loop to use `buildToolsForRequest`:

```typescript
// Before the loop (after resolving allTools):
let activatedTools: ToolDefinition[] = [];

for (let i = 0; i < maxIterations; i++) {
  const modelOverride = getConversationModelOverride(conversationId);

  // Resolve provider type for this request
  const resolvedModel = modelRouter.resolveModelDefinition('agent', modelOverride ?? undefined);
  const { tools: requestTools, usesSearchIndex } = buildToolsForRequest(
    allTools, resolvedModel.provider, activatedTools,
  );

  const response = await withSpan('brain.llm.call', { ... }, async () => {
    return modelRouter.chat({
      role: 'agent',
      system: systemBlocks,
      tools: requestTools,
      messages,
      ...(modelOverride ? { modelOverride } : {}),
    });
  });

  // ... existing end_turn handling ...

  if (response.stopReason === 'tool_use') {
    messages.push({ role: 'assistant', content: response.content });
    const toolResults: ChatContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCallCount++;

        // Handle search_tools specially when using brain-side search
        if (usesSearchIndex && block.name === 'search_tools') {
          const query = (block.input as { query: string; limit?: number }).query;
          const limit = (block.input as { query: string; limit?: number }).limit;
          const results = toolSearchIndex.search(query, limit);

          // Inject found tools for next iteration
          activatedTools = results.map((r) => r.fullSchema);

          const resultText = results.length > 0
            ? results.map((r) => `- ${r.name}: ${r.description}`).join('\n')
            : 'No matching tools found. Try different keywords.';

          log.info({ query, found: results.length, activated: activatedTools.map(t => t.name) }, 'tool search completed');

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Found ${results.length} tool(s):\n${resultText}\n\nThese tools are now available for use.`,
          });
          continue;
        }

        // ... existing guardrail + executeTool logic (unchanged) ...
      }
    }

    messages.push({ role: 'user', content: toolResults });
    continue;
  }
}
```

**Step 2: Add `resolveModelPublic` to ModelRouter**

The `resolveModel` method is private. Add a safe public method in `packages/shared/src/model-router.ts` that only takes the fields it needs (avoid unsafe cast):

```typescript
// Add after resolveModel() (line 762):
/** Resolve model definition by role and optional override. Used for tool strategy selection. */
resolveModelDefinition(role: keyof ModelRoles = 'agent', modelOverride?: string): ModelDefinition {
  const modelId = modelOverride ?? this.config.roles[role];
  if (!modelId) {
    throw new Error(`model-router: no model configured for role '${role}'`);
  }
  const model = this.config.models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`model-router: unknown model id '${modelId}' for role '${role}'`);
  }
  return model;
}
```

**Step 3: Apply same changes to chatStream() loop**

Mirror the `buildToolsForRequest` and `search_tools` handling in the `chatStream()` function (lines 887-1054). The pattern is identical — add `activatedTools` tracking and `search_tools` interception.

**Step 4: Run full brain test suite**

Run: `cd services/brain && npx vitest run`
Expected: All tests pass (except the 3 pre-existing failures in skill-registry.test.ts and api-routes.test.ts)

**Step 5: Manual verification**

Run: `pnpm -r build`
Expected: Clean build, no TypeScript errors

**Step 6: Commit**

```bash
git add services/brain/src/agent.ts packages/shared/src/model-router.ts
git commit -m "feat(brain): dynamic tool injection in agent loop (BAK-41)"
```

---

## Task 4: Backup CronJob container & manifests (BAK-42)

**Files:**
- Create: `k8s/backup/cronjob.yaml`
- Create: `k8s/backup/rbac.yaml`
- Create: `scripts/backup.sh`
- Modify: `tools/installer/release-manifest.json` (add BACKUP_PATH optional config)

**Context:** Brain state lives on two PVCs: `brain-data` (SQLite at `/data/bakerst.db`) and `qdrant-data` (vector storage at `/qdrant/storage/`). We need a nightly CronJob that copies SQLite + creates Qdrant snapshot, writes both to a host path, and rotates old backups. The brain uses `journal_mode = DELETE` (safe to copy while running).

**Step 1: Create the backup shell script**

```bash
#!/bin/sh
# scripts/backup.sh — Baker Street nightly backup
# Runs inside a minimal alpine container with curl and sqlite3
set -e

BACKUP_ROOT="${BACKUP_PATH:-/backups}"
BRAIN_DATA="${BRAIN_DATA_PATH:-/brain-data}"
QDRANT_HOST="${QDRANT_HOST:-http://qdrant:6333}"
COLLECTION="${QDRANT_COLLECTION:-bakerst_memories}"
RETENTION=${BACKUP_RETENTION:-7}

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

echo "[backup] Starting backup to ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# 1. SQLite backup (safe hot copy via .backup command)
echo "[backup] Backing up SQLite database..."
if [ -f "${BRAIN_DATA}/bakerst.db" ]; then
  sqlite3 "${BRAIN_DATA}/bakerst.db" ".backup '${BACKUP_DIR}/bakerst.db'"
  echo "[backup] SQLite backup complete ($(du -h "${BACKUP_DIR}/bakerst.db" | cut -f1))"
else
  echo "[backup] WARNING: No database found at ${BRAIN_DATA}/bakerst.db"
fi

# 2. Qdrant snapshot
echo "[backup] Creating Qdrant snapshot..."
SNAP_RESPONSE=$(curl -sf -X POST "${QDRANT_HOST}/collections/${COLLECTION}/snapshots" 2>/dev/null || echo "")
if [ -n "${SNAP_RESPONSE}" ]; then
  SNAP_NAME=$(echo "${SNAP_RESPONSE}" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "${SNAP_NAME}" ]; then
    curl -sf "${QDRANT_HOST}/collections/${COLLECTION}/snapshots/${SNAP_NAME}" \
      -o "${BACKUP_DIR}/qdrant-${COLLECTION}.snapshot"
    echo "[backup] Qdrant snapshot saved ($(du -h "${BACKUP_DIR}/qdrant-${COLLECTION}.snapshot" | cut -f1))"
  else
    echo "[backup] WARNING: Could not parse snapshot name from Qdrant response"
  fi
else
  echo "[backup] WARNING: Qdrant snapshot failed (is Qdrant running?)"
fi

# 3. Metadata
cat > "${BACKUP_DIR}/manifest.json" << MANIFEST_EOF
{"timestamp":"${TIMESTAMP}","version":"$(date +%s)"}
MANIFEST_EOF

# 4. Rotate: keep last N backups
echo "[backup] Rotating backups (keeping last ${RETENTION})..."
ls -dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +$((RETENTION + 1)) | while read dir; do
  echo "[backup] Removing old backup: ${dir}"
  rm -rf "${dir}"
done

echo "[backup] Backup complete: ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}/"
```

**Step 2: Create K8s RBAC (ServiceAccount for PVC access)**

```yaml
# k8s/backup/rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backup-sa
  namespace: bakerst
```

**Step 3: Create the CronJob manifest**

```yaml
# k8s/backup/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: bakerst-backup
  namespace: bakerst
  labels:
    app: bakerst-backup
spec:
  schedule: "0 2 * * *"  # 2:00 AM daily
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 600  # 10 min max
      template:
        metadata:
          labels:
            app: bakerst-backup
        spec:
          serviceAccountName: backup-sa
          restartPolicy: OnFailure
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            fsGroup: 1000
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: backup
              image: alpine:3.19
              command: ["/bin/sh", "-c", "apk add --no-cache sqlite curl && /bin/sh /scripts/backup.sh"]
              env:
                - name: BACKUP_PATH
                  value: "/backups"
                - name: BRAIN_DATA_PATH
                  value: "/brain-data"
                - name: QDRANT_HOST
                  value: "http://qdrant:6333"
                - name: QDRANT_COLLECTION
                  value: "bakerst_memories"
                - name: BACKUP_RETENTION
                  value: "7"
              volumeMounts:
                - name: brain-data
                  mountPath: /brain-data
                  readOnly: true
                - name: backup-volume
                  mountPath: /backups
                - name: scripts
                  mountPath: /scripts
                  readOnly: true
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  cpu: 200m
                  memory: 256Mi
              securityContext:
                allowPrivilegeEscalation: false
                capabilities:
                  drop: ["ALL"]
          volumes:
            - name: brain-data
              persistentVolumeClaim:
                claimName: brain-data
            - name: backup-volume
              hostPath:
                path: /backups/bakerst
                type: DirectoryOrCreate
            - name: scripts
              configMap:
                name: bakerst-backup-scripts
                defaultMode: 0755
```

**Step 4: Create NetworkPolicy for backup pod**

```yaml
# k8s/backup/network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-backup-egress
  namespace: bakerst
spec:
  podSelector:
    matchLabels:
      app: bakerst-backup
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: qdrant
      ports:
        - protocol: TCP
          port: 6333
    - to: []  # DNS
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

**Step 5: Create ConfigMap for backup script**

The CronJob mounts `bakerst-backup-scripts` ConfigMap. Create the manifest:

```yaml
# k8s/backup/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: bakerst-backup-scripts
  namespace: bakerst
data:
  backup.sh: |
    # (contents of scripts/backup.sh — or use `kubectl create configmap` during deploy)
```

Alternatively, add to `scripts/deploy.sh`:
```bash
# Deploy backup (if configured)
kubectl -n bakerst create configmap bakerst-backup-scripts --from-file=scripts/backup.sh --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/backup/
```

**Step 6: Add BACKUP_PATH to installer manifest**

In `tools/installer/release-manifest.json`, add to `requiredSecrets`:

```json
{
  "key": "BACKUP_PATH",
  "description": "Host path for nightly backups (e.g. /backups/bakerst)",
  "required": false,
  "inputType": "text",
  "targetSecrets": []
}
```

**Step 5: Commit**

Also update `scripts/deploy.sh` to apply backup manifests (gated behind a backup path check).

```bash
git add k8s/backup/ scripts/backup.sh scripts/deploy.sh tools/installer/release-manifest.json
git commit -m "feat: add nightly backup CronJob for brain state and Qdrant (BAK-42)"
```

---

## Task 5: Restore script (BAK-42)

**Files:**
- Create: `scripts/restore.sh`

**Context:** Takes a backup directory (from Task 4) and restores SQLite to the brain PVC + Qdrant snapshot via upload API. Requires the brain pod to be stopped during SQLite restore to avoid corruption.

**Step 1: Create the restore script**

```bash
#!/usr/bin/env bash
# scripts/restore.sh — Restore Baker Street from a backup directory
set -euo pipefail

BACKUP_DIR="${1:?Usage: restore.sh <backup-directory>}"
NAMESPACE="${NAMESPACE:-bakerst}"

if [ ! -d "${BACKUP_DIR}" ]; then
  echo "Error: backup directory not found: ${BACKUP_DIR}"
  exit 1
fi

echo "=== Baker Street Restore ==="
echo "Source: ${BACKUP_DIR}"
echo "Namespace: ${NAMESPACE}"
echo ""

# Verify backup contents
if [ ! -f "${BACKUP_DIR}/bakerst.db" ] && [ ! -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ]; then
  echo "Error: no backup files found in ${BACKUP_DIR}"
  echo "Expected: bakerst.db and/or qdrant-bakerst_memories.snapshot"
  exit 1
fi

echo "Found:"
[ -f "${BACKUP_DIR}/bakerst.db" ] && echo "  - bakerst.db ($(du -h "${BACKUP_DIR}/bakerst.db" | cut -f1))"
[ -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ] && echo "  - qdrant snapshot ($(du -h "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" | cut -f1))"
echo ""

read -p "This will overwrite current state. Continue? [y/N] " confirm
if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

# 1. Scale down brain to avoid SQLite corruption
echo "[restore] Scaling down brain..."
kubectl -n "${NAMESPACE}" scale deployment brain-blue --replicas=0 2>/dev/null || true
kubectl -n "${NAMESPACE}" scale deployment brain-green --replicas=0 2>/dev/null || true
kubectl -n "${NAMESPACE}" rollout status deployment/brain-blue --timeout=30s 2>/dev/null || true

# 2. Restore SQLite via a temporary pod
if [ -f "${BACKUP_DIR}/bakerst.db" ]; then
  echo "[restore] Restoring SQLite database..."

  # Create a temporary pod that mounts brain-data PVC
  kubectl -n "${NAMESPACE}" run restore-tmp --image=alpine:3.19 \
    --restart=Never \
    --overrides='{
      "spec": {
        "securityContext": {
          "runAsNonRoot": true,
          "runAsUser": 1000,
          "fsGroup": 1000,
          "seccompProfile": {"type": "RuntimeDefault"}
        },
        "containers": [{
          "name": "restore-tmp",
          "image": "alpine:3.19",
          "command": ["sleep", "300"],
          "volumeMounts": [{"name": "brain-data", "mountPath": "/data"}],
          "securityContext": {
            "allowPrivilegeEscalation": false,
            "capabilities": {"drop": ["ALL"]}
          }
        }],
        "volumes": [{"name": "brain-data", "persistentVolumeClaim": {"claimName": "brain-data"}}]
      }
    }' 2>/dev/null || true

  kubectl -n "${NAMESPACE}" wait --for=condition=Ready pod/restore-tmp --timeout=30s
  kubectl -n "${NAMESPACE}" cp "${BACKUP_DIR}/bakerst.db" restore-tmp:/data/bakerst.db
  kubectl -n "${NAMESPACE}" delete pod restore-tmp --grace-period=0

  echo "[restore] SQLite restored."
fi

# 3. Restore Qdrant snapshot
if [ -f "${BACKUP_DIR}/qdrant-bakerst_memories.snapshot" ]; then
  echo "[restore] Restoring Qdrant snapshot..."

  # Port-forward to Qdrant
  kubectl -n "${NAMESPACE}" port-forward svc/qdrant 6333:6333 &
  PF_PID=$!
  sleep 2

  # Upload snapshot
  curl -sf -X POST "http://localhost:6333/collections/bakerst_memories/snapshots/upload" \
    -H "Content-Type: multipart/form-data" \
    -F "snapshot=@${BACKUP_DIR}/qdrant-bakerst_memories.snapshot"

  kill "${PF_PID}" 2>/dev/null || true
  echo "[restore] Qdrant restored."
fi

# 4. Scale brain back up
echo "[restore] Scaling brain back up..."
kubectl -n "${NAMESPACE}" scale deployment brain-blue --replicas=1
kubectl -n "${NAMESPACE}" rollout status deployment/brain-blue --timeout=120s

# 5. Health check
echo "[restore] Verifying health..."
sleep 5
kubectl -n "${NAMESPACE}" get pods -l app=brain

echo ""
echo "=== Restore complete ==="
```

**Step 2: Make executable and commit**

```bash
chmod +x scripts/restore.sh
git add scripts/restore.sh
git commit -m "feat: add restore script for backup recovery (BAK-42)"
```

---

## Task 6: K8s context detection & picker (BAK-44)

**Files:**
- Modify: `tools/installer/src/cmd_install.rs:89-177` (preflight checks)
- Modify: `tools/installer/src/app.rs` (add K8sContext type, selected_context field)
- Modify: `tools/installer/src/tui.rs` (add context picker rendering)

**Context:** The installer currently checks if a K8s cluster is reachable via `k8s::check_cluster()`. We need to detect all available contexts, let the user pick one (or auto-select if only one), and handle the case where no K8s is found with actionable guidance. Also check `BAKERST_KUBECONTEXT` env var for pre-selection.

**Step 1: Add K8sContext type to app.rs**

```rust
// In app.rs, add:
#[derive(Clone, Debug)]
pub struct K8sContext {
    pub name: String,
    pub cluster: String,
    pub is_current: bool,
    pub cluster_type: ClusterType,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClusterType {
    DockerDesktop,
    Minikube,
    K3s,
    Kind,
    RancherDesktop,
    Cloud,   // EKS, GKE, AKS
    Unknown,
}

impl ClusterType {
    pub fn from_context_name(name: &str, cluster: &str) -> Self {
        let n = name.to_lowercase();
        let c = cluster.to_lowercase();
        if n.contains("docker-desktop") || c.contains("docker-desktop") {
            ClusterType::DockerDesktop
        } else if n.contains("minikube") || c.contains("minikube") {
            ClusterType::Minikube
        } else if n.contains("k3s") || (n == "default" && c.contains("k3s")) {
            ClusterType::K3s
        } else if n.starts_with("kind-") || c.starts_with("kind-") {
            ClusterType::Kind
        } else if n.contains("rancher") || c.contains("rancher") {
            ClusterType::RancherDesktop
        } else if c.contains("eks") || c.contains("gke") || c.contains("aks")
            || c.contains("amazonaws") || c.contains("azmk8s") {
            ClusterType::Cloud
        } else {
            ClusterType::Unknown
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            ClusterType::DockerDesktop => "Docker Desktop",
            ClusterType::Minikube => "Minikube",
            ClusterType::K3s => "k3s",
            ClusterType::Kind => "kind",
            ClusterType::RancherDesktop => "Rancher Desktop",
            ClusterType::Cloud => "Cloud (not recommended)",
            ClusterType::Unknown => "Unknown",
        }
    }
}

// Add to App struct (and initialize in App::new() / Default impl):
pub available_contexts: Vec<K8sContext>,   // Default: Vec::new()
pub selected_context_idx: usize,          // Default: 0
pub context_picker_active: bool,          // Default: false
```

**Step 2: Replace preflight K8s check with context detection**

In `cmd_install.rs:112-130`, replace the single cluster check:

```rust
// Check 2: Kubernetes contexts
app.preflight_checks
    .push(("Kubernetes cluster".into(), ItemStatus::InProgress));

// Check for BAKERST_KUBECONTEXT env var
let env_context = std::env::var("BAKERST_KUBECONTEXT").ok();

// Detect all available contexts
match detect_k8s_contexts().await {
    Ok(contexts) if contexts.is_empty() => {
        app.cluster_name = "no cluster".into();
        app.preflight_checks[1] = (
            "Kubernetes cluster".into(),
            ItemStatus::Failed(
                "No Kubernetes cluster found.\n\
                 Install Docker Desktop and enable Kubernetes,\n\
                 or install k3s: curl -sfL https://get.k3s.io | sh -".into()
            ),
        );
    }
    Ok(contexts) => {
        app.available_contexts = contexts.clone();

        // Auto-select logic
        let selected = if let Some(ref env_ctx) = env_context {
            // BAKERST_KUBECONTEXT set — find it
            contexts.iter().position(|c| c.name == *env_ctx)
        } else if contexts.len() == 1 {
            Some(0)
        } else {
            // Multiple contexts — find current
            contexts.iter().position(|c| c.is_current)
        };

        if let Some(idx) = selected {
            let ctx = &contexts[idx];
            app.selected_context_idx = idx;
            app.cluster_name = format!("{} ({})", ctx.name, ctx.cluster_type.display_name());

            // Warn about cloud clusters
            if ctx.cluster_type == ClusterType::Cloud {
                app.preflight_checks[1] = (
                    format!("Kubernetes: {} - cloud cluster", ctx.name),
                    ItemStatus::Done,
                );
            } else {
                app.preflight_checks[1] = (
                    format!("Kubernetes: {} ({})", ctx.name, ctx.cluster_type.display_name()),
                    ItemStatus::Done,
                );
            }

            // Switch to selected context
            let _ = switch_k8s_context(&ctx.name).await;
        } else if contexts.len() > 1 {
            // Multiple contexts, none pre-selected — need picker
            app.context_picker_active = true;
            app.preflight_checks[1] = (
                format!("Kubernetes: {} contexts found - select one", contexts.len()),
                ItemStatus::InProgress,
            );
        }
    }
    Err(e) => {
        app.cluster_name = "error".into();
        app.preflight_checks[1] = (
            "Kubernetes cluster".into(),
            ItemStatus::Failed(format!("kubectl error: {}", e)),
        );
    }
}
```

**Step 3: Add helper functions**

```rust
async fn detect_k8s_contexts() -> Result<Vec<K8sContext>, String> {
    let output = tokio::process::Command::new("kubectl")
        .args(["config", "get-contexts", "--no-headers"])
        .output()
        .await
        .map_err(|e| format!("kubectl not found: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut contexts = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 { continue; }

        let (is_current, name, cluster) = if parts[0] == "*" {
            (true, parts[1].to_string(), parts[2].to_string())
        } else {
            (false, parts[0].to_string(), parts[1].to_string())
        };

        let cluster_type = ClusterType::from_context_name(&name, &cluster);
        contexts.push(K8sContext { name, cluster, is_current, cluster_type });
    }

    Ok(contexts)
}

async fn switch_k8s_context(name: &str) -> Result<(), String> {
    let output = tokio::process::Command::new("kubectl")
        .args(["config", "use-context", name])
        .output()
        .await
        .map_err(|e| format!("{}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}
```

**Step 4: Add BAKERST_KUBECONTEXT to env var detection**

In `cmd_install.rs:180-185`, add to `known_keys`:

```rust
let known_keys = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_ENDPOINTS",
    "VOYAGE_API_KEY", "TELEGRAM_BOT_TOKEN",
    "GITHUB_TOKEN", "OBSIDIAN_VAULT_PATH",
    "STT_API_KEY", "TTS_API_KEY", "PICOVOICE_ACCESS_KEY",
    "BAKERST_KUBECONTEXT", "BACKUP_PATH",
];
```

**Step 5: Add context picker TUI rendering**

In `tui.rs`, add rendering for the context picker when `app.context_picker_active` is true during the Preflight phase. Use the same Up/Down/Enter pattern as the provider picker. Show context name, cluster type, and a warning for cloud clusters.

**Step 6: Build and test**

Run: `cd tools/installer && cargo build`
Expected: Compiles without errors

**Step 7: Commit**

```bash
git add tools/installer/src/cmd_install.rs tools/installer/src/app.rs tools/installer/src/tui.rs
git commit -m "feat(installer): detect K8s contexts with multi-cluster picker (BAK-44)"
```

---

## Task 7: Standing Orders — delivery modes & self-healing (BAK-12)

**Files:**
- Modify: `services/brain/src/db.ts:200-214` (add columns to schedules table)
- Modify: `services/brain/src/schedule-manager.ts` (delivery routing, failure tracking)
- Modify: `services/brain/src/schedule-tools.ts` (update tool definitions for new fields)
- Test: `services/brain/src/schedule-manager.test.ts`

**Context:** The existing schedule system (`ScheduleManager`) already handles cron scheduling, CRUD, and execution via the dispatcher. The base "CRON as brain skill" is done. BAK-12's remaining scope is the enhancements from the ticket description: (1) delivery modes (announce to channel, webhook/pigeon, or file/log-only), (2) case file concept (sitting-room vs private execution), and (3) self-healing (auto-disable after N consecutive failures). The existing `schedules` table has: id, name, schedule, type, config, enabled, last_run_at, last_status, last_output.

**Step 1: Write failing tests**

```typescript
// services/brain/src/schedule-manager.test.ts
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { getDb } from './db.js';

// Initialize DB for tests
beforeAll(() => { getDb(); });

describe('Schedule self-healing columns', () => {
  it('schedules table has consecutive_failures column', () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[];
    const names = info.map(c => c.name);
    expect(names).toContain('consecutive_failures');
    expect(names).toContain('max_consecutive_failures');
    expect(names).toContain('case_file');
  });
});

describe('Schedule delivery config', () => {
  it('stores delivery config in schedule config JSON', () => {
    const db = getDb();
    const id = 'test-delivery-' + Date.now();
    const config = JSON.stringify({
      job: 'check news',
      delivery: { mode: 'announce', channel: 'telegram' },
    });
    db.prepare(
      "INSERT INTO schedules (id, name, schedule, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))"
    ).run(id, 'Test', '0 * * * *', 'agent', config);

    const row = db.prepare("SELECT config FROM schedules WHERE id = ?").get(id) as { config: string };
    const parsed = JSON.parse(row.config);
    expect(parsed.delivery.mode).toBe('announce');
    expect(parsed.delivery.channel).toBe('telegram');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd services/brain && npx vitest run src/schedule-manager.test.ts`
Expected: FAIL — consecutive_failures column not found

**Step 3: Add new columns to schedules table**

In `db.ts`, add migrations after the schedules table creation (after line 214):

```typescript
// Migration: add self-healing columns to schedules
try {
  db.exec('ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
} catch { /* Column already exists */ }

try {
  db.exec('ALTER TABLE schedules ADD COLUMN max_consecutive_failures INTEGER NOT NULL DEFAULT 5');
} catch { /* Column already exists */ }

try {
  db.exec("ALTER TABLE schedules ADD COLUMN case_file TEXT NOT NULL DEFAULT 'sitting-room'");
} catch { /* Column already exists */ }
```

Update the `ScheduleRow` type (in db.ts exports) to include the new fields:

```typescript
// Add to ScheduleRow interface:
consecutive_failures: number;
max_consecutive_failures: number;
case_file: string;
```

**Step 4: Update ScheduleManager with self-healing**

In `schedule-manager.ts`, update the execution handler to track failures.

**IMPORTANT:** Keep the existing `Promise<string>` return type (returns jobId) — `trigger()` depends on this. Also update ALL existing callers of `updateScheduleRunStatus` to use the new object signature.

```typescript
// In the existing executeSchedule method, wrap the dispatch call:
// Return type MUST remain Promise<string> — trigger() returns this jobId
private async executeSchedule(row: ScheduleRow): Promise<string> {
  try {
    const config = JSON.parse(row.config) as ScheduleConfig;
    const result = await this.dispatcher.dispatch({
      type: row.type,
      ...config,
      source: 'schedule',
    });

    const output = typeof result === 'string' ? result.slice(0, 1024) : JSON.stringify(result).slice(0, 1024);

    // Success: reset failure counter
    updateScheduleRunStatus(row.id, {
      last_run_at: new Date().toISOString(),
      last_status: 'success',
      last_output: output,
      consecutive_failures: 0,
    });

    return result; // jobId — returned to trigger()
  } catch (err) {
    const failures = (row.consecutive_failures ?? 0) + 1;
    const maxFailures = row.max_consecutive_failures ?? 5;
    const autoDisable = failures >= maxFailures;

    updateScheduleRunStatus(row.id, {
      last_run_at: new Date().toISOString(),
      last_status: 'error',
      last_output: err instanceof Error ? err.message.slice(0, 1024) : String(err).slice(0, 1024),
      consecutive_failures: failures,
    });

    if (autoDisable) {
      this.update(row.id, { enabled: false });
      log.warn(
        { id: row.id, name: row.name, failures },
        'standing order auto-disabled after consecutive failures',
      );
    }

    throw err; // re-throw so trigger() can report the error
  }
}
```

**Also update existing callers** of `updateScheduleRunStatus` (currently at lines 259, 263 in schedule-manager.ts) to use the new object signature.
```

Update `updateScheduleRunStatus` in `db.ts` to accept `consecutive_failures`:

```typescript
export function updateScheduleRunStatus(
  id: string,
  updates: {
    last_run_at: string;
    last_status: string;
    last_output: string;
    consecutive_failures?: number;
  },
): void {
  const db = getDb();
  if (updates.consecutive_failures !== undefined) {
    db.prepare(
      'UPDATE schedules SET last_run_at = ?, last_status = ?, last_output = ?, consecutive_failures = ?, updated_at = ? WHERE id = ?',
    ).run(updates.last_run_at, updates.last_status, updates.last_output, updates.consecutive_failures, new Date().toISOString(), id);
  } else {
    db.prepare(
      'UPDATE schedules SET last_run_at = ?, last_status = ?, last_output = ?, updated_at = ? WHERE id = ?',
    ).run(updates.last_run_at, updates.last_status, updates.last_output, new Date().toISOString(), id);
  }
}
```

**Step 5: Update tool definitions for delivery and case_file**

In `schedule-tools.ts`, update `handleManageStandingOrder` to accept and store `case_file`, `delivery`, and `max_consecutive_failures` in the create/update actions. These go into the `config` JSON and direct DB columns respectively.

**SSRF protection for pigeon (webhook) delivery:** When a standing order uses `delivery.mode: 'pigeon'`, validate the `webhookUrl` before storing:
- Must be HTTPS
- Must not resolve to private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, link-local 169.254.x)
- Must not target internal K8s service DNS (*.svc.cluster.local, *.bakerst.svc)
- Reject if validation fails with a clear error message

In `agent.ts`, update the `manage_standing_order` tool definition to document the new fields:

```typescript
{
  name: 'manage_standing_order',
  description: 'Create, update, enable, disable, or delete a standing order (scheduled task). ' +
    'Supports cron expressions. Set case_file to "private" for isolated execution (does not appear in main chat). ' +
    'Delivery modes: announce (send to chat channel), pigeon (POST to webhook), file (log only). ' +
    'Auto-disables after max_consecutive_failures (default 5) consecutive errors.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'enable', 'disable', 'delete'] },
      id: { type: 'string', description: 'Required for update/enable/disable/delete' },
      name: { type: 'string', description: 'Human-readable name' },
      schedule: { type: 'string', description: 'Cron expression (e.g. "0 9 * * 1-5")' },
      type: { type: 'string', description: 'Execution type: agent, command, or http' },
      config: { type: 'object', description: 'Execution config (job, command, url, delivery, etc.)' },
      case_file: { type: 'string', enum: ['sitting-room', 'private'], description: 'Where results appear (default: sitting-room)' },
      max_consecutive_failures: { type: 'number', description: 'Auto-disable threshold (default 5)' },
    },
    required: ['action'],
  },
}
```

**Step 6: Run tests**

Run: `cd services/brain && npx vitest run src/schedule-manager.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add services/brain/src/db.ts services/brain/src/schedule-manager.ts services/brain/src/schedule-tools.ts services/brain/src/agent.ts services/brain/src/schedule-manager.test.ts
git commit -m "feat(brain): standing orders with delivery modes and self-healing (BAK-12)"
```

---

## Task 8: Saved Prompts — DB table + brain tools (BAK-24)

**Files:**
- Modify: `services/brain/src/db.ts` (add saved_prompts table)
- Create: `services/brain/src/saved-prompts.ts` (CRUD functions)
- Modify: `services/brain/src/agent.ts` (register tools)
- Test: `services/brain/src/saved-prompts.test.ts`

**Context:** Users want to save and recall prompts. The brain needs a `saved_prompts` table and tools: `save_prompt`, `list_saved_prompts`, `delete_saved_prompt`. The model handles natural language — user says "save that" and Claude calls `save_prompt` with the previous message. No slash command parsing needed on the brain side; that's UI-only (Task 9).

**Step 1: Write failing tests**

```typescript
// services/brain/src/saved-prompts.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from './db.js';

// Initialize DB for tests
beforeAll(() => { getDb(); });

import {
  savePrompt,
  listSavedPrompts,
  getSavedPrompt,
  deleteSavedPrompt,
} from './saved-prompts.js';

describe('saved-prompts', () => {
  it('saves a prompt and returns it with an id', () => {
    const result = savePrompt('Write a haiku about testing');
    expect(result.id).toBeDefined();
    expect(result.text).toBe('Write a haiku about testing');
    expect(result.created_at).toBeDefined();
  });

  it('lists saved prompts in reverse chronological order', () => {
    savePrompt('First prompt');
    savePrompt('Second prompt');
    const list = listSavedPrompts();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    const idx1 = list.findIndex(p => p.text === 'First prompt');
    const idx2 = list.findIndex(p => p.text === 'Second prompt');
    expect(idx2).toBeLessThan(idx1);
  });

  it('gets a prompt by id', () => {
    const saved = savePrompt('Specific prompt');
    const fetched = getSavedPrompt(saved.id);
    expect(fetched).toBeDefined();
    expect(fetched!.text).toBe('Specific prompt');
  });

  it('deletes a prompt', () => {
    const saved = savePrompt('To be deleted');
    const deleted = deleteSavedPrompt(saved.id);
    expect(deleted).toBe(true);
    expect(getSavedPrompt(saved.id)).toBeUndefined();
  });

  it('returns undefined for non-existent id', () => {
    expect(getSavedPrompt('nonexistent')).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd services/brain && npx vitest run src/saved-prompts.test.ts`
Expected: FAIL — module not found

**Step 3: Add saved_prompts table to db.ts**

In `db.ts`, after the `companion_tasks` table (around line 286):

```typescript
// --- Saved prompts ---

db.exec(`
  CREATE TABLE IF NOT EXISTS saved_prompts (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL
  )
`);
```

**Step 4: Implement saved-prompts.ts**

```typescript
// services/brain/src/saved-prompts.ts
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export interface SavedPrompt {
  id: string;
  text: string;
  label: string | null;
  created_at: string;
}

const MAX_PROMPT_LENGTH = 10_000;
const MAX_LABEL_LENGTH = 200;

export function savePrompt(text: string, label?: string): SavedPrompt {
  if (text.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt text exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }
  if (label && label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Label exceeds maximum length of ${MAX_LABEL_LENGTH} characters`);
  }

  const db = getDb();
  const id = randomUUID();
  const created_at = new Date().toISOString();

  db.prepare(
    'INSERT INTO saved_prompts (id, text, label, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, text, label ?? null, created_at);

  return { id, text, label: label ?? null, created_at };
}

export function listSavedPrompts(limit = 50): SavedPrompt[] {
  const db = getDb();
  return db
    .prepare('SELECT id, text, label, created_at FROM saved_prompts ORDER BY created_at DESC LIMIT ?')
    .all(limit) as SavedPrompt[];
}

export function getSavedPrompt(id: string): SavedPrompt | undefined {
  const db = getDb();
  return db
    .prepare('SELECT id, text, label, created_at FROM saved_prompts WHERE id = ?')
    .get(id) as SavedPrompt | undefined;
}

export function deleteSavedPrompt(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(id);
  return result.changes > 0;
}
```

**Step 5: Register brain tools in agent.ts**

Add three tool definitions to the `tools` array in `agent.ts` (around line 134, after existing built-in tools):

```typescript
{
  name: 'save_prompt',
  description: 'Save a prompt for later recall. Use when the user says "save this", "remember this prompt", or similar.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The prompt text to save' },
      label: { type: 'string', description: 'Optional short label for the prompt' },
    },
    required: ['text'],
  },
},
{
  name: 'list_saved_prompts',
  description: 'List all saved prompts. Use when the user says "show saved prompts", "my saved prompts", or "/saved-prompts".',
  input_schema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max prompts to return (default 20)' },
    },
  },
},
{
  name: 'delete_saved_prompt',
  description: 'Delete a saved prompt by ID.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The prompt ID to delete' },
    },
    required: ['id'],
  },
},
```

Add to `executeTool()` inside the `switch (toolName)` block (around line 477, before the `default` case). The saved prompt tool names must also be added to a dispatch set (e.g. add a `SAVED_PROMPT_TOOLS` set check before the switch, similar to `SELF_MGMT_TOOLS` and `SCHEDULE_TOOLS`):

```typescript
case 'save_prompt': {
  const { text, label } = toolInput as { text: string; label?: string };
  const saved = savePrompt(text, label);
  return {
    result: `Prompt saved (${saved.id}). Label: ${saved.label ?? 'none'}. Preview: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
  };
}

case 'list_saved_prompts': {
  const { limit } = toolInput as { limit?: number };
  const prompts = listSavedPrompts(limit ?? 20);
  if (prompts.length === 0) {
    return { result: 'No saved prompts found.' };
  }
  const lines = prompts.map((p) => {
    const preview = p.text.length > 60 ? p.text.slice(0, 60) + '...' : p.text;
    const label = p.label ? ` [${p.label}]` : '';
    return `- ${p.id}${label} (${p.created_at.split('T')[0]}): "${preview}"`;
  });
  return { result: `${prompts.length} saved prompt(s):\n\n${lines.join('\n')}` };
}

case 'delete_saved_prompt': {
  const { id } = toolInput as { id: string };
  const deleted = deleteSavedPrompt(id);
  return { result: deleted ? `Prompt ${id} deleted.` : `Prompt ${id} not found.` };
}
```

**Step 6: Run tests**

Run: `cd services/brain && npx vitest run src/saved-prompts.test.ts`
Expected: All 5 tests PASS

**Step 7: Commit**

```bash
git add services/brain/src/db.ts services/brain/src/saved-prompts.ts services/brain/src/saved-prompts.test.ts services/brain/src/agent.ts
git commit -m "feat(brain): saved prompts with save/list/delete tools (BAK-24)"
```

---

## Task 9: Saved Prompts — UI slash command handling (BAK-24)

**Files:**
- Create: `services/ui/src/hooks/useSlashCommands.ts`
- Modify: `services/ui/src/components/chat/ChatInput.tsx` (slash command detection + autocomplete)
- Modify: `services/ui/src/hooks/useChat.ts` (intercept slash commands before sending)
- Modify: `services/brain/src/api.ts` (add GET /saved-prompts endpoint)

**Context:** No slash command system exists in the UI. We add intentionally minimal slash command infrastructure (just `/save-this` and `/saved-prompts` for now — future commands can be added to the `SLASH_COMMANDS` array without structural changes). We need minimal slash command detection: when user types `/save-this`, the UI intercepts it and sends "Save the previous prompt: <last user message>" to the brain's chat endpoint. For `/saved-prompts`, the UI calls a dedicated API endpoint and shows a picker. The brain already has the tools (Task 8) — the UI just needs to translate slash commands into natural language or API calls.

**Step 1: Add API endpoint for saved prompts**

In `services/brain/src/api.ts`, add a new route (after existing conversation routes):

```typescript
import { listSavedPrompts } from './saved-prompts.js';

// GET /saved-prompts — list saved prompts (for UI slash command)
app.get('/saved-prompts', (_req, res) => {
  const prompts = listSavedPrompts(50);
  res.json({ prompts });
});
```

**Step 2: Create useSlashCommands hook**

```typescript
// services/ui/src/hooks/useSlashCommands.ts

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/save-this', description: 'Save the previous prompt' },
  { name: '/saved-prompts', description: 'Show saved prompts' },
];

/** Check if text is a slash command. Returns the command name or null. */
export function matchSlashCommand(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  const cmd = SLASH_COMMANDS.find((c) => trimmed === c.name || trimmed.startsWith(c.name + ' '));
  return cmd ? cmd.name : null;
}

/** Get autocomplete suggestions for partial slash command input */
export function getSlashSuggestions(text: string): SlashCommand[] {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(trimmed));
}
```

**Step 3: Modify ChatInput for slash command autocomplete**

In `ChatInput.tsx`, add state for suggestions:

```typescript
const [suggestions, setSuggestions] = useState<SlashCommand[]>([]);

// In the onChange handler, after updating value:
const newSuggestions = getSlashSuggestions(value);
setSuggestions(newSuggestions);

// Render suggestions dropdown above the input when suggestions.length > 0:
{suggestions.length > 0 && (
  <div className="absolute bottom-full left-0 w-full bg-gray-800 border border-gray-600 rounded-t-md">
    {suggestions.map((cmd) => (
      <button
        key={cmd.name}
        className="w-full text-left px-3 py-2 hover:bg-gray-700 text-sm"
        onClick={() => {
          setValue(cmd.name);
          setSuggestions([]);
        }}
      >
        <span className="text-blue-400">{cmd.name}</span>
        <span className="text-gray-400 ml-2">{cmd.description}</span>
      </button>
    ))}
  </div>
)}
```

**Step 4: Modify useChat to intercept slash commands**

In `useChat.ts`, modify `sendMessage()`:

```typescript
import { matchSlashCommand } from './useSlashCommands.js';

async function sendMessage(text: string) {
  const cmd = matchSlashCommand(text);

  if (cmd === '/save-this') {
    // Find the last user message in the current messages
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) {
      // Add a system-like message: "No previous message to save"
      return;
    }
    // Send as a natural language request to the brain
    const saveText = `Please save this prompt for later: "${typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''}"`;
    return sendToApi(saveText);
  }

  if (cmd === '/saved-prompts') {
    // Send as natural language request — brain's list_saved_prompts tool handles it
    return sendToApi('Show me my saved prompts');
  }

  // Normal message
  return sendToApi(text);
}
```

**Step 5: Build and verify**

Run: `pnpm -r build`
Expected: Clean build

**Step 6: Commit**

```bash
git add services/ui/src/hooks/useSlashCommands.ts services/ui/src/components/chat/ChatInput.tsx services/ui/src/hooks/useChat.ts services/brain/src/api.ts
git commit -m "feat(ui): slash command support for saved prompts (BAK-24)"
```

---

## Acceptance Criteria

| Ticket | Criteria |
|--------|----------|
| BAK-41 | Anthropic models use `defer_loading` on extension tools. Ollama/OpenAI models get `search_tools` only + dynamic injection. Brain test suite passes. |
| BAK-42 | `kubectl get cronjob -n bakerst` shows `bakerst-backup`. Backup creates SQLite copy + Qdrant snapshot. `scripts/restore.sh` restores from backup. |
| BAK-44 | Installer detects multiple K8s contexts and shows picker. `BAKERST_KUBECONTEXT` env var pre-selects. No K8s shows actionable error message. |
| BAK-12 | Standing orders support `case_file`, `delivery` config, and `max_consecutive_failures`. Auto-disable after threshold. |
| BAK-24 | `/save-this` saves previous prompt. `/saved-prompts` shows list. Prompts persist in SQLite across conversations. |
