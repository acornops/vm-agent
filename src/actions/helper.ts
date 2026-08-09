import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import type { Logger } from '../logger.js';
import { runCommand } from '../adapters/command-runner.js';
import { SystemdAdapter } from '../adapters/systemd.js';
import { SERVICE_UNIT } from '../tools/index.js';
import { ActionLedger, requestHash } from './ledger.js';
import type { RestartReceipt, RestartRequest } from './types.js';

function isProtectedAgentVUnit(unit: string): boolean {
  return unit === 'acornops-agentv.service' || unit.startsWith('acornops-agentv-');
}
interface Policy { schemaVersion: 1; restartServices: string[]; }
interface ActionHelperDependencies {
  ledger: Pick<ActionLedger, 'initialize' | 'get' | 'put' | 'prune'>;
  systemd: Pick<SystemdAdapter, 'get'>;
  loadPolicy: (file: string) => Promise<Policy>;
  restart: (unit: string) => Promise<void>;
}

/** Validate an actions policy after its ownership and mode have been checked. */
export function validatePolicy(raw: unknown): Policy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Action policy is invalid');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'restartServices')
    || value.schemaVersion !== 1 || !Array.isArray(value.restartServices) || value.restartServices.length > 32
    || !value.restartServices.every((unit) => typeof unit === 'string' && SERVICE_UNIT.test(unit) && !unit.includes('*') && !isProtectedAgentVUnit(unit))
    || new Set(value.restartServices).size !== value.restartServices.length) throw new Error('Action policy is invalid');
  return value as unknown as Policy;
}

/** Validate and normalize a restart request before any host access. */
export function validateRestartRequest(request: Record<string, unknown>): RestartRequest {
  const allowedFields = new Set(['protocol_version', 'action', 'operation_id', 'unit', 'reason', 'expected_active_state', 'expected_sub_state', 'expected_invocation_id']);
  if (Object.keys(request).some((key) => !allowedFields.has(key))
    || request.protocol_version !== 1 || request.action !== 'restart_service'
    || typeof request.operation_id !== 'string' || !/^[a-f0-9]{24}$/.test(request.operation_id)
    || typeof request.unit !== 'string' || !SERVICE_UNIT.test(request.unit) || isProtectedAgentVUnit(request.unit)
    || typeof request.reason !== 'string' || request.reason.trim().length < 1 || request.reason.length > 512
    || typeof request.expected_active_state !== 'string' || request.expected_active_state.length < 1 || request.expected_active_state.length > 64
    || typeof request.expected_sub_state !== 'string' || request.expected_sub_state.length < 1 || request.expected_sub_state.length > 64
    || (request.expected_invocation_id !== undefined
      && (typeof request.expected_invocation_id !== 'string' || request.expected_invocation_id.length < 1 || request.expected_invocation_id.length > 128))) {
    throw Object.assign(new Error('Invalid restart request'), { code: 'INVALID_ARGUMENTS' });
  }
  return request as unknown as RestartRequest;
}

async function loadPolicy(file: string): Promise<Policy> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Action policy must be a regular file no larger than 64 KiB');
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Action policy must be root-owned and not group/world writable');
  return validatePolicy(JSON.parse(await readFile(file, 'utf8')));
}

function state(detail: Awaited<ReturnType<SystemdAdapter['get']>>) { return { active_state: detail.active_state, sub_state: detail.sub_state, invocation_id: detail.invocation_id }; }

/** Serve serialized, allowlisted restart actions for a socket-activated root service. */
export class ActionHelper {
  private readonly dependencies: ActionHelperDependencies;
  private busy = false;
  constructor(
    private readonly policyFile: string,
    ledgerDirectory: string,
    private readonly logger: Logger,
    dependencies: Partial<ActionHelperDependencies> = {},
  ) {
    this.dependencies = {
      ledger: dependencies.ledger ?? new ActionLedger(ledgerDirectory),
      systemd: dependencies.systemd ?? new SystemdAdapter(),
      loadPolicy: dependencies.loadPolicy ?? loadPolicy,
      restart: dependencies.restart ?? (async (unit) => {
        await runCommand('/bin/systemctl', ['restart', unit], { timeoutMs: 30_000, maxBytes: 256 * 1024 });
      }),
    };
  }

