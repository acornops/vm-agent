# Security Model

## Trust Boundaries

The unprivileged AgentV runs on a host with access to local system telemetry and connects outbound to the AcornOps control plane. Treat that authenticated WebSocket as the only remote command channel. Optional mutation crosses a separate root-owned local socket with an exact policy.

Read tools never execute arbitrary shell input. `restart_service` is the only write: it is disabled by default, rejects AgentV's own units, requires an exact allowlist plus preconditions, and cannot perform arbitrary commands, package changes, process kills, or filesystem mutation.

Read-write onboarding snapshots the exact unit allowlist in the one-use
enrollment. Only the root installer receives that policy and enables the
privileged socket. Repair and ordinary credential replacement preserve it;
an explicit host-policy update installs its new token-bound snapshot. Every
path is transactional, so editing the copied command cannot widen host access
and a failed cutover restores the prior policy and socket state.

## Secrets

One-use enrollment tokens are accepted only by the bootstrap and exchanged for
a durable AgentV credential after non-mutating validation. Enrollment tokens,
transaction secrets, durable credentials, complete generated commands, and
environment contents must not enter logs. Durable credentials are read from
the systemd environment file; keep `/etc/acornops/agentv.env` owned by
`root:acornops-agent` with mode `0640`.

Do not include agent keys, bearer tokens, SSH keys, cloud credentials, or password-like arguments in snapshots, tool responses, or test fixtures.

## Host Data Handling

Process command lines are truncated and token-like arguments are redacted. Host log reads are bounded by line count and byte count. Snapshot payloads are bounded by `ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES`.

Collectors should model OS family, service manager, log source, and collector mode explicitly so future adapters do not inherit Linux/systemd assumptions accidentally.

## Systemd Hardening

The systemd unit runs as `acornops-agent` with:

- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `PrivateDevices=true`
- `ProtectSystem=strict`
- `ProtectHome=true`
- kernel, control-group, namespace, realtime, and address-family restrictions

The main unit has no writable host path. Only the separate root helper receives
`ReadWritePaths=/var/lib/acornops-agentv/actions`, has no network namespace, and
serves the group-restricted Unix socket.

## High-Risk Changes

- Adding write-capable tools or shell execution.
- Expanding log or process collection without new redaction tests.
- Changing agent key headers, handshake auth fields, or error logging.
- Changing systemd hardening settings.
- Adding persistent local state.

## Required Validation

Run `npm run validate` for security-sensitive changes. Add focused tests for new redaction, bounding, or host-access behavior.
