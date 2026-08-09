# Local write-approval fixture

## Goal

Exercise AgentV's approval-gated `restart_service` contract in the local Docker
stack without granting container access to host systemd or weakening production
defaults.

## Outcome

- Added an explicit mock-only action client for the fixture's `ssh.service`.
- Required mock collector mode, local writes, and a separate mock-action opt-in.
- Preserved exact-unit allowlisting, state preconditions, cancellation,
  idempotent operation replay, and a synthetic invocation-changing receipt.
- Kept live AgentV on the root-owned socket helper and read-only by default.
- Enabled the fixture through one local deployment override shared by the write
  and mock-action gates.

## Validation

- `npm run validate`: passed 19 files and 74 tests plus contract, harness, and
  build checks.
- `npm run smoke:package`: passed archive, bootstrap, and failure-path checks for
  `0.0.1-experimental.6`.
- Local mock collector behavior is covered by configuration and action-client
  tests. Live systemd behavior remains covered by the release workflow gates.

## Release impact

AgentV moves to `0.0.1-experimental.6`; the control plane and deployment matrix
pin that exact immutable release.
