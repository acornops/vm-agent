import { describe, expect, it, vi } from 'vitest';
import type { ActionClient } from './actions/types.js';
import { MockHostAdapter } from './adapters/mock.js';
import type { HostAdapter } from './adapters/types.js';
import type { AgentConfig } from './config.js';
import { runDoctor } from './doctor.js';

const config: AgentConfig = {
  platformUrl: 'https://api.example.com', targetId: 'vm-1', agentKey: 'test', targetType: 'virtual_machine',
  connectorVersion: 'test', snapshotIntervalMs: 60_000, minSnapshotIntervalMs: 10_000, maxSnapshotIntervalMs: 3_600_000,
  maxSnapshotBytes: 65_536, minSnapshotBytes: 16_384, maxRemoteSnapshotBytes: 1_048_576,
  logLevel: 'error', collectorMode: 'mock', allowedLogUnits: ['agentv-smoke.service'], writeEnabled: true, mockActionsEnabled: false,
  helperSocketPath: '/run/acornops-agentv/actions.sock', allowInsecureTransport: false,
};

describe('runDoctor', () => {
  it('reports a healthy host and valid helper without opening inbound health transport', async () => {
    const actions: ActionClient = {
      capabilities: vi.fn(async () => ({ protocol_version: 1, policy_valid: true, restart_services: ['agentv-smoke.service'] })),
      restart: vi.fn(),
    };
    const result = await runDoctor(config, new MockHostAdapter(), actions, {
      resolveExecutable: vi.fn(async (paths) => paths[0]),
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'host', status: 'ok' }),
      expect.objectContaining({ name: 'helper', status: 'ok' }),
      expect.objectContaining({ name: 'tls', status: 'ok' }),
    ]));
  });

  it('distinguishes hard host failures from degraded optional capabilities', async () => {
    const host = {
      getHostSummary: vi.fn(async () => { throw new Error('procfs unavailable'); }),
      listFilesystems: vi.fn(async () => { throw new Error('df unavailable'); }),
      queryLogs: vi.fn(async () => { throw new Error('journal denied'); }),
    } as unknown as HostAdapter;
    const actions = {
      capabilities: vi.fn(async () => { throw new Error('socket unavailable'); }),
      restart: vi.fn(),
    } as ActionClient;
    const result = await runDoctor({ ...config, platformUrl: 'http://127.0.0.1:8081' }, host, actions, {
      resolveExecutable: vi.fn(async (paths) => {
        if (paths.includes('/usr/bin/ss')) throw new Error('missing');
        return paths[0];
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'binary:ss', status: 'failed' }),
      expect.objectContaining({ name: 'host', status: 'failed' }),
      expect.objectContaining({ name: 'filesystems', status: 'failed' }),
      expect.objectContaining({ name: 'journald', status: 'degraded' }),
      expect.objectContaining({ name: 'helper', status: 'degraded' }),
      expect.objectContaining({ name: 'tls', status: 'degraded' }),
    ]));
  });

  it('does not probe the privileged helper when writes are locally disabled', async () => {
    const actions = { capabilities: vi.fn(), restart: vi.fn() } as ActionClient;
    const result = await runDoctor({ ...config, writeEnabled: false }, new MockHostAdapter(), actions, {
      resolveExecutable: vi.fn(async (paths) => paths[0]),
    });
    expect(result.ok).toBe(true);
    expect(actions.capabilities).not.toHaveBeenCalled();
    expect(result.checks).toContainEqual({ name: 'helper', status: 'ok', message: 'Write helper intentionally disabled' });
  });
});
