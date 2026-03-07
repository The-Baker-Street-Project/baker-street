# Implement Plan Job Type for Baker Street Workers

## Context

Baker Street uses a Brain (orchestrator) → NATS JetStream → Worker architecture. The Brain dispatches jobs to stateful workers via JetStream. Workers currently support three job types: `agent`, `command`, and `http`.

The problem: when the Brain dispatches an `agent` job for a complex, multi-step task (e.g., "clean up 300k promotional emails"), the worker's LLM takes naive, sequential approaches instead of reasoning about efficient strategies. The worker model is intentionally small/cheap and lacks strategic planning capability.

The solution: add a `plan` job type where the Brain uses a larger, more capable model to decompose complex tasks into concrete, explicit execution steps **before dispatch**. The worker then executes the plan step-by-step without needing to reason about strategy — it just follows instructions. This keeps worker costs low while dramatically improving execution quality.

## Architecture Reference

Read these files before making any changes to understand the existing patterns:

- `services/brain/src/agent.ts` — Core reasoning loop, how the Brain decides to dispatch
- `services/brain/src/dispatcher.ts` — How `JobDispatch` messages are published to JetStream
- `services/brain/src/status-tracker.ts` — How the Brain receives worker status updates
- `services/worker/src/index.ts` — Worker bootstrap and job consumption loop
- `services/worker/src/handlers/` — Existing job type handlers (agent, command, http)
- `services/shared/types.ts` or wherever `JobDispatch` and job status types are defined
- `services/brain/src/model-router.ts` — Multi-model routing with role-based selection

Understand the existing `JobDispatch` shape, status update subjects, and how `executeAgent()`, `executeCommand()`, and `executeHttp()` work before writing any new code.

## Requirements

### 1. Shared Types

Add the following types alongside the existing `JobDispatch` type definition. Do not break existing types — extend them.

```typescript
interface PlanStep {
  id: string;                          // Unique step ID, e.g., "step-1", "step-2"
  instruction: string;                 // Concrete, unambiguous instruction for the worker LLM
  type: 'llm' | 'command' | 'http';   // What kind of execution this step requires
  params: Record<string, any>;         // Step-specific parameters (batch size, query, URL, etc.)
  exitCondition?: string;              // Natural language condition to stop iteration, e.g., "stop when fewer than 10 results returned"
  maxIterations?: number;              // Hard cap on iterations for this step (guardrail)
  dependsOn?: string[];                // Step IDs that must complete before this one runs
  onFailure: 'skip' | 'abort' | 'escalate';  // What to do if this step fails
}

interface PlanJobDispatch extends JobDispatch {
  type: 'plan';
  plan: {
    goal: string;                      // Original user goal (for context in escalation)
    steps: PlanStep[];                 // Ordered execution steps
    escalationPolicy: 'pause' | 'replan';  // What the Brain does on escalation
    targetModel?: string;              // Optional: override worker model for this plan
  };
}
```

Add a step-level status type for granular progress reporting:

```typescript
interface PlanStepStatus {
  jobId: string;
  stepId: string;
  stepIndex: number;
  totalSteps: number;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'escalated';
  result?: string;
  error?: string;
  iterationCount?: number;
}
```

### 2. Worker: `executePlan()` Handler

Create a new handler at `services/worker/src/handlers/plan.ts` (or wherever the existing handlers live). Follow the exact patterns used by the existing handlers for status publishing and error handling.

**Behavior:**