  async start(): Promise<net.Server> {
    await this.dependencies.ledger.initialize();
    const server = net.createServer((socket) => this.connection(socket));
    const listen = Number(process.env.LISTEN_FDS) === 1 && Number(process.env.LISTEN_PID) === process.pid ? { fd: 3 } : { path: process.env.ACORNOPS_AGENTV_HELPER_TEST_SOCKET || '/run/acornops-agentv/actions.sock' };
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listen, () => { server.off('error', reject); resolve(); }); });
    return server;
  }

  private connection(socket: net.Socket): void {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 32 * 1024) { this.reply(socket, false, undefined, { code: 'INVALID_ARGUMENTS', message: 'Request exceeds 32 KiB', outcome: 'not_started' }); return; }
      const newline = input.indexOf('\n'); if (newline < 0) return;
      socket.pause();
      if (input.slice(newline + 1).trim()) {
        this.reply(socket, false, undefined, { code: 'INVALID_ARGUMENTS', message: 'Only one request is allowed per connection', outcome: 'not_started' });
        return;
      }
      void this.handleRequest(input.slice(0, newline)).then((result) => this.reply(socket, true, result)).catch((error) => {
        const value = error as Error & { code?: string; outcome?: string };
        this.reply(socket, false, undefined, { code: value.code || 'INTERNAL_ERROR', message: value.message || 'Action failed', outcome: value.outcome || 'not_started' });
      });
    });
  }

  /** Process one bounded helper protocol line after socket framing. */
  async handleRequest(line: string): Promise<unknown> {
    let request: Record<string, unknown>; try { request = JSON.parse(line); } catch { throw Object.assign(new Error('Malformed JSON'), { code: 'INVALID_ARGUMENTS' }); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw Object.assign(new Error('Invalid request'), { code: 'INVALID_ARGUMENTS' });
    if (request.protocol_version !== 1) throw Object.assign(new Error('Unsupported helper protocol'), { code: 'INVALID_ARGUMENTS' });
    if (request.action === 'capabilities') {
      if (Object.keys(request).some((key) => key !== 'protocol_version' && key !== 'action')) {
        throw Object.assign(new Error('Invalid capabilities request'), { code: 'INVALID_ARGUMENTS' });
      }
      const policy = await this.dependencies.loadPolicy(this.policyFile);
      return { protocol_version: 1, policy_valid: true, restart_services: policy.restartServices };
    }
    if (request.action !== 'restart_service') throw Object.assign(new Error('Unsupported action'), { code: 'INVALID_ARGUMENTS' });
    const restart = validateRestartRequest(request);
    const policy = await this.dependencies.loadPolicy(this.policyFile);
    if (!policy.restartServices.includes(restart.unit)) throw Object.assign(new Error('Service is not locally allowlisted'), { code: 'PERMISSION_DENIED' });
    const hash = requestHash(restart); const prior = await this.dependencies.ledger.get(restart.operation_id);
    if (prior) {
      if (prior.request_hash !== hash) throw Object.assign(new Error('Operation ID was already used with different arguments'), { code: 'PRECONDITION_FAILED' });
      if (prior.receipt.outcome === 'unknown' && !prior.receipt.completed_at) return prior.receipt;
      return prior.receipt;
    }
    if (this.busy) throw Object.assign(new Error('Another restart is in progress'), { code: 'TOOL_BUSY', outcome: 'not_started' });
    this.busy = true;
    const startedAt = new Date().toISOString();
    let mutationMayHaveStarted = false;
    try {
      const beforeDetail = await this.dependencies.systemd.get(restart.unit); const before = state(beforeDetail);
      if (before.active_state !== restart.expected_active_state || before.sub_state !== restart.expected_sub_state
        || (restart.expected_invocation_id && before.invocation_id !== restart.expected_invocation_id)) throw Object.assign(new Error('Service state changed before restart'), { code: 'PRECONDITION_FAILED' });
      const inProgress: RestartReceipt = { operation_id: restart.operation_id, unit: restart.unit, outcome: 'unknown', before, after: null, started_at: startedAt, completed_at: null, systemd_job_result: null };
      await this.dependencies.ledger.put({ request_hash: hash, request: restart, receipt: inProgress, updated_at: startedAt });
      mutationMayHaveStarted = true;
      let jobResult = 'done';
      try { await this.dependencies.restart(restart.unit); }
      catch (error) {
        jobResult = error instanceof Error && 'toolCode' in error && error.toolCode === 'TOOL_TIMEOUT' ? 'timeout' : 'failed';
        this.logger.error({ unit: restart.unit, jobResult }, 'systemd restart command failed');
      }
      let after = null; try { after = state(await this.dependencies.systemd.get(restart.unit)); } catch { /* retain unknown below */ }
      const changed = after && after.active_state === 'active' && after.invocation_id !== before.invocation_id;
      const outcome: RestartReceipt['outcome'] = !after || jobResult === 'timeout' ? 'unknown' : jobResult === 'done' && changed ? 'success' : 'failed';
      const receipt: RestartReceipt = { ...inProgress, outcome, after, completed_at: new Date().toISOString(), systemd_job_result: jobResult };
      await this.dependencies.ledger.put({ request_hash: hash, request: restart, receipt, updated_at: receipt.completed_at! });
      await this.dependencies.ledger.prune();
      return receipt;
    } catch (error) {
      if (!mutationMayHaveStarted) throw error;
      const value = error instanceof Error ? error : new Error('Action failed after the host boundary');
      throw Object.assign(value, { code: 'HOST_UNAVAILABLE', outcome: 'unknown' });
    } finally { this.busy = false; }
  }

  private reply(socket: net.Socket, ok: boolean, result?: unknown, error?: unknown): void { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok, ...(ok ? { result } : { error }) })}\n`); }
}
