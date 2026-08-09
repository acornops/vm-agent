import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const unit = 'acornops-smoke-worker.service';
const runtime = '/opt/acornops/agentv/current';
const { SocketActionClient } = await import(pathToFileURL(`${runtime}/dist/actions/client.js`).href);
const client = new SocketActionClient('/run/acornops-agentv/actions.sock');
const capabilities = await client.capabilities();
if (!capabilities.policy_valid || !capabilities.restart_services.includes(unit)) throw new Error('Smoke service is not allowlisted by the helper');

async function properties() {
  const { stdout } = await execFileAsync('/bin/systemctl', [
    'show', unit, '--no-pager', '--property=ActiveState', '--property=SubState', '--property=InvocationID',
  ]);
  return Object.fromEntries(stdout.trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

const before = await properties();
const operationId = randomBytes(12).toString('hex');
const request = {
  protocol_version: 1,
  action: 'restart_service',
  operation_id: operationId,
  unit,
  reason: 'Hosted CI verification of the allowlisted restart boundary',
  expected_active_state: before.ActiveState,
  expected_sub_state: before.SubState,
  expected_invocation_id: before.InvocationID,
};
const receipt = await client.restart(request);
if (receipt.outcome !== 'success' || receipt.before.invocation_id !== before.InvocationID
  || !receipt.after?.invocation_id || receipt.after.invocation_id === before.InvocationID) {
  throw new Error(`Unexpected restart receipt: ${JSON.stringify(receipt)}`);
}
const replay = await client.restart(request);
if (JSON.stringify(replay) !== JSON.stringify(receipt)) throw new Error('Idempotent restart replay returned a different receipt');
try {
  await client.restart({ ...request, reason: `${request.reason} with mismatched reuse` });
  throw new Error('Mismatched operation ID reuse was accepted');
} catch (error) {
  if (error?.toolCode !== 'PRECONDITION_FAILED' || error?.data?.outcome !== 'not_started') throw error;
}
process.stdout.write(`Allowlisted restart and idempotent replay passed for ${unit}.\n`);
