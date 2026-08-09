import net from 'node:net';
import { z } from 'zod';
import { ToolExecutionError } from '../tools/errors.js';
import type { ToolErrorCode } from '../tools/errors.js';
import type { ActionClient, HelperCapabilities, RestartReceipt, RestartRequest } from './types.js';

interface HelperResponse { ok: boolean; result?: unknown; error?: { code?: string; message?: string; outcome?: string } }
const SERVICE_UNIT = /^(?:[A-Za-z0-9][A-Za-z0-9_.@:-]*).service$/;
const HELPER_ERROR_CODES = new Set<ToolErrorCode>([
  'INVALID_ARGUMENTS', 'TOOL_BUSY', 'TOOL_TIMEOUT', 'PRECONDITION_FAILED', 'PERMISSION_DENIED',
  'COMMAND_UNAVAILABLE', 'HOST_UNAVAILABLE', 'INTERNAL_ERROR',
]);
const helperCapabilitiesSchema = z.object({
  protocol_version: z.literal(1),
  policy_valid: z.boolean(),
  restart_services: z.array(z.string().min(9).max(263).regex(SERVICE_UNIT)).max(32),
}).strict();
const restartStateSchema = z.object({
  active_state: z.string().min(1).max(64),
  sub_state: z.string().min(1).max(64),
  invocation_id: z.string().max(128).nullable(),
}).strict();
const restartReceiptSchema = z.object({
  operation_id: z.string().regex(/^[a-f0-9]{24}$/),
  unit: z.string().min(9).max(263).regex(SERVICE_UNIT),
  outcome: z.enum(['success', 'failed', 'not_started', 'unknown']),
  before: restartStateSchema,
  after: restartStateSchema.nullable(),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
  systemd_job_result: z.string().max(128).nullable(),
}).strict();

function validateResult<T>(schema: z.ZodType<T>, value: unknown, outcome: 'not_started' | 'unknown'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ToolExecutionError('HOST_UNAVAILABLE', 'Action helper returned an invalid result', { outcome });
  return parsed.data;
}

/** Call the root-owned helper over one bounded newline-delimited JSON exchange. */
export class SocketActionClient implements ActionClient {
  constructor(readonly socketPath: string) {}
  async capabilities(signal?: AbortSignal): Promise<HelperCapabilities> {
    return validateResult(helperCapabilitiesSchema, await this.call({ protocol_version: 1, action: 'capabilities' }, false, signal), 'not_started');
  }
  async restart(request: RestartRequest, signal?: AbortSignal): Promise<RestartReceipt> {
    return validateResult(restartReceiptSchema, await this.call(request, true, signal), 'unknown');
  }

  private async call(request: unknown, mayMutate: boolean, signal?: AbortSignal): Promise<unknown> {
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload) > 32 * 1024) throw new ToolExecutionError('INVALID_ARGUMENTS', 'Helper request exceeds 32 KiB');
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let response = '';
      let settled = false;
      let requestSent = false;
      const outcome = () => mayMutate && requestSent ? 'unknown' : 'not_started';
      const abort = () => finish(new ToolExecutionError('TOOL_TIMEOUT', 'Action helper call was aborted', { outcome: outcome() }));
      const timer = setTimeout(() => finish(new ToolExecutionError('TOOL_TIMEOUT', 'Action helper timed out', { outcome: outcome() })), mayMutate ? 31_000 : 2_000);
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
        error ? reject(error) : resolve(value);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      socket.once('connect', () => { requestSent = true; socket.write(payload); });
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (Buffer.byteLength(response) > 32 * 1024) { finish(new ToolExecutionError('OUTPUT_TOO_LARGE', 'Action helper response exceeded 32 KiB', { outcome: outcome() })); return; }
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(response.slice(0, newline)) as HelperResponse;
          if (!parsed.ok) {
            const code = parsed.error?.code;
            const mapped: ToolErrorCode = typeof code === 'string' && HELPER_ERROR_CODES.has(code as ToolErrorCode) ? code as ToolErrorCode : 'INTERNAL_ERROR';
            const message = typeof parsed.error?.message === 'string' ? parsed.error.message : 'Action helper rejected the request';
            const errorOutcome = parsed.error?.outcome === 'unknown' ? 'unknown' : 'not_started';
            finish(new ToolExecutionError(mapped, message, { outcome: errorOutcome }));
          } else finish(undefined, parsed.result);
        } catch { finish(new ToolExecutionError('HOST_UNAVAILABLE', 'Action helper returned malformed JSON', { outcome: outcome() })); }
      });
      socket.once('error', (error: NodeJS.ErrnoException) => finish(new ToolExecutionError(error.code === 'EACCES' ? 'PERMISSION_DENIED' : 'HOST_UNAVAILABLE', 'Action helper is unavailable', { outcome: outcome() })));
      socket.once('end', () => { if (!response.includes('\n')) finish(new ToolExecutionError('HOST_UNAVAILABLE', 'Action helper closed without a response', { outcome: outcome() })); });
    });
  }
}