1. Receive the `PlanJobDispatch` message.
2. Publish `received` status on `bakerst.jobs.status.<jobId>` (same as other handlers).
3. Iterate through `plan.steps` in order:
   a. Check `dependsOn` — skip if dependencies haven't completed (for now, steps are sequential, so this is a forward-looking extensibility hook).
   b. Publish a step-level status update: `{ status: 'running', stepId, stepIndex, totalSteps }`.
   c. Execute the step based on `step.type`:
      - `'llm'`: Call the LLM with `step.instruction` as the prompt. Use the plan's `targetModel` if set, otherwise fall back to the worker model role. This is a single-turn call, same pattern as `executeAgent()`. Pass `step.params` as additional context in the prompt.
      - `'command'`: Delegate to the existing `executeCommand()` logic. The step's `params` should contain `command` and `args`.
      - `'http'`: Delegate to the existing `executeHttp()` logic. The step's `params` should contain `url`, `method`, `headers`, `body`.
   d. If the step has `maxIterations` and/or `exitCondition`:
      - Wrap execution in a loop.
      - After each iteration, check if `exitCondition` is met. For LLM steps, include the exit condition in the prompt and ask the model to respond with a structured `{ done: boolean, result: string }` JSON.
      - Break if `maxIterations` reached.
   e. On step success: publish step status `completed` with result. Store result in a local `stepResults` map (keyed by step ID) so later steps can reference prior results.
   f. On step failure, check `step.onFailure`:
      - `'skip'`: Log, publish step status `skipped`, continue to next step.
      - `'abort'`: Publish step status `failed`, publish overall job status `failed`, return.
      - `'escalate'`: Publish step status `escalated` with error context, publish overall job status as a new status `escalated` (add to the status union type), return. The Brain handles what comes next.
4. After all steps complete: aggregate step results into a final summary. Publish overall job status `completed` with the aggregated result.
5. The aggregated result should be a structured object, not just concatenated text. Include each step's ID, status, and result so the Brain can reason about the outcome.

**Important implementation notes:**

- Include prior step results in LLM prompts for later steps. If step 3's instruction says "Based on the sender list from step 1, classify...", the worker should inject step 1's result into step 3's prompt context. Use the `stepResults` map for this — scan the instruction for `step-N` references or simply include all prior results as context.
- Respect the existing security constraints: command allowlisting, blocked env vars, read-only filesystem, etc.
- Publish step-level status on the same `bakerst.jobs.status.<jobId>` subject using the `PlanStepStatus` shape. The Brain's status tracker will differentiate by the presence of `stepId`.

### 3. Worker: Job Routing

In the worker's main job consumption loop (where it switches on `job.type`), add a case for `'plan'` that calls `executePlan()`. Follow the exact pattern used for the other job types.

### 4. Brain: Model Router — Add `planner` Role

In `model-router.ts`, add a `planner` role alongside the existing `agent`, `observer`, and `worker` roles. This role should:

- Default to a higher-capability model (e.g., Sonnet or Opus via API, or a local model via Ollama).
- Be configurable via the same mechanism as other roles (env vars, config, etc.).
- Fall back to the `agent` role's model if no planner model is explicitly configured.

### 5. Brain: Plan Generation

Add a `generatePlan()` function in the Brain (in `agent.ts` or a new `planner.ts` module, whichever fits the existing code organization better). This function:

1. Takes a complex goal string and available context (conversation history, user preferences, available tools).
2. Calls the LLM using the `planner` model role.
3. Uses a system prompt that instructs the model to:
   - Analyze the goal and determine the most efficient execution strategy.
   - Decompose the goal into concrete, sequential steps.
   - Output a valid JSON `PlanStep[]` array.
   - Each step instruction must be self-contained and unambiguous — assume the executor is a capable but literal-minded model that won't improvise.
   - Include appropriate batch sizes, exit conditions, and iteration limits.
   - Set `onFailure` appropriately per step (use `'escalate'` for steps where the executor might need human/planner judgment).
4. Parses the LLM response into a typed `PlanStep[]`. Validate the output — every step must have a valid `type`, `id`, `instruction`, and `onFailure`. Reject and retry (once) if parsing fails.
5. Returns the complete plan object ready for dispatch.

**System prompt for plan generation** — include something like:

