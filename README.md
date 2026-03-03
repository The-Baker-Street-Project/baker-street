# Baker Street

Kubernetes-native personal AI agent system.

## Quick Start

### Prerequisites

- Docker Desktop with Kubernetes enabled
- `kubectl` configured and pointing at your cluster

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/The-Baker-Street-Project/baker-street/main/scripts/install.sh | bash
```

This downloads the latest installer binary for your platform and runs it.

### What the Installer Does

The installer is a terminal UI (TUI) application that walks you through deploying Baker Street to your Kubernetes cluster:

1. **Preflight** — verifies `kubectl` access and cluster connectivity
2. **Secrets** — prompts for your Anthropic API key, model selection, and optional credentials
3. **Features** — lets you enable optional integrations (Telegram, Discord, GitHub, Voyage embeddings, Perplexity search, Obsidian)
4. **Confirm** — review summary before deploying
5. **Pull Images** — pulls all container images from GHCR
6. **Deploy** — creates namespaces, secrets, ConfigMaps, and all Kubernetes resources
7. **Health Check** — waits for pods to become ready
8. **Complete** — shows access URL and summary

### Non-Interactive Mode

For CI/CD or scripted deployments, set environment variables and run with `--non-interactive`:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export AGENT_NAME="Baker"
./bakerst-install --non-interactive
```

Or use a YAML config file:

```bash
./bakerst-install --config deploy.yaml
```

### Installer Options

| Flag | Description |
|------|-------------|
| `--non-interactive` | Use environment variables, skip TUI |
| `--config <PATH>` | Install from a YAML config file |
| `--manifest <PATH>` | Override the embedded manifest with a local file |
| `--namespace <NAME>` | Override namespace (default: `bakerst`) |
| `--data-dir <PATH>` | Use hostPath instead of PVC for storage |
| `--skip-telemetry` | Skip the optional telemetry stack |
| `--skip-extensions` | Skip extension pods |
| `--uninstall` | Remove all Baker Street resources |
| `--status` | Show current deployment status and exit |
| `-v, --verbose` | Show debug output |

### Building from Source

```bash
cd tools/installer
cargo build --release
./target/release/bakerst-install
```

The installer embeds its configuration manifest at compile time — no network fetch required. After building, the binary is fully self-contained.

## Access

```bash
# Default (NodePort):
open http://localhost:30080

# Fallback (port-forward):
kubectl -n bakerst port-forward svc/ui 8080:8080
open http://localhost:8080
```

## Architecture

Baker Street is a monorepo with pnpm workspaces:

- **Brain** — AI agent orchestrator (Claude API, tool routing, memory)
- **Worker** — sandboxed tool execution (code, shell, file ops)
- **Gateway** — external adapters (Telegram, Discord, API)
- **UI** — React web interface
- **Extensions** — modular tool pods (GitHub, Obsidian, browser, utilities)
- **NATS** — messaging between brain and workers
- **Qdrant** — vector database for long-term memory

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.
