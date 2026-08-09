# Production onboarding correctness audit

## Goal

Verify that a clean Linux VM can enroll AgentV through one generated command,
that repair and credential replacement cannot strand or overwrite an existing
installation, and that every producer, consumer, deployment setting, and
operator document describes the same production flow.

## Scope

- AgentV bootstrap, systemd packaging, cutover, rollback, and boot recovery
- Control-plane enrollment persistence, public transaction API, and handshake
- Management-console onboarding, repair, replacement, and secret handling
- Compose, Helm, release-matrix, OpenAPI, and public documentation wiring
- Release and staging validation evidence for version `0.0.1-experimental.5`

## Completed audit

- Traced initial enrollment, same-command rerun, credential-free repair,
  replacement, rollback, grace expiry, and interrupted boot recovery.
- Tightened credential-generation ownership, final-state recovery reads,
  transaction mutation expiry, rate limits, request redaction, production URL
  validation, and cleanup independence.
- Preserved candidate and prior release/environment state so recovery can select
  the only remotely valid credential after the rollback window closes.
- Added a live recovery smoke for the closed-grace case and systemd unit
  verification on both release-runner tracks.
- Reconciled VM/OpenAPI/client contracts, console countdown/copy behavior,
  Compose and Helm values, release-matrix checks, and operator/public docs.
- Browser-verified initial onboarding, interrupted-setup recovery,
  credential-free repair, and credential replacement at desktop and compact
  widths. Setup-required VMs now expose only initial enrollment actions; repair
  and replacement appear only after an AgentV credential can exist.
- Removed stale raw-key and legacy-string AgentV behavior. AgentK remains
  unchanged.

## Validation evidence

- Exact staged AgentV `npm run validate`: 18 files and 68 tests passed.
- AgentV `npm run smoke:package`: archive, checksum, bootstrap, and failure-path
  smoke passed; shell and JavaScript syntax checks passed.
- Control-plane migrations `001` through `004` applied to a disposable
  PostgreSQL database; the final clean isolated suite passed all 1,134 tests,
  including enrollment, handshake, administration, and successive credential
  replacement coverage.
- Control-plane typecheck, style, migrations, contracts, OpenAPI, harness, and
  build checks passed.
- Exact staged management-console control-plane-mode validation passed 1,005 tests plus
  typecheck, contracts, production build, bundle, and route checks.
- The focused fixture-browser AgentV onboarding regression passed and verifies
  sensitive-command labeling, interrupted setup recovery, maintenance-action
  separation, and replacement expiry messaging.
- Deployment validation, Helm render/schema checks, release-matrix checks, and
  cross-repository platform contracts passed.
- Public docs build and broken-link checks passed.

## Release conclusion

The implementation is merge-ready, but production promotion is intentionally
blocked until `v0.0.1-experimental.5` is published. The release page,
`install-agentv.sh`, and the AgentV archive currently return HTTP 404. After the
release workflow passes its live Ubuntu and disposable Rocky Linux 9 systemd
gates, publish the immutable assets, rerun the deployment published-artifact
gate, and perform the documented staging power-cycle recovery canary before
promoting the same matrix.
