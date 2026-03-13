# Installer Test Scenarios

Automated end-to-end installer validation. Each YAML file is an "answer file" —
a non-interactive config that drives the installer through a specific provider/model
combination, then verifies the deployment is healthy.

## Quick Start

```bash
# Run all scenarios (downloads latest installer from GHCR):
./run-scenarios.sh

# Run a specific scenario:
./run-scenarios.sh scenario-anthropic-cloud.yaml

# Use a specific version:
./run-scenarios.sh --version 0.6.0

# Use a local binary (skip download):
./run-scenarios.sh --binary ./bakerst-install
```

## Required Environment Variables

Set these before running. Scenarios reference them via `${VAR_NAME}` interpolation.

| Variable | Used By | Notes |
|----------|---------|-------|
| `ANTHROPIC_API_KEY` | anthropic scenarios | Claude API key |
| `OPENAI_API_KEY` | openai scenarios | GPT API key |
| `VOYAGE_API_KEY` | voyage scenarios | Voyage AI embeddings |
| `OLLAMA_HOST` | ollama scenarios | Default: `host.docker.internal:11434` |
| `OLLAMA_HOST_2` | multi-endpoint | Default: `host.docker.internal:8085` |

Scenarios that reference unset variables will fail at provider validation
("at least one AI provider must be configured").

## Answer File Template

```yaml
# ================================================
# Baker Street Installer — Test Scenario Template
# ================================================
# Copy this and customize for your test case.
# Run:  bakerst-install install --config <this-file>
#
# Env var interpolation: ${VAR_NAME} resolved at runtime.
# Auto-generate:         Set value to "auto" (e.g. AUTH_TOKEN: auto).
# GHCR images:           Installer fetches from GHCR by default.

# Pin to a specific release, or omit for latest
# version: "0.6.0"

# Use a test namespace — cleaned up after each scenario
namespace: bakerst-test

# AI persona name
agentName: TestAgent

secrets:
  # --- Provider (at least one required) ---
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
  # OPENAI_API_KEY: "${OPENAI_API_KEY}"
  # OLLAMA_ENDPOINTS: "host.docker.internal:11434"

  # --- Model Roles ---
  DEFAULT_MODEL: "claude-sonnet-4-20250514"       # Agent role
  WORKER_MODEL: "claude-haiku-4-5-20251001"       # Worker role
  # OBSERVER_MODEL: ""                            # Future: defaults to WORKER_MODEL
  # REFLECTOR_MODEL: ""                           # Future: defaults to DEFAULT_MODEL

  # --- Core ---
  AUTH_TOKEN: auto                                 # Auto-generates 32-byte hex token
  AGENT_NAME: TestAgent

  # --- Memory ---
  # VOYAGE_API_KEY: "${VOYAGE_API_KEY}"

features:
  telegram: false
  discord: false
  github: false
  perplexity: false
  obsidian: false
  voice: false
  google-workspace: false
  voyage: false

verify:
  expectedPods:
    - brain-blue
    - worker
    - ui
    - gateway
    - nats
    - qdrant
  chatPrompt: "Respond with exactly: SCENARIO_TEST_PASSED"
  timeoutSeconds: 300
```

## Scenarios

| File | Provider | Agent Model | Worker Model | Features | Purpose |
|------|----------|-------------|-------------|----------|---------|
| `scenario-anthropic-cloud.yaml` | Anthropic | sonnet 4 | haiku 4.5 | none | Baseline cloud install |
| `scenario-openai-cloud.yaml` | OpenAI | gpt-4o | gpt-4o-mini | none | OpenAI provider path |
| `scenario-ollama-single.yaml` | Ollama (1 endpoint) | qwen2.5-coder:32b | qwen3.5:9b | none | Local-only install |
| `scenario-ollama-multi.yaml` | Ollama (2 endpoints) | qwen2.5-coder:32b | qwen3.5:9b | none | Multi-host inference |
| `scenario-anthropic-voyage.yaml` | Anthropic | sonnet 4 | haiku 4.5 | voyage | Enhanced memory/embeddings |
| `scenario-dual-provider.yaml` | Anthropic + Ollama | sonnet 4 | qwen3.5:9b | none | Cloud agent + local worker |

## What Gets Tested

For each scenario, the runner validates:

1. **Install completes** — installer exits 0
2. **Pods healthy** — all expectedPods are Running with ready replicas
3. **Brain API** — `/ping` responds OK
4. **NATS** — health endpoint responds
5. **Test prompt** — sends a chat message, gets a response
6. **Model config** — correct DEFAULT_MODEL and WORKER_MODEL on brain pod
7. **UI serves** — HTTP 200 on NodePort 30080
8. **Gateway reachable** — gateway service responds

After all checks, the namespace is deleted before the next scenario.

## Writing New Scenarios

1. Copy the template above into a new `scenario-<name>.yaml`
2. Set the provider secret(s) and model(s)
3. Adjust `verify.expectedPods` if your scenario changes the pod set
4. Run: `./run-scenarios.sh scenario-<name>.yaml`