```
You are a task planner for an AI agent system. Your job is to decompose a complex goal into
concrete, executable steps for a worker model.

The worker is capable but literal — it follows instructions precisely but does not improvise
or reason about strategy. Your plan IS the strategy.

Rules:
- Each step must have an explicit, unambiguous instruction.
- Prefer batch operations over item-by-item processing.
- Include realistic batch sizes and iteration limits.
- For steps requiring judgment, provide clear decision criteria (not "use your best judgment").
- Set onFailure to "escalate" for steps where ambiguity might arise.
- Steps execute sequentially. A step can reference results from prior steps by step ID.
- Available step types: "llm" (call AI model), "command" (run shell command), "http" (make HTTP request).

Output ONLY a valid JSON array of PlanStep objects. No markdown, no explanation.
```

### 6. Brain: Dispatch Integration

Modify the Brain's dispatch logic so that when the agent decides a task is complex enough to warrant planning:

- Call `generatePlan()` with the goal.
- Construct a `PlanJobDispatch` message with the resulting plan.
- Publish to `bakerst.jobs.dispatch` via JetStream (same subject, same pattern as existing dispatch).

For the trigger: add `plan` as a new dispatch option in the agent's tool definitions. When the agent's reasoning loop encounters a task that would benefit from structured execution (multi-step, bulk operations, data processing), it can choose to dispatch a `plan` job instead of a simple `agent` job. The agent prompt should be updated to know this option exists and when to prefer it.

Alternatively, if modifying the agent's tool interface is too invasive as a first pass, add a heuristic in `dispatcher.ts`: if the job description mentions batch processing, bulk operations, or large-scale tasks (or exceeds a token length threshold), automatically route through `generatePlan()` before dispatch. This can be refined later.

### 7. Brain: Status Tracker Updates

Update `status-tracker.ts` to handle:

- `PlanStepStatus` messages — these arrive on the same `bakerst.jobs.status.<jobId>` subject but include `stepId` and `stepIndex` fields. Store/forward these for UI rendering.
- The new `escalated` job status. When received:
  - If `escalationPolicy` is `'pause'`: mark the job as paused, surface to the user via SSE with the escalation context so they can intervene or instruct the Brain.
  - If `escalationPolicy` is `'replan'`: call `generatePlan()` again with the original goal plus the partial results and error context from the escalated step. Dispatch the new plan as a continuation.

### 8. Tests

Write tests for:

- `executePlan()`: mock the LLM/command/http calls and verify step-by-step execution, status publishing at each step, failure handling for each `onFailure` mode, iteration/exit condition logic, and result aggregation.
- `generatePlan()`: mock the LLM response and verify JSON parsing, validation, and retry on invalid output.
- Plan dispatch end-to-end: verify the Brain generates a plan and publishes a valid `PlanJobDispatch` to JetStream.
- Step dependency validation: ensure `dependsOn` is respected (even though current implementation is sequential, the validation should exist).

Follow existing test patterns and frameworks used in the project.

## Constraints

- Do not modify existing job type behavior. The `agent`, `command`, and `http` types must continue to work exactly as they do now.
- Do not change the NATS subject structure. Plan jobs use the same `bakerst.jobs.dispatch` subject and `JOB_WORKERS` consumer.
- Do not increase worker resource limits unless you can demonstrate the plan executor needs more than 256Mi. The plan steps should be lightweight individually.
- Maintain all existing security controls on the worker (command allowlisting, blocked env vars, read-only filesystem, etc.).
- Use TypeScript throughout. Follow existing code style (check for eslint/prettier configs and match them).

## Definition of Done

- [ ] Shared types added and exported for both Brain and Worker packages.
- [ ] Worker `executePlan()` handler implemented with all three step types (`llm`, `command`, `http`).
- [ ] Worker job routing updated to handle `type: 'plan'`.
- [ ] `planner` model role added to model router with fallback.
- [ ] `generatePlan()` function implemented in the Brain with structured output parsing.
- [ ] Brain dispatch logic updated — plan jobs can be triggered (via agent tool or heuristic).
- [ ] Status tracker handles step-level updates and the `escalated` status.
- [ ] Agent system prompt updated to know about the `plan` dispatch option.
- [ ] Tests pass for new functionality.
- [ ] Existing tests still pass (no regressions).
- [ ] Manual smoke test: dispatch a plan job, observe step-by-step status updates, verify completion.
