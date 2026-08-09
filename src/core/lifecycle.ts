import type WebSocket from 'ws';
import type { ActionClient } from '../actions/types.js';
import type { HostAdapter } from '../adapters/types.js';
import type { AgentConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { JsonRpcRequestSchema, JsonRpcResponseSchema, createErrorResponse, createNotification, createRequest, RPC_ERRORS } from '../mcp/protocol.js';
import type { McpRouter } from '../mcp/router.js';
import type { Observability } from '../observability.js';
import { toolRegistry } from '../tools/registry.js';
import { WebSocketClient } from '../transport/websocket-client.js';
import { SnapshotManager } from './snapshot-manager.js';

const HANDSHAKE_ID = 'agentv-handshake-v2';

function text(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Authenticate each connection generation before exposing AgentV functionality. */
export class LifecycleManager {
  private readonly transport: WebSocketClient;
  private readonly snapshots: SnapshotManager;
  private running = false;
  private ready = false;
  private generation = 0;
  private handshakeDeadline: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private helperReady = false;

  constructor(
    private readonly config: AgentConfig, private readonly host: HostAdapter, private readonly actions: ActionClient,
    private readonly router: McpRouter, private readonly logger: Logger, metrics: Observability,
    private readonly sessionState: { authenticated: () => void; disconnected: () => void } = {
      authenticated: () => undefined, disconnected: () => undefined
    },
  ) {
    this.transport = new WebSocketClient(config, logger, metrics);
    this.snapshots = new SnapshotManager(host, (payload) => this.ready && this.transport.send(payload), logger, metrics);
    this.transport.on('open', () => void this.open());
    this.transport.on('message', (data) => void this.message(data));
    this.transport.on('close', () => this.closed());
    this.transport.on('error', (error) => this.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'WebSocket error'));
  }

  start(): void { if (this.running) return; this.running = true; this.generation++; this.clearSession(); this.transport.connect(); }
  stop(): void { this.running = false; this.generation++; this.clearSession(); this.transport.close(); }

  private async open(): Promise<void> {
    if (!this.running) return;
    this.generation++; this.clearSession(); this.helperReady = false;
    const generation = this.generation;
    let helperServices: string[] = [];
    let helperReady = false;
    if (this.config.writeEnabled) {
      try {
        const capabilities = await this.actions.capabilities();
        helperReady = capabilities.protocol_version === 1 && capabilities.policy_valid && capabilities.restart_services.length > 0;
        helperServices = helperReady ? capabilities.restart_services : [];
      } catch { this.logger.warn({}, 'Privileged action helper is unavailable; write capability remains disabled'); }
    }
    if (!this.running || generation !== this.generation || !this.transport.isOpen()) return;
    this.helperReady = helperReady;
    const supportedCapabilities = ['read', 'mcp', 'systemd', 'linux'];
    if (this.config.allowedLogUnits.length > 0) supportedCapabilities.push('logs');
    if (this.helperReady) supportedCapabilities.push('write', 'restart_service');
    const advertisedTools = toolRegistry.getAll()
      .filter((tool) => tool.capability === 'read' || this.helperReady)
      .map((tool) => ({ name: tool.name, capability: tool.capability }));
    const handshake = createRequest('lifecycle/handshake', {
      targetId: this.config.targetId, targetType: 'virtual_machine', agentType: 'agentv',
      supportedCapabilities, advertisedTools,
      hostFeatures: { osFamily: 'linux', serviceManager: 'systemd', helperReachable: this.helperReady, restartServices: helperServices },
    }, HANDSHAKE_ID);
    if (!this.transport.send(JSON.stringify(handshake))) { this.transport.forceReconnect(); return; }
    this.handshakeDeadline = setTimeout(() => { this.logger.warn({}, 'Handshake deadline exceeded'); this.transport.forceReconnect(); }, 10_000);
    this.handshakeDeadline.unref();
  }

  private async message(data: WebSocket.RawData): Promise<void> {
    if (!this.running) return;
    let parsed: unknown; try { parsed = JSON.parse(text(data)); } catch { this.logger.warn({}, 'Rejecting malformed JSON'); this.transport.forceReconnect(); return; }
    if (!this.ready) {
      const response = JsonRpcResponseSchema.safeParse(parsed);
      if (!response.success || response.data.id !== HANDSHAKE_ID) { this.logger.warn({}, 'Rejecting non-handshake payload before readiness'); this.transport.forceReconnect(); return; }
      this.acceptHandshake(response.data); return;
    }
    const request = JsonRpcRequestSchema.safeParse(parsed);
    if (!request.success) {
      if (!this.transport.send(JSON.stringify(createErrorResponse(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request')))) this.transport.forceReconnect();
      return;
    }
    const generation = this.generation;
    const response = await this.router.handleRequest(request.data);
    if (!this.ready || generation !== this.generation) return;
    if (!this.transport.send(JSON.stringify(response))) { this.logger.warn({}, 'RPC response could not be delivered within outbound buffer ceiling'); this.transport.forceReconnect(); }
  }

  private acceptHandshake(response: { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: unknown }): void {
    if (response.error || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) { this.transport.forceReconnect(); return; }
    const result = response.result as Record<string, any>; const policy = result.sessionPolicy;
    const remote = result.config;
    const validPolicy = policy && typeof policy === 'object' && !Array.isArray(policy) && Array.isArray(policy.allowedTools)
      && policy.allowedTools.length <= 64 && policy.allowedTools.every((name: unknown) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(name))
      && new Set(policy.allowedTools).size === policy.allowedTools.length && typeof policy.writeEnabled === 'boolean';
    const validRemote = remote === undefined || (remote && typeof remote === 'object' && !Array.isArray(remote)
      && (remote.snapshotInterval === undefined || Number.isInteger(remote.snapshotInterval))
      && (remote.maxSnapshotBytes === undefined || Number.isInteger(remote.maxSnapshotBytes)));
    const intervalMs = remote?.snapshotInterval === undefined ? this.config.snapshotIntervalMs : remote.snapshotInterval * 1000;
    const maxBytes = remote?.maxSnapshotBytes === undefined ? this.config.maxSnapshotBytes : remote.maxSnapshotBytes;
    if (response.jsonrpc !== '2.0' || result.targetId !== this.config.targetId || result.targetType !== 'virtual_machine' || typeof result.workspaceId !== 'string' || !result.workspaceId.trim()
      || !validPolicy || !validRemote || !Number.isInteger(intervalMs) || intervalMs < this.config.minSnapshotIntervalMs || intervalMs > this.config.maxSnapshotIntervalMs
      || !Number.isInteger(maxBytes) || maxBytes < this.config.minSnapshotBytes || maxBytes > this.config.maxRemoteSnapshotBytes) {
      this.logger.warn({}, 'Handshake response contract rejected'); this.transport.forceReconnect(); return;
    }
    if (this.handshakeDeadline) clearTimeout(this.handshakeDeadline); this.handshakeDeadline = null;
    if (result.provisional === true) {
      this.logger.info({}, 'AgentV installation credential verified; waiting for activation');
      setTimeout(() => this.transport.forceReconnect(), 1_000).unref();
      return;
    }
    const compiled = new Set(toolRegistry.getAll().map((tool) => tool.name));
    const allowed = new Set<string>(policy.allowedTools.filter((name: string) => compiled.has(name)));
    if (this.config.allowedLogUnits.length === 0) allowed.delete('query_logs');
    if (!this.config.writeEnabled || !this.helperReady || !policy.writeEnabled) allowed.delete('restart_service');
    this.router.setSessionPolicy({ allowedTools: allowed, writeEnabled: Boolean(policy.writeEnabled && this.helperReady && this.config.writeEnabled), generation: this.generation, targetId: this.config.targetId });
    this.ready = true; this.transport.markReady(); this.snapshots.start(intervalMs, maxBytes); this.startHeartbeat();
    this.sessionState.authenticated();
    this.logger.info({ workspaceId: result.workspaceId, allowedTools: [...allowed], writeEnabled: policy.writeEnabled && this.helperReady && this.config.writeEnabled }, 'Authenticated AgentV session ready');
  }

  private closed(): void { if (!this.running) return; this.generation++; this.clearSession(); }
  private clearSession(): void {
    this.ready = false; this.router.clearSessionPolicy(); this.snapshots?.stop();
    this.sessionState.disconnected();
    if (this.handshakeDeadline) clearTimeout(this.handshakeDeadline); this.handshakeDeadline = null;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
  }
  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const generation = this.generation;
    this.heartbeat = setInterval(() => {
      if (this.ready && generation === this.generation && !this.transport.send(JSON.stringify(createNotification('lifecycle/heartbeat', { timestamp: new Date().toISOString() })))) this.transport.forceReconnect();
    }, 30_000); this.heartbeat.unref();
  }
}
