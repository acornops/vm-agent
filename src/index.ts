import { SocketActionClient } from './actions/client.js';
import { rmSync, writeFileSync } from 'node:fs';
import { LinuxHostAdapter } from './adapters/linux.js';
import { MockHostAdapter } from './adapters/mock.js';
import { loadConfig } from './config.js';
import { LifecycleManager } from './core/lifecycle.js';
import { runDoctor } from './doctor.js';
import { createLogger } from './logger.js';
import { McpRouter } from './mcp/router.js';
import { Observability } from './observability.js';
import { ToolExecutor } from './tools/executor.js';
import { registerAllTools } from './tools/index.js';
import { notifyReady, notifyWatchdog } from './systemd-notify.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const host = config.collectorMode === 'mock' ? new MockHostAdapter() : new LinuxHostAdapter(config.allowedLogUnits);
const actions = new SocketActionClient(config.helperSocketPath);

if (process.argv[2] === 'doctor') {
  const result = await runDoctor(config, host, actions);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} else {
  const metrics = new Observability();
  registerAllTools(host, actions);
  const executor = new ToolExecutor({ localWriteEnabled: () => config.writeEnabled, metrics });
  const router = new McpRouter(executor, logger);
  const authenticatedMarker = '/run/acornops-agentv/authenticated';
  const sessionState = process.env.NOTIFY_SOCKET ? {
    authenticated: () => {
      try { writeFileSync(authenticatedMarker, `${new Date().toISOString()}\n`, { mode: 0o600 }); }
      catch (error) { logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Could not record authenticated readiness'); }
    },
    disconnected: () => {
      try { rmSync(authenticatedMarker, { force: true }); }
      catch (error) { logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Could not clear authenticated readiness'); }
    }
  } : undefined;
  const lifecycle = new LifecycleManager(config, host, actions, router, logger, metrics, sessionState);
  logger.info({ targetId: config.targetId, targetType: config.targetType, collectorMode: config.collectorMode, connectorVersion: config.connectorVersion, writeEnabled: config.writeEnabled }, 'AgentV starting');
  lifecycle.start();
  if (process.env.NOTIFY_SOCKET && !await notifyReady()) logger.error({}, 'systemd readiness notification failed');
  const watchdogUsec = Number(process.env.WATCHDOG_USEC || 0);
  let watchdogInFlight = false;
  const sendWatchdog = (): void => {
    if (watchdogInFlight) return;
    watchdogInFlight = true;
    void notifyWatchdog().then((sent) => { if (!sent) logger.error({}, 'systemd watchdog notification failed'); })
      .finally(() => { watchdogInFlight = false; });
  };
  const watchdog = watchdogUsec > 0 ? setInterval(sendWatchdog, Math.max(1000, Math.floor(watchdogUsec / 2000))) : null;
  if (watchdog) sendWatchdog();
  watchdog?.unref();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    logger.info({ signal }, 'AgentV stopping'); if (watchdog) clearInterval(watchdog); lifecycle.stop(); setTimeout(() => process.exit(0), 250).unref();
  });
}
