import { ToolExecutionError } from '../tools/errors.js';
import type { ActionClient, HelperCapabilities, RestartReceipt, RestartRequest } from './types.js';

const MOCK_UNIT = 'ssh.service';
const MOCK_STATE = { active_state: 'active', sub_state: 'running', invocation_id: 'mock-invocation' };

interface CompletedMockAction {
  request: RestartRequest;
  receipt: RestartReceipt;
}

function sameRequest(left: RestartRequest, right: RestartRequest): boolean {
  return left.protocol_version === right.protocol_version
    && left.action === right.action
    && left.operation_id === right.operation_id
    && left.unit === right.unit
    && left.reason === right.reason
    && left.expected_active_state === right.expected_active_state
    && left.expected_sub_state === right.expected_sub_state
    && left.expected_invocation_id === right.expected_invocation_id;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ToolExecutionError('TOOL_TIMEOUT', 'Mock action was aborted', { outcome: 'not_started' });
  }
}

/** Deterministic restart boundary for the Docker-only mock VM fixture. */
export class MockActionClient implements ActionClient {
  private readonly completed = new Map<string, CompletedMockAction>();

  async capabilities(signal?: AbortSignal): Promise<HelperCapabilities> {
    ensureNotAborted(signal);
    return { protocol_version: 1, policy_valid: true, restart_services: [MOCK_UNIT] };
  }

  async restart(request: RestartRequest, signal?: AbortSignal): Promise<RestartReceipt> {
    ensureNotAborted(signal);
    if (request.unit !== MOCK_UNIT) throw new ToolExecutionError('PERMISSION_DENIED', 'Service is not locally allowlisted', { outcome: 'not_started' });

    const prior = this.completed.get(request.operation_id);
    if (prior) {
      if (!sameRequest(prior.request, request)) {
        throw new ToolExecutionError('PRECONDITION_FAILED', 'Operation ID was already used with different arguments', { outcome: 'not_started' });
      }
      return prior.receipt;
    }

    const startedAt = new Date().toISOString();
    if (request.expected_active_state !== MOCK_STATE.active_state
      || request.expected_sub_state !== MOCK_STATE.sub_state
      || (request.expected_invocation_id !== undefined && request.expected_invocation_id !== MOCK_STATE.invocation_id)) {
      throw new ToolExecutionError('PRECONDITION_FAILED', 'Service state changed before restart', { outcome: 'not_started' });
    }
    const receipt: RestartReceipt = {
      operation_id: request.operation_id,
      unit: request.unit,
      outcome: 'success',
      before: MOCK_STATE,
      after: { ...MOCK_STATE, invocation_id: `mock-restart-${request.operation_id}` },
      started_at: startedAt, completed_at: new Date().toISOString(), systemd_job_result: 'done',
    };
    this.completed.set(request.operation_id, { request: { ...request }, receipt });
    return receipt;
  }
}
