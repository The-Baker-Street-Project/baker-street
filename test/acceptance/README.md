# Acceptance Test

End-to-end validation that the installer can deploy Baker Street to a fresh Kubernetes cluster and the core services come up healthy.

## What it tests

1. Installer runs with `test-config.yaml` (non-interactive, minimal features)
2. Core pods start: brain-blue, worker, ui, nats, qdrant
3. Brain API responds to `/ping`

## Running locally

Prerequisites: Docker Desktop with Kubernetes enabled, Rust toolchain.

```bash
# Build the installer
cd tools/installer && cargo build --release

# Run against your local cluster (uses your current kubectl context)
./target/release/bakerst-install install \
  --config ../../test/acceptance/test-config.yaml \
  --manifest <path-to-manifest.json>
```

Set `ANTHROPIC_API_KEY` in your environment or the installer will prompt for it.

## CI integration

The release workflow (`.github/workflows/release.yml`, stage 7) runs the acceptance test automatically on every release:

1. Spins up a [kind](https://kind.sigs.k8s.io/) cluster
2. Pulls the just-built GHCR images and loads them into kind
3. Runs the installer with `test-config.yaml`, a generated `manifest.json`, and the bundled template
4. Waits for brain, worker, and ui pods to become ready (180s timeout)
5. Port-forwards to brain and hits `/ping`

The `ANTHROPIC_API_KEY` secret is provided via GitHub Actions secrets. If the acceptance test fails, the release is not published.

## Config reference

See `test-config.yaml` for the test configuration. Key settings:

- All optional features disabled (telegram, discord, github, obsidian, voice, google-workspace)
- `AUTH_TOKEN: auto` generates a random token
- `AGENT_NAME: Baker` uses the default persona
