import { describe, expect, it, vi } from 'vitest';
import type { ServiceDetail } from '../adapters/types.js';
import { createLogger } from '../logger.js';
import type { LedgerRecord } from './ledger.js';
import { requestHash } from './ledger.js';
import { ActionHelper, validatePolicy, validateRestartRequest } from './helper.js';

const request = {
  protocol_version: 1,
  action: 'restart_service',
  operation_id: '0123456789abcdef01234567',
  unit: 'disposable-worker.service',
  reason: 'Recover the approved disposable worker',
  expected_active_state: 'active',
  expected_sub_state: 'running',
  expected_invocation_id: '0123456789abcdef',
};

function service(invocationId: string, activeState = 'active', subState = 'running'): ServiceDetail {
  return {
    unit: request.unit, description: 'Disposable worker', load_state: 'loaded', active_state: activeState, sub_state: subState,
    unit_file_state: 'enabled', main_pid: 123, result: 'success', exec_main_status: 0, restart_count: 0,
    invocation_id: invocationId, fragment_path: '/etc/systemd/system/disposable-worker.service',
    active_enter_timestamp: 'Sat 2026-07-19 00:00:00 UTC', inactive_enter_timestamp: null,
    restart_preconditions: { active_state: activeState, sub_state: subState, invocation_id: invocationId },
  };
}

function harness(options: { get?: ReturnType<typeof vi.fn>; restart?: ReturnType<typeof vi.fn> } = {}) {
  const records = new Map<string, LedgerRecord>();
  const ledger = {
    initialize: vi.fn(async () => undefined),
    get: vi.fn(async (operationId: string) => records.get(operationId) ?? null),
    put: vi.fn(async (record: LedgerRecord) => { records.set(record.request.operation_id, record); }),
    prune: vi.fn(async () => undefined),
  };
  const get = options.get ?? vi.fn()
    .mockResolvedValueOnce(service(request.expected_invocation_id!))
    .mockResolvedValueOnce(service('after-invocation'));
  const restart = options.restart ?? vi.fn(async () => undefined);
  const loadPolicy = vi.fn(async () => ({ schemaVersion: 1 as const, restartServices: [request.unit] }));
  const helper = new ActionHelper('/policy.json', '/ledger', createLogger('error'), {
    ledger,
    systemd: { get },
    restart,
    loadPolicy,
  });
  return { helper, ledger, records, get, restart, loadPolicy };
}

