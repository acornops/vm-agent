import { describe, expect, it } from 'vitest';
import { MockActionClient } from './mock.js';

const request = {
  protocol_version: 1 as const, action: 'restart_service' as const, operation_id: '0123456789abcdef01234567', unit: 'ssh.service', reason: 'Verify local mock restart',
  expected_active_state: 'active', expected_sub_state: 'running', expected_invocation_id: 'mock-invocation',
};

describe('MockActionClient', () => {
  it('advertises and simulates the one allowlisted local fixture service', async () => {
    const actions = new MockActionClient();
    await expect(actions.capabilities()).resolves.toEqual({ protocol_version: 1, policy_valid: true, restart_services: ['ssh.service'] });
    await expect(actions.restart(request)).resolves.toMatchObject({
      unit: 'ssh.service',
      outcome: 'success',
      before: { invocation_id: 'mock-invocation' },
      after: { invocation_id: `mock-restart-${request.operation_id}` },
      systemd_job_result: 'done',
    });
  });

  it('keeps the mock fixture exact-unit allowlisted', async () => {
    await expect(new MockActionClient().restart({ ...request, unit: 'nginx.service' })).rejects.toMatchObject({ toolCode: 'PERMISSION_DENIED' });
  });

  it('enforces the same service-state preconditions as the production helper', async () => {
    const actions = new MockActionClient();
    await expect(actions.restart({ ...request, expected_sub_state: 'failed' }))
      .rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED', data: { outcome: 'not_started' } });
    await expect(actions.restart({ ...request, operation_id: '0123456789abcdef01234568', expected_invocation_id: 'stale-invocation' }))
      .rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED', data: { outcome: 'not_started' } });
  });

  it('replays an identical operation without simulating a second restart', async () => {
    const actions = new MockActionClient();
    const first = await actions.restart(request);
    await expect(actions.restart({ ...request })).resolves.toEqual(first);
    await expect(actions.restart({ ...request, reason: 'Different operation reuse' }))
      .rejects.toMatchObject({ toolCode: 'PRECONDITION_FAILED' });
  });

  it('honors cancellation before mock helper access', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new MockActionClient().capabilities(controller.signal)).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT' });
    await expect(new MockActionClient().restart(request, controller.signal)).rejects.toMatchObject({ toolCode: 'TOOL_TIMEOUT' });
  });
});
