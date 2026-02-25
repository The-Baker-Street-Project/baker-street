# Refactoring Plan: Decoupling OpenClaw from Infrastructure

This document outlines the plan to separate the core infrastructure logic (Kubernetes, NATS) from the specific AI business logic ("OpenClaw") in the `services/brain` and `services/worker` packages.

## 1. Analysis of Current Structure

The current codebase exhibits high coupling between business logic and infrastructure concerns:

*   **`services/brain`**: Acts as both the AI reasoning engine and the infrastructure controller. It constructs LLM prompts while simultaneously importing Kubernetes client libraries to define and spawn Job manifests.
*   **`services/worker`**: Contains hardcoded logic for specific OpenClaw tools (e.g., "Sandbox" execution) mixed directly into NATS subscription handlers.

## 2. Identified Instances of Mixed Concerns

### In `services/brain`
1.  **Kubernetes Job Definitions**:
    *   *Current*: Code generating `batch/v1` YAML/JSON manifests (image names, resource limits, volume mounts) is located directly inside intent classification logic.
    *   *Problem*: The "Brain" knows *how* a task is executed rather than just *what* needs to be done.
2.  **NATS Subject Parsing**:
    *   *Current*: Logic listening to `openclaw.requests.>` parses specific strings to extract user intents.
    *   *Problem*: Protocol-specific topic parsing is mixed with domain logic.

### In `services/worker`
1.  **Hardcoded Prompt Injection**:
    *   *Current*: Workers inject specific context (e.g., "You are an OpenClaw worker...") upon receiving a job.
    *   *Problem*: Prevents the worker from being a generic task runner.
2.  **Tool Execution Logic**:
    *   *Current*: Specific tools (like `run_shell`, `read_file`) are implemented directly within NATS message handler callbacks.

## 3. Proposed Architecture: `@bakerst/core`

We will move the "plumbing" (K8s, NATS) into a reusable library `@bakerst/core`, leaving services to focus on "thinking" (Brain) and "doing" (Worker).

### Phase 1: Create `@bakerst/core` Package
Initialize a new workspace package with zero dependencies on OpenClaw business logic.

**Key Abstractions:**
*   **`JobSpawner`**: An interface to abstract container orchestration.
    ```typescript
    export interface JobConfig {
      image: string;
      command: string[];
      env: Record<string, string>;
    }
    export interface JobSpawner {
      spawn(jobId: string, config: JobConfig): Promise<void>;
    }
    ```
*   **`BusAdapter`**: An interface to abstract messaging.
    ```typescript
    export interface BusAdapter {
      publish(subject: string, data: unknown): Promise<void>;
      subscribe(subject: string, handler: (data: unknown) => Promise<void>): void;
    }
    ```

### Phase 2: Refactor `services/brain`
*   Remove direct Kubernetes dependencies.
*   Inject `JobSpawner` and `BusAdapter` into the Brain service.
*   **Goal**: Replace `k8sApi.createNamespacedJob(...)` with `jobSpawner.spawn(...)`.

### Phase 3: Refactor `services/worker`
*   Abstract tool execution into a registry pattern.
*   The Worker should receive a payload and execute a registered handler without knowing it is part of "OpenClaw".

## 4. Configuration Strategy

The following hardcoded items must be moved to a configuration provider (e.g., `config/default.yaml` or `dotenv`):

### Environment Variables
*   `OPENCLAW_MODEL` (currently hardcoded to specific versions like `claude-3-opus...`)
*   `ANTHROPIC_API_KEY` (currently accessed via `process.env` deep in logic)
*   `NATS_URL` (currently uses hardcoded defaults like `nats://localhost:4222`)
*   `KUBECONFIG` (currently assumes local paths)

### Hardcoded Tools & Constants
*   **`sandbox_docker_image`**: Move specific image tags (e.g., `openclaw/sandbox:latest`) to config.
*   **`system_prompts`**: Move static strings ("You are a helpful AI assistant...") to external text/JSON files.
*   **Tool Definitions**: Move JSON schemas for tools (`web_browser`, `file_system`) to a `tools/` directory or configuration file.