describe('action helper boundary validation', () => {
  it('accepts only exact, unique, non-protected service allowlists', () => {
    expect(validatePolicy({ schemaVersion: 1, restartServices: ['disposable-worker.service'] }).restartServices).toEqual(['disposable-worker.service']);
    expect(() => validatePolicy({ schemaVersion: 1, restartServices: ['*.service'] })).toThrow('invalid');
    expect(() => validatePolicy({ schemaVersion: 1, restartServices: ['acornops-agentv.service'] })).toThrow('invalid');
    expect(() => validatePolicy({ schemaVersion: 1, restartServices: ['acornops-agentv-install-recovery.service'] })).toThrow('invalid');
    expect(() => validatePolicy({ schemaVersion: 1, restartServices: ['a.service', 'a.service'] })).toThrow('invalid');
    expect(() => validatePolicy({
      schemaVersion: 1,
      restartServices: Array.from({ length: 33 }, (_, index) => `worker-${index}.service`),
    })).toThrow('invalid');
    expect(() => validatePolicy({ schemaVersion: 1, restartServices: [], command: '/bin/true' })).toThrow('invalid');
  });

  it('rejects malformed, protected, and unbounded restart requests', () => {
    expect(validateRestartRequest(request).unit).toBe('disposable-worker.service');
    expect(() => validateRestartRequest({ ...request, operation_id: 'unstable' })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, unit: 'acornops-agentv-actions.service' })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, unit: 'acornops-agentv-install-recovery.service' })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, expected_invocation_id: 'x'.repeat(129) })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, reason: '' })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, reason: '   ' })).toThrow('Invalid restart request');
    expect(() => validateRestartRequest({ ...request, command: 'systemctl restart anything.service' })).toThrow('Invalid restart request');
  });

  it('serves strict capabilities and rejects malformed protocol lines', async () => {
    const { helper } = harness();
    await expect(helper.handleRequest(JSON.stringify({ protocol_version: 1, action: 'capabilities' }))).resolves.toEqual({
      protocol_version: 1, policy_valid: true, restart_services: [request.unit],
    });
    await expect(helper.handleRequest(JSON.stringify({ protocol_version: 1, action: 'capabilities', command: '/bin/true' })))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(helper.handleRequest('{')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(helper.handleRequest('[]')).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('rejects invalid protocol and action fields before reading helper policy', async () => {
    const { helper, loadPolicy } = harness();
    await expect(helper.handleRequest(JSON.stringify({ protocol_version: 2, action: 'capabilities' })))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(helper.handleRequest(JSON.stringify({ protocol_version: 1, action: 'run_command' })))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it('records in-progress state before restart and returns an idempotent verified receipt', async () => {
    const { helper, ledger, restart } = harness();
    const receipt = await helper.handleRequest(JSON.stringify(request));
    expect(ledger.put).toHaveBeenCalledTimes(2);
    expect(ledger.put.mock.calls[0][0]).toMatchObject({ receipt: { outcome: 'unknown', completed_at: null } });
    expect(restart).toHaveBeenCalledWith(request.unit);
    expect(receipt).toMatchObject({ outcome: 'success', before: { invocation_id: request.expected_invocation_id }, after: { invocation_id: 'after-invocation' } });
    await expect(helper.handleRequest(JSON.stringify(request))).resolves.toEqual(receipt);
    expect(restart).toHaveBeenCalledTimes(1);
    await expect(helper.handleRequest(JSON.stringify({ ...request, reason: 'different reuse' })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('fails precondition races before writing the ledger or invoking systemd', async () => {
    const get = vi.fn(async () => service('changed', 'inactive', 'dead'));
    const { helper, ledger, restart } = harness({ get });
    await expect(helper.handleRequest(JSON.stringify(request))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(ledger.put).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('serializes restarts and rejects a concurrent operation before mutation', async () => {
    let releaseRestart!: () => void;
    const restart = vi.fn(() => new Promise<void>((resolve) => { releaseRestart = resolve; }));
    const get = vi.fn()
      .mockResolvedValueOnce(service(request.expected_invocation_id!))
      .mockResolvedValueOnce(service('after-invocation'));
    const { helper } = harness({ get, restart });
    const first = helper.handleRequest(JSON.stringify(request));
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    await expect(helper.handleRequest(JSON.stringify({ ...request, operation_id: '0123456789abcdef01234568' })))
      .rejects.toMatchObject({ code: 'TOOL_BUSY', outcome: 'not_started' });
    releaseRestart();
    await expect(first).resolves.toMatchObject({ outcome: 'success' });
  });

  it('persists unknown when post-restart state cannot be verified', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(service(request.expected_invocation_id!))
      .mockRejectedValueOnce(new Error('systemd unavailable'));
    const { helper, records } = harness({ get });
    await expect(helper.handleRequest(JSON.stringify(request))).resolves.toMatchObject({ outcome: 'unknown', after: null });
    expect(records.get(request.operation_id)).toMatchObject({
      request_hash: requestHash(request), receipt: { outcome: 'unknown', completed_at: expect.any(String) },
    });
  });

  it('returns a stored surviving in-progress receipt without retrying the host action', async () => {
    const { helper, records, restart } = harness();
    const receipt = {
      operation_id: request.operation_id, unit: request.unit, outcome: 'unknown' as const,
      before: { active_state: 'active', sub_state: 'running', invocation_id: 'before' }, after: null,
      started_at: '2026-07-19T00:00:00.000Z', completed_at: null, systemd_job_result: null,
    };
    records.set(request.operation_id, { request_hash: requestHash(request), request, receipt, updated_at: receipt.started_at });
    await expect(helper.handleRequest(JSON.stringify(request))).resolves.toEqual(receipt);
    expect(restart).not.toHaveBeenCalled();
  });
});
