import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { ActionClient } from './actions/types.js';
import { MockHostAdapter } from './adapters/mock.js';
import type { AgentConfig } from './config.js';
import { LifecycleManager } from './core/lifecycle.js';
import { createLogger } from './logger.js';
import { McpRouter } from './mcp/router.js';
import { Observability } from './observability.js';
import { ToolExecutor } from './tools/executor.js';
import { registerAllTools } from './tools/index.js';

const gunzipAsync = promisify(gunzip);
const servers: WebSocketServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
const actions: ActionClient = {
  async capabilities() { return { protocol_version: 1, policy_valid: false, restart_services: [] }; },
  async restart() { throw new Error('disabled'); },
};

function config(port: number): AgentConfig {
  return { platformUrl: `http://127.0.0.1:${port}`, targetId: 'vm-1', agentKey: 'test-key', targetType: 'virtual_machine', connectorVersion: '0.0.1-experimental.2', snapshotIntervalMs: 10_000, minSnapshotIntervalMs: 10_000, maxSnapshotIntervalMs: 3_600_000, maxSnapshotBytes: 65_536, minSnapshotBytes: 16_384, maxRemoteSnapshotBytes: 1_048_576, logLevel: 'error', collectorMode: 'mock', allowedLogUnits: [], writeEnabled: false, mockActionsEnabled: false, helperSocketPath: '/missing', allowInsecureTransport: true };
}

describe('AgentV WebSocket lifecycle', () => {
  it('gates tools and compressed bounded snapshots behind a validated handshake', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let firstMethod = '';
    const tools = new Promise<any>((resolve) => server.on('connection', (socket) => socket.on('message', async (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw.toString());
      if (message.method === 'lifecycle/handshake') {
        firstMethod = message.method;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { workspaceId: 'ws-1', targetId: 'vm-1', targetType: 'virtual_machine', sessionPolicy: { allowedTools: ['get_host_summary', 'restart_service'], writeEnabled: true }, config: { snapshotInterval: 10, maxSnapshotBytes: 65_536 } } }));
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }));
      } else if (message.id === 'list-1') resolve(message.result.tools);
    })));
    const snapshot = new Promise<any>((resolve) => server.on('connection', (socket) => socket.on('message', async (raw, binary) => {
      if (!binary) return;
      const payload = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : Buffer.from(raw);
      expect(payload.byteLength).toBeLessThanOrEqual(65_536);
      resolve(JSON.parse((await gunzipAsync(payload)).toString('utf8')));
    })));
    const host = new MockHostAdapter(); registerAllTools(host, actions);
    const router = new McpRouter(new ToolExecutor({ localWriteEnabled: () => false }), createLogger('error'));
    const lifecycle = new LifecycleManager(config(port), host, actions, router, createLogger('error'), new Observability());
    lifecycle.start();
    const [listed, notification] = await Promise.all([tools, snapshot]);
    lifecycle.stop();
    expect(firstMethod).toBe('lifecycle/handshake');
    expect(listed.map((tool: any) => tool.name)).toEqual(['get_host_summary']);
    expect(listed[0]).toHaveProperty('inputSchema'); expect(listed[0]).toHaveProperty('outputSchema');
    expect(notification.method).toBe('notify/snapshot');
    expect(notification.params.data.schema_version).toBe('acornops.agentv-snapshot.v2');
    expect(notification.params.data).not.toHaveProperty('logs');
  });

  it('revokes a connection that sends tool work before the authenticated handshake', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let toolResponseSeen = false;
    const challenged = new Promise<void>((resolve) => server.on('connection', (socket) => socket.on('message', (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw.toString());
      if (message.method === 'lifecycle/handshake') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'early-tool', method: 'tools/list', params: {} }));
        resolve();
      } else if (message.id === 'early-tool') toolResponseSeen = true;
    })));
    const host = new MockHostAdapter(); registerAllTools(host, actions);
    const lifecycle = new LifecycleManager(config(port), host, actions, new McpRouter(new ToolExecutor(), createLogger('error')), createLogger('error'), new Observability());
    lifecycle.start(); await challenged; await new Promise((resolve) => setTimeout(resolve, 100)); lifecycle.stop();
    expect(toolResponseSeen).toBe(false);
  });

  it('rejects a stale handshake ID without installing a session policy', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let postHandshakeTraffic = false;
    const challenged = new Promise<void>((resolve) => server.on('connection', (socket) => socket.on('message', (raw, binary) => {
      if (binary) { postHandshakeTraffic = true; return; }
      const message = JSON.parse(raw.toString());
      if (message.method === 'lifecycle/handshake') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'agentv-handshake-v1', result: { workspaceId: 'ws-1', targetId: 'vm-1', targetType: 'virtual_machine', sessionPolicy: { allowedTools: ['get_host_summary'], writeEnabled: false } } }));
        resolve();
      } else postHandshakeTraffic = true;
    })));
    const host = new MockHostAdapter(); registerAllTools(host, actions);
    const lifecycle = new LifecycleManager(config(port), host, actions, new McpRouter(new ToolExecutor(), createLogger('error')), createLogger('error'), new Observability());
    lifecycle.start(); await challenged; await new Promise((resolve) => setTimeout(resolve, 100)); lifecycle.stop();
    expect(postHandshakeTraffic).toBe(false);
  });

  it('revokes a disconnected generation and reauthenticates before resuming work', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let connections = 0;
    let capabilityChecks = 0;
    const advertisedToolNames: string[][] = [];
    const reconnectActions: ActionClient = {
      async capabilities() {
        capabilityChecks++;
        return {
          protocol_version: 1,
          policy_valid: capabilityChecks > 1,
          restart_services: capabilityChecks > 1 ? ['acornops-agentv.service'] : [],
        };
      },
      async restart() { throw new Error('not exercised'); },
    };
    const reauthenticated = new Promise<void>((resolve) => server.on('connection', (socket) => {
      connections++;
      const connection = connections;
      socket.on('message', (raw, binary) => {
        if (binary) return;
        const message = JSON.parse(raw.toString());
        if (message.method !== 'lifecycle/handshake') return;
        advertisedToolNames.push(message.params.advertisedTools.map((tool: { name: string }) => tool.name));
        socket.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: {
            workspaceId: 'ws-1', targetId: 'vm-1', targetType: 'virtual_machine',
            sessionPolicy: { allowedTools: ['get_host_summary'], writeEnabled: false },
          },
        }));
        if (connection === 1) setTimeout(() => socket.close(1012, 'restart smoke'), 20);
        else resolve();
      });
    }));
    const host = new MockHostAdapter(); registerAllTools(host, reconnectActions);
    const lifecycle = new LifecycleManager(
      { ...config(port), writeEnabled: true }, host, reconnectActions,
      new McpRouter(new ToolExecutor(), createLogger('error')),
      createLogger('error'), new Observability(),
    );
    lifecycle.start();
    await reauthenticated;
    lifecycle.stop();
    expect(connections).toBe(2);
    expect(advertisedToolNames[0]).not.toContain('restart_service');
    expect(advertisedToolNames[1]).toContain('restart_service');
  }, 4_000);
});
