# AgentV contract

AgentV uses the outbound control-plane WebSocket bridge. Contract version 2
intentionally replaces the prototype tool, result, and snapshot contracts.

## Dependency Matrix

| Producer | Consumer | Surface | Compatibility |
| --- | --- | --- | --- |
| `agentv` | `control-plane` | handshake, heartbeat, compressed snapshot, `tools/list`, `tools/call` | Coordinated breaking contract; no v1 aliases or dual envelopes. |
| `control-plane` | `agentv` | authenticated session policy and bounded snapshot config | AgentV rejects incomplete, stale, mismatched, or out-of-local-bounds handshake responses. |

The systemd distribution surface publishes a versioned bootstrap script,
archive, checksum, and SBOM under `<release-base-url>/v<version>/<asset>`.
Generated onboarding commands must pin the exact version and the bootstrap must
verify the archive checksum before invoking the packaged systemd installer.

## Handshake

AgentV connects with `x-connector-version: agentv/<package-version>` and sends
the fixed-ID `lifecycle/handshake` request with `targetId`,
`targetType = "virtual_machine"`, `agentType = "agentv"`, supported
capabilities, and Linux/systemd host features. It exposes no
tools, snapshots, or heartbeats until the response matches the target and
contains a non-empty `workspaceId` plus a complete `sessionPolicy`.

Pending enrollment credentials receive a provisional response. AgentV uses it
only to prove local runtime readiness, exposes no tools or telemetry, and
reconnects until the installer commits the credential. Normal readiness is
recorded only after a non-provisional authenticated handshake.

The installed tool policy is the intersection of compiled tools, remote
`allowedTools`, remote write enablement, local write enablement, and helper
capabilities. A connection-generation change revokes queued and future work.

`advertisedTools` is derived from AgentV's live tool definitions. Each entry
identifies the exact registered tool name and its read/write capability; it is
recomputed for every connection and is not a fallback grant. Write tools are
advertised only when the local helper is ready.

## Snapshot

`notify/snapshot` is gzip-compressed and contains `host_summary`, bounded
`filesystems`, failed/degraded service summaries, top processes, listeners,
findings, collector health, and explicit truncation counts. It never contains
raw logs and is dropped rather than sent when the negotiated hard byte limit
cannot be met.

## Tools

Read tools:

- `get_host_summary`
- `list_filesystems`
- `list_processes`
- `get_process`
- `list_services`
- `get_service`
- `query_logs`
- `list_listeners`

The optional `restart_service` write tool is disabled by default and is only
advertised when the root-owned helper has a valid exact unit allowlist.

`tools/list` uses canonical `inputSchema`, `outputSchema`, `artifactPolicy`,
`timeout_ms`, `version`, and `deprecated` metadata. `tools/call` returns model
context in `content`, full data in `structuredContent` under
`acornops.full-tool-result.v1`, explicit truncation/omission metadata, and
`isError` for tool-level failures.

## Shared Invariants

- AgentV remains network-outbound-only and unprivileged.
- Host commands use fixed executables and structured arguments; caller-supplied shell is prohibited.
- Journald is the only production log backend, and process environments are never collected.
- Reads and writes are separately bounded; ambiguous writes return `outcome = "unknown"` and are never retryable.
- `restart_service` crosses privilege only through `/run/acornops-agentv/actions.sock` and an exact root-owned policy.

## Validation

Run `npm run validate`, the packaging smoke, live systemd smoke where available,
and the parent workspace platform contract validation for every contract change.
