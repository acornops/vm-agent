<p align="center">
  <img width="220" src="https://raw.githubusercontent.com/acornops/docs-website/main/logo/light.svg" alt="AcornOps" />
</p>

<h1 align="center">AcornOps AgentV</h1>

<p align="center">
  <a href="https://github.com/acornops/agentv/actions/workflows/ci.yml"><img src="https://github.com/acornops/agentv/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/acornops/agentv"><img src="https://codecov.io/gh/acornops/agentv/branch/main/graph/badge.svg" alt="Coverage" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22-green.svg" alt="Node 22" /></a>
  <a href="docs/contracts/README.md"><img src="https://img.shields.io/badge/contracts-checked-blue.svg" alt="Contracts checked" /></a>
</p>

<p align="center">
  Outbound-only Linux/systemd AgentV for bounded diagnostics and allowlisted service recovery.
</p>

## Status

This repository owns the AgentV code, systemd packaging assets, production image, AgentV protocol contract, and agent-level docs. Central platform deployment wiring belongs in `acornops-deployment`.

## Agent-Assisted Development

This repository supports human and agent-assisted development. Start coding
agents from this repository root for AgentV-only work, and from the AcornOps
workspace cloned from the [`acornops`](https://github.com/acornops/acornops)
repository for changes that touch multiple AcornOps repositories.

## Contracts

Cross-repo contract documentation lives in [`docs/contracts/README.md`](docs/contracts/README.md). This repo's direct platform dependency is the control-plane outbound agent bridge documented there.
Machine-readable contract data lives in [`docs/contracts/manifest.json`](docs/contracts/manifest.json).
Run `npm run contracts:check` to mechanically verify the documented AgentV/control-plane contract shape.

Coverage is generated in CI with Vitest V8 coverage, uploaded as a workflow
artifact, and published to Codecov when `CODECOV_TOKEN` is configured for the
repository. Run `npm run test:coverage:all` locally to include transport E2E
coverage and enforce the release floors. Reports are written as text, HTML, and lcov
reports under `coverage/`.

## Documentation

Primary docs:

- [`AGENTS.md`](AGENTS.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`docs/index.md`](docs/index.md)
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Whole-system architecture: [`../docs/system-architecture.md`](../docs/system-architecture.md)

## Features

- **Outbound-only**: Initiates a secure WebSocket connection to the control plane.
- **Host snapshots**: Collects bounded Linux/systemd telemetry for host, filesystems, degraded services, processes, listeners, findings, and collector health. Raw logs are never included.
- **MCP bridge**: Serves JSON-RPC `tools/list` and `tools/call` requests from the platform.
- **Read-only by default**: Eight strict tools inspect host state through fixed Linux/systemd adapters.
- **Isolated writes**: Optional `restart_service` actions cross privilege only through a root-owned socket helper and exact local allowlist.
- **Production transport**: Authenticated readiness, session generations, jittered reconnects, ping/pong deadlines, and hard inbound/outbound limits.

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript
- **Core Libraries**: `ws`, Zod, Vitest, and TypeScript; systemd integration uses the fixed `systemd-notify` binary
- **Packaging**: Docker image and Linux systemd unit assets

## Configuration

The agent is configured with environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `ACORNOPS_AGENT_PLATFORM_URL` | Control-plane HTTPS base URL. The agent appends `/api/v1/agent/connect`. | Required |
| `ACORNOPS_AGENT_ADDITIONAL_CA_BUNDLE_FILE` | Optional readable PEM bundle added to normal public CA trust for the control-plane WebSocket. | Empty |
| `ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT` | Allows `http://` only for local development. Do not set in production. | `false` |
| `ACORNOPS_TARGET_ID` | Control-plane VM target id this agent key is bound to. | Required |
| `ACORNOPS_AGENT_KEY` | Agent authentication token. | Required |
| `ACORNOPS_AGENT_TARGET_TYPE` | Target type advertised during handshake. | `virtual_machine` |
| `ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS` | Local snapshot cadence used unless the authenticated remote value is within local bounds. | `60000` |
| `ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES` | Maximum serialized snapshot payload size. | `1048576` |
| `ACORNOPS_AGENT_LOG_LEVEL` | Logging level (`debug`, `info`, `warn`, `error`). | `info` |
| `ACORNOPS_VM_OS_FAMILY` | VM operating system family. The current contract supports `linux`. | `linux` |
| `ACORNOPS_VM_SERVICE_MANAGER` | VM service manager. The current contract supports `systemd`. | `systemd` |
| `ACORNOPS_VM_ALLOWED_LOG_UNITS` | Comma-separated exact systemd units accepted by `query_logs`. | Empty |
| `ACORNOPS_VM_COLLECTOR_MODE` | Collector mode: `live` for Linux/systemd hosts, `mock` for local and CI development. | `live` |
| `ACORNOPS_AGENT_WRITE_ENABLED` | Locally permit helper-backed writes. The helper policy and remote session must also permit them. | `false` |
| `ACORNOPS_AGENT_ACTIONS_SOCKET` | Root-owned action helper socket. | `/run/acornops-agentv/actions.sock` |

## Local Development

Install dependencies:

```bash
npm install
```

Run validation:

```bash
npm run validate
```

Run the agent against a local control plane with mock host data:

```bash
ACORNOPS_AGENT_PLATFORM_URL=http://127.0.0.1:8081 \
ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true \
ACORNOPS_TARGET_ID=your-vm-target-id \
ACORNOPS_AGENT_KEY=your-agent-key \
ACORNOPS_AGENT_TARGET_TYPE=virtual_machine \
ACORNOPS_VM_COLLECTOR_MODE=mock \
npm run dev
```

Use `ACORNOPS_VM_COLLECTOR_MODE=mock` for local Docker and CI. Use `live` on a Linux host with systemd and journald available.

## Systemd Install Assets

Systemd packaging assets live in [`packaging/systemd`](packaging/systemd):

- `acornops-agentv.service`: hardened unprivileged main service.
- `acornops-agentv-actions.socket` and `.service`: disabled-by-default privileged helper.
- `agentv.env.example`: environment file template.
- `agentv-actions.json.example`: empty exact-unit helper policy.
- `install.sh`, `install-worker.sh`, and `uninstall.sh`: transactional install helpers for the service assets.
- `acornops-agentv-install-recover` and its unit: boot recovery for interrupted cutovers.

Tagged releases also publish `install-agentv.sh` and its checksum. The
control plane generates a version-pinned bootstrap command that downloads the
matching archive and checksum, verifies the archive, runs `install.sh`, writes
the target configuration, runs the doctor, and starts the service. The
bootstrap is safe to rerun for the same version, upgrades, and explicit
credential replacement. Initial and replacement commands exchange a 15-minute
one-use enrollment token; repair and upgrade reuse the protected local
credential.

Runtime configuration belongs in `/etc/acornops/agentv.env`. Keep that file owned by `root:acornops-agent` with mode `0640` because it contains the agent key.

The initial bootstrap requires the host trust store to validate both artifact
and platform HTTPS endpoints. An optional
`ACORNOPS_AGENT_ADDITIONAL_CA_BUNDLE_FILE` runtime setting is preserved across
repair, upgrade, and credential replacement; it does not replace initial host
trust and never disables TLS verification.

Run `acornops-agentv-doctor` after installation. Releases live under
`/opt/acornops/agentv/releases/<version>` and `current` changes atomically, so
rollback is a symlink switch followed by a service restart.

The systemd archive bundles its production Node dependencies and uses the
target host's `/usr/bin/systemd-notify` for watchdog notifications. No
target-side `npm install`, compiler, or native addon build is required.
Node.js 22 or newer must already be installed at `/usr/bin/node`; the bootstrap
does not add package repositories or modify host packages.

## Validation

Canonical validation:

```bash
npm run validate
```

Focused checks:

```bash
npm run typecheck
npm run test
npm run test:coverage:all
npm run contracts:check
npm run harness:check
npm run build
npm run smoke:package
```

The hosted Ubuntu workflow additionally runs the guarded `smoke:systemd` gate
against real systemd, journald, procfs, socket inspection, and the privileged
helper. It covers install, doctor, allowlisted restart, idempotent replay,
upgrade, rollback, and uninstall preservation. The script intentionally refuses
to run unless both `CI=true` and `AGENTV_SYSTEMD_SMOKE_ALLOW=true` are present.
