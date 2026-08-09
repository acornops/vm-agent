import { accessSync, constants, readFileSync, statSync } from 'node:fs';

const SERVICE_UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\.service$/;

export type CollectorMode = 'live' | 'mock';

export interface AgentConfig {
  platformUrl: string; targetId: string; agentKey: string; targetType: 'virtual_machine'; connectorVersion: string;
  snapshotIntervalMs: number; minSnapshotIntervalMs: number; maxSnapshotIntervalMs: number;
  maxSnapshotBytes: number; minSnapshotBytes: number; maxRemoteSnapshotBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error'; collectorMode: CollectorMode;
  allowedLogUnits: string[]; writeEnabled: boolean; mockActionsEnabled: boolean; helperSocketPath: string;
  allowInsecureTransport: boolean; additionalCaBundleFile?: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name]; if (!value) return fallback;
  if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function csvEnv(name: string): string[] {
  const values = (process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicate values`);
  if (name === 'ACORNOPS_VM_ALLOWED_LOG_UNITS' && values.some((value) => !SERVICE_UNIT.test(value))) {
    throw new Error(`${name} must contain only exact .service unit names`);
  }
  return values;
}

function logLevelEnv(): AgentConfig['logLevel'] {
  const value = env('ACORNOPS_AGENT_LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(value)) throw new Error('ACORNOPS_AGENT_LOG_LEVEL must be debug, info, warn, or error');
  return value as AgentConfig['logLevel'];
}

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || !packageJson.version) throw new Error('package.json version is invalid');
  return packageJson.version;
}

function platformUrl(allowInsecure: boolean): string {
  const raw = env('ACORNOPS_AGENT_PLATFORM_URL');
  let parsed: URL; try { parsed = new URL(raw); } catch { throw new Error('ACORNOPS_AGENT_PLATFORM_URL must be a valid URL'); }
  if (parsed.username || parsed.password) throw new Error('ACORNOPS_AGENT_PLATFORM_URL must not contain credentials');
  if (parsed.protocol === 'https:' || (allowInsecure && parsed.protocol === 'http:')) return raw;
  throw new Error('ACORNOPS_AGENT_PLATFORM_URL must use https:// unless insecure local transport is explicitly enabled');
}

/** Redact a credential for startup logs. */
export function redact(value: string): string { return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : '<redacted>'; }

/** Load the local policy and bounded runtime configuration. */
export function loadConfig(): AgentConfig {
  const allowInsecureTransport = boolEnv('ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT');
  const targetType = env('ACORNOPS_AGENT_TARGET_TYPE', 'virtual_machine');
  if (targetType !== 'virtual_machine') throw new Error('ACORNOPS_AGENT_TARGET_TYPE must be virtual_machine');
  if (env('ACORNOPS_VM_OS_FAMILY', 'linux') !== 'linux') throw new Error('Only Linux hosts are supported');
  if (env('ACORNOPS_VM_SERVICE_MANAGER', 'systemd') !== 'systemd') throw new Error('Only systemd hosts are supported');
  const collectorMode = env('ACORNOPS_VM_COLLECTOR_MODE', 'live');
  if (collectorMode !== 'live' && collectorMode !== 'mock') throw new Error('ACORNOPS_VM_COLLECTOR_MODE must be live or mock');
  const additionalCaBundleFile = process.env.ACORNOPS_AGENT_ADDITIONAL_CA_BUNDLE_FILE?.trim() || undefined;
  if (additionalCaBundleFile) {
    try {
      accessSync(additionalCaBundleFile, constants.R_OK);
      const info = statSync(additionalCaBundleFile);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid CA bundle');
    } catch { throw new Error('Additional CA bundle must be a readable file no larger than 1 MiB'); }
  }
  const minSnapshotIntervalMs = intEnv('ACORNOPS_AGENT_MIN_SNAPSHOT_INTERVAL_MS', 10_000, 5_000, 60_000);
  const maxSnapshotIntervalMs = intEnv('ACORNOPS_AGENT_MAX_SNAPSHOT_INTERVAL_MS', 3_600_000, minSnapshotIntervalMs, 86_400_000);
  const minSnapshotBytes = intEnv('ACORNOPS_AGENT_MIN_SNAPSHOT_BYTES', 16 * 1024, 4096, 1024 * 1024);
  const maxRemoteSnapshotBytes = intEnv('ACORNOPS_AGENT_MAX_REMOTE_SNAPSHOT_BYTES', 1024 * 1024, minSnapshotBytes, 10 * 1024 * 1024);
  const targetId = env('ACORNOPS_TARGET_ID');
  const agentKey = env('ACORNOPS_AGENT_KEY');
  const writeEnabled = boolEnv('ACORNOPS_AGENT_WRITE_ENABLED');
  const mockActionsEnabled = boolEnv('ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED');
  if (mockActionsEnabled && (collectorMode !== 'mock' || !writeEnabled)) {
    throw new Error('ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED requires mock collector mode and ACORNOPS_AGENT_WRITE_ENABLED=true');
  }
  const helperSocketPath = env('ACORNOPS_AGENT_ACTIONS_SOCKET', '/run/acornops-agentv/actions.sock');
  if (targetId.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(targetId)) throw new Error('ACORNOPS_TARGET_ID has an invalid format');
  if (agentKey.length > 4096) throw new Error('ACORNOPS_AGENT_KEY exceeds 4096 characters');
  if (!helperSocketPath.startsWith('/') || helperSocketPath.length > 4096) throw new Error('ACORNOPS_AGENT_ACTIONS_SOCKET must be an absolute path');
  return {
    platformUrl: platformUrl(allowInsecureTransport), targetId, agentKey, targetType, connectorVersion: packageVersion(),
    snapshotIntervalMs: intEnv('ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS', 60_000, minSnapshotIntervalMs, maxSnapshotIntervalMs), minSnapshotIntervalMs, maxSnapshotIntervalMs,
    maxSnapshotBytes: intEnv('ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES', 1024 * 1024, minSnapshotBytes, maxRemoteSnapshotBytes), minSnapshotBytes, maxRemoteSnapshotBytes,
    logLevel: logLevelEnv(), collectorMode,
    allowedLogUnits: csvEnv('ACORNOPS_VM_ALLOWED_LOG_UNITS'), writeEnabled, mockActionsEnabled,
    helperSocketPath,
    allowInsecureTransport, additionalCaBundleFile,
  };
}
