# AgentV Development

## Scope

This repository owns the Linux/systemd AgentV, host collectors, JSON-RPC/MCP
tool bridge, outbound WebSocket lifecycle, and systemd packaging assets.

## Prerequisites

- Node.js compatible with `package.json`
- npm
- Optional: a Linux host with systemd and journald for live collector checks

## Local Development

Install dependencies:

```bash
npm install
```

Run against a local control plane:

```bash
ACORNOPS_AGENT_PLATFORM_URL=http://127.0.0.1:8081 \
ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true \
ACORNOPS_TARGET_ID=<target-id> \
ACORNOPS_AGENT_KEY=<agent-key> \
ACORNOPS_AGENT_TARGET_TYPE=virtual_machine \
ACORNOPS_VM_COLLECTOR_MODE=mock \
npm run dev
```

`ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT=true` is only for local development
against a plaintext localhost control plane. Production agents must use HTTPS.
Use `ACORNOPS_VM_COLLECTOR_MODE=mock` for Docker and CI. Use `live` on a Linux
host with systemd and journald available.

## Validation

Canonical validation:

```bash
npm run validate
```

Focused checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:coverage:all
npm run contracts:check
npm run harness:check
npm run build
npm run smoke:package
```

`npm run test:coverage` uses Vitest V8 coverage and writes text, HTML, and lcov
reports under `coverage/`. `npm run test:coverage:all` also includes the local
WebSocket E2E suite and enforces the CI non-regression floors.

The release archive smoke verifies its checksum, safe paths, required units and
entrypoints, production-only dependency tree, executable modes, and ability to
load the installed helper client from the extracted artifact.

## Live systemd gate

Release CI runs the live systemd smoke on an ephemeral hosted Ubuntu VM and a
disposable Rocky Linux 9 runner. It exercises the packaged bootstrap and
artifact with real systemd, journald, procfs, and sockets, then performs
transactional credential replacement and recovery, an exact-allowlisted helper
restart, replay, upgrade, rollback, and uninstall-preservation checks.

The command mutates systemd and is deliberately guarded. It refuses to run
unless it is root on a live systemd host and both `CI=true` and
`AGENTV_SYSTEMD_SMOKE_ALLOW=true` are set. Do not bypass those guards on a
workstation or persistent host.

## Documentation Drift Control

Treat documentation as part of feature acceptance. Update the nearest durable
doc in the same change when work changes agent behavior, JSON-RPC/MCP tools,
systemd packaging, configuration, deployment behavior, operations, security, or
reliability.

If docs are intentionally unchanged, record `Docs impact: none` and the reason
in handoff evidence.

Update these docs when their surfaces change:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) for source layout, runtime boundaries, and high-risk flows.
- [`docs/contracts/README.md`](contracts/README.md) and [`docs/contracts/manifest.json`](contracts/manifest.json) for control-plane protocol changes.
- [`docs/OPERATIONS.md`](OPERATIONS.md) for systemd, runtime, and deployment changes.
- [`docs/security-model.md`](security-model.md) for secret handling, host access, or trust boundary changes, and [`docs/SECURITY.md`](SECURITY.md) for vulnerability reporting.
- [`docs/index.md`](index.md) when adding or moving durable docs.

## Documentation Harness

Keep `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `docs/index.md`, this file,
and `docs/OPERATIONS.md` in sync when changing repo behavior.
`npm run harness:check` enforces the required structure.
