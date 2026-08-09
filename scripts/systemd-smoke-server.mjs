import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const marker = process.argv[2];
const releaseDirectory = process.argv[3];
const releaseVersion = process.argv[4];
if (!marker || !releaseDirectory || !releaseVersion) {
  throw new Error('Usage: systemd-smoke-server.mjs <marker-file> <release-directory> <release-version>');
}
const allowedTools = [
  'get_host_summary', 'list_filesystems', 'list_processes', 'get_process',
  'list_services', 'get_service', 'query_logs', 'list_listeners', 'restart_service',
];
const accessPolicy = { accessMode: 'read_write', restartServices: ['acornops-smoke-worker.service'] };
const enrollments = new Map([
  ['aev_90909090-9090-4090-8090-909090909090_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', { transactionId: '90909090-9090-4090-8090-909090909090', key: 'ak_agentv-systemd-smoke_invalidpolicykey0000000000000000', state: 'issued', accessPolicy: { accessMode: 'read_write', restartServices: [] } }],
  ['aev_00000000-0000-4000-8000-000000000000_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', { transactionId: '00000000-0000-4000-8000-000000000000', key: 'ak_agentv-systemd-smoke_failedinitialkey0000000000000000', state: 'issued' }],
  ['aev_11111111-1111-4111-8111-111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { transactionId: '11111111-1111-4111-8111-111111111111', key: 'ak_agentv-systemd-smoke_systemdsmokekey00000000000000000', state: 'issued' }],
  ['aev_22222222-2222-4222-8222-222222222222_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { transactionId: '22222222-2222-4222-8222-222222222222', key: 'ak_agentv-systemd-smoke_rotatedsystemdsmokekey0000000000', state: 'issued', accessPolicy: { accessMode: 'read_only', restartServices: [] } }],
  ['aev_33333333-3333-4333-8333-333333333333_ccccccccccccccccccccccccccccccccccccccccccc', { transactionId: '33333333-3333-4333-8333-333333333333', key: 'ak_agentv-systemd-smoke_pendingrecoverykey00000000000000', state: 'issued' }],
  ['aev_55555555-5555-4555-8555-555555555555_ddddddddddddddddddddddddddddddddddddddddddd', { transactionId: '55555555-5555-4555-8555-555555555555', key: 'ak_agentv-systemd-smoke_rotatedsystemdsmokekey0000000000', state: 'completed' }],
]);
let activeKey = null;
let activeConnected = false;
let closedRollbackAttempts = 0;
const transactionSecret = (id) => `avt_${id}_${id.replaceAll('-', '')}`;
const controlServer = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const send = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (pathname === '/api/v1/agentv/enrollments/exchange' && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const enrollment = enrollments.get(body.enrollmentToken);
      if (!enrollment || enrollment.state !== 'issued') return send(401, { error: { code: 'INVALID_ENROLLMENT' } });
      const purpose = activeKey ? 'replace' : 'initial';
      if (body.purpose !== purpose) return send(401, { error: { code: 'INVALID_ENROLLMENT' } });
      enrollment.state = 'exchanged';
      return send(200, {
        transactionId: enrollment.transactionId,
        transactionSecret: transactionSecret(enrollment.transactionId),
        agentKey: enrollment.key,
        purpose,
        accessPolicy: enrollment.accessPolicy || accessPolicy
      });
    }
    const match = /^\/api\/v1\/agentv\/installations\/([^/]+)\/(status|commit|rollback)$/.exec(pathname);
    const enrollment = match && [...enrollments.values()].find((item) => item.transactionId === match[1]);
    if (!enrollment || request.headers['x-agentv-transaction-secret'] !== transactionSecret(enrollment.transactionId)) return send(401, { error: { code: 'INVALID_TRANSACTION' } });
    if (match[2] === 'status') return send(200, { status: enrollment.state, credentialState: enrollment.state === 'completed' ? 'active' : 'pending', activeConnected });
    if (match[2] === 'commit') {
      if (enrollment.transactionId === '00000000-0000-4000-8000-000000000000') {
        return send(503, { error: { code: 'INJECTED_COMMIT_FAILURE' } });
      }
      activeKey = enrollment.key;
      activeConnected = false;
      enrollment.state = 'completed';
      return send(200, { status: 'completed' });
    }
    if (enrollment.transactionId === '55555555-5555-4555-8555-555555555555') {
      closedRollbackAttempts += 1;
      return closedRollbackAttempts === 1
        ? send(409, { error: { code: 'ROLLBACK_UNAVAILABLE' } })
        : send(401, { error: { code: 'INVALID_TRANSACTION' } });
    }
    enrollment.state = 'cancelled';
    return send(200, { status: 'cancelled' });
  });
});
const server = new WebSocketServer({ server: controlServer, maxPayload: 1024 * 1024 });
const releaseServer = createServer(async (request, response) => {
  const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const match = /^\/releases\/download\/v([0-9A-Za-z.+-]+)\/([^/]+)$/.exec(requestPath);
  const requestedVersion = match?.[1] || '';
  const assetName = match?.[2] || '';
  const releaseAssets = new Set([
    `agentv-${requestedVersion}.tar.gz`,
    `agentv-${requestedVersion}.tar.gz.sha256`,
    'install-agentv.sh',
    'install-agentv.sh.sha256',
  ]);
  if (!requestedVersion || !releaseAssets.has(assetName)) {
    response.writeHead(404).end('not found');
    return;
  }
  const filePath = path.join(releaseDirectory, `v${requestedVersion}`, assetName);
  try {
    const metadata = await stat(filePath);
    response.writeHead(200, { 'content-length': metadata.size, 'content-type': 'application/octet-stream' });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.on('connection', (socket, request) => {
  const authenticatedAgentKey = request.headers['x-agent-key'];
  const pending = [...enrollments.values()].find((item) => item.key === authenticatedAgentKey && item.state === 'exchanged');
  if (request.url !== '/api/v1/agent/connect' || (authenticatedAgentKey !== activeKey && !pending)) {
    socket.close(1008, 'invalid smoke credentials');
    return;
  }
  socket.on('message', async (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(raw.toString());
    if (message.method === 'lifecycle/handshake') {
      if (message.id !== 'agentv-handshake-v2' || message.params?.targetId !== 'agentv-systemd-smoke') {
        socket.close(1008, 'invalid handshake');
        return;
      }
      if (pending) {
        pending.state = 'verified';
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          workspaceId: 'systemd-smoke-workspace', targetId: 'agentv-systemd-smoke', targetType: 'virtual_machine',
          provisional: true, sessionPolicy: { allowedTools: [], writeEnabled: false }
        } }));
        return;
      }
      activeConnected = true;
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          workspaceId: 'systemd-smoke-workspace',
          targetId: 'agentv-systemd-smoke',
          targetType: 'virtual_machine',
          sessionPolicy: { allowedTools, writeEnabled: true },
          config: { snapshotInterval: 10, maxSnapshotBytes: 65_536 },
        },
      }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'smoke-tools', method: 'tools/list', params: {} }));
      return;
    }
    if (message.id === 'smoke-tools') {
      const names = message.result?.tools?.map((tool) => tool.name);
      if (!Array.isArray(names) || !names.includes('get_host_summary')) {
        throw new Error('Installed AgentV did not advertise expected read tools');
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'smoke-call', method: 'tools/call', params: { name: 'get_host_summary', arguments: {} } }));
      return;
    }
    if (message.id === 'smoke-call') {
      if (message.result?.isError || !Array.isArray(message.result?.content) || message.result?.structuredContent?.schemaVersion !== 'acornops.full-tool-result.v1') {
        throw new Error('Installed AgentV returned an invalid MCP result envelope');
      }
      await writeFile(marker, JSON.stringify({ ready: true, tools: allowedTools.length, agentKey: authenticatedAgentKey }), 'utf8');
    }
  });
});

controlServer.listen(18081, '127.0.0.1');
releaseServer.listen(18082, '127.0.0.1');
await Promise.all([
  new Promise((resolve) => controlServer.once('listening', resolve)),
  new Promise((resolve) => releaseServer.once('listening', resolve)),
]);
process.stdout.write('AgentV systemd smoke control plane and release server listening.\n');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => releaseServer.close(() => controlServer.close(() => process.exit(0))));
}
