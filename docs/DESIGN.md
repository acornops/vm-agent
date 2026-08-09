# AgentV Design

## Product Principles

The AgentV should be boring to operate on production hosts: outbound-only, read-only by default, and explicit about every host and privilege boundary it crosses.

## Interaction Model

Operators register a VM target and run one version-pinned command containing a
short-lived enrollment token. The root installer exchanges it for the durable,
target-bound credential stored in the protected environment file. Repair and
upgrade reuse that credential; replacement is a provisional, rollback-safe
transaction.

The control plane requests diagnostics through JSON-RPC. The AgentV returns bounded host data and does not expose a general shell, package manager, process control, or service restart interface.

## Runtime Design Rules

- Keep host-specific behavior behind narrow adapters.
- Keep mutation isolated to a root-owned helper, exact allowlist, durable receipt, and post-write verification.
- Bound snapshots, logs, and process lists before sending them to the control plane.
- Redact token-like process arguments and never log agent keys.
- Model OS family and service manager in config, contracts, and snapshots.

## Non-Goals

- Arbitrary remote shell execution.
- Package installation or OS patching.
- Process kills, service restarts, or filesystem mutation.
- Local durable queueing of snapshots or tool requests.
- Windows or non-systemd support in v1.

## Validation

Run `npm run validate` for design-sensitive changes. Add focused unit tests for new collectors, tool handlers, redaction rules, or payload bounds.
