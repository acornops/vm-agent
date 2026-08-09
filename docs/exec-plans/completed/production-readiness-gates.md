# Production Readiness Gates

## Goal

Turn the remaining AgentV production risks into automated, release-blocking
evidence instead of relying on manual claims.

## Scope

- Correct stale repository guidance left behind by the runtime replacement.
- Exercise helper transport and local doctor behavior directly.
- Count the existing WebSocket E2E suite in full coverage and enforce a
  non-regression floor.
- Verify release archive contents, checksums, production dependencies, and
  executable entrypoints.
- Add a hosted Ubuntu systemd smoke covering install, readiness, doctor,
  allowlisted restart, idempotent replay, rollback, and uninstall preservation.

## Affected Areas

- `AGENTS.md`
- `package.json`
- `.github/workflows/ci.yml`
- `scripts/`
- `src/actions/`
- `src/doctor.ts` and tests
- production-readiness documentation

## Contract Impact

None. These gates validate the AgentV v2 contracts without changing their
wire shape or built-in tool names.

## Validation

- `npm run validate`
- `npm run test:e2e`
- `npm run test:coverage:all`
- `npm run smoke:package`
- `bash -n scripts/systemd-smoke.sh`
- hosted Ubuntu `npm run smoke:systemd`

## Rollout And Rollback

The new package and coverage checks run in ordinary CI. The systemd smoke runs
only on an ephemeral hosted Ubuntu runner and cleans up its disposable unit.
If a gate is unstable, revert the gate and its test harness together; do not
weaken runtime safety to satisfy the harness.

## Open Questions

- Additional Linux distributions remain outside the qualified first-release
  baseline until they receive an equivalent live bootstrap and recovery gate.
- Central metrics export remains a later observability decision because
  AgentV must remain outbound-only.

## Completion Summary

Completed on July 19, 2026. Added direct tests for the action client, helper,
doctor, procfs, host facts, filesystem/systemd/socket command boundaries, and
degraded WebSocket reconnect. The full suite now enforces coverage floors of
75% lines, 60% functions, 55% branches, and 65% statements. Package smoke
validates the checksummed production archive, and both CI and release workflows
now require a guarded live Ubuntu systemd/helper smoke. Local canonical
validation, full coverage, package smoke, production dependency audit, shell
lint, script syntax, and workflow YAML syntax pass. A green hosted Ubuntu 24.04
run remains the deployment qualification gate; other Linux families are outside
the first-release support claim.
