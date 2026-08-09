import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, redact } from './config.js';

const names = Object.keys(process.env).filter((name) => name.startsWith('ACORNOPS_'));
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
function base(extra: Record<string, string> = {}) {
  for (const name of Object.keys(process.env).filter((value) => value.startsWith('ACORNOPS_'))) delete process.env[name];
  Object.assign(process.env, { ACORNOPS_AGENT_PLATFORM_URL: 'https://api.example.com', ACORNOPS_TARGET_ID: 'vm-1', ACORNOPS_AGENT_KEY: 'secret-key', ...extra });
}
afterEach(() => { for (const name of Object.keys(process.env).filter((value) => value.startsWith('ACORNOPS_'))) delete process.env[name]; Object.assign(process.env, original); });

describe('loadConfig', () => {
  it('loads secure, read-only production defaults from package metadata', () => {
    base(); const config = loadConfig();
    expect(config.connectorVersion).toBe('0.0.1-experimental.6');
    expect(config.writeEnabled).toBe(false);
    expect(config.mockActionsEnabled).toBe(false);
    expect(config.allowedLogUnits).toEqual([]);
    expect(config.snapshotIntervalMs).toBe(60_000);
  });
  it('rejects insecure transport unless explicitly enabled', () => {
    base({ ACORNOPS_AGENT_PLATFORM_URL: 'http://127.0.0.1:8080' }); expect(() => loadConfig()).toThrow('must use https://');
    process.env.ACORNOPS_AGENT_ALLOW_INSECURE_TRANSPORT = 'true'; expect(loadConfig().platformUrl).toContain('127.0.0.1');
  });
  it('enforces bounded local and remote snapshot policy', () => {
    base({ ACORNOPS_AGENT_SNAPSHOT_INTERVAL_MS: '9999' }); expect(() => loadConfig()).toThrow('between 10000 and 3600000');
    base({ ACORNOPS_AGENT_MAX_SNAPSHOT_BYTES: '1048577' }); expect(() => loadConfig()).toThrow('between 16384 and 1048576');
  });
  it('rejects duplicate log units and invalid booleans', () => {
    base({ ACORNOPS_VM_ALLOWED_LOG_UNITS: 'ssh.service,ssh.service' }); expect(() => loadConfig()).toThrow('duplicate');
    base({ ACORNOPS_VM_ALLOWED_LOG_UNITS: 'ssh.service,*' }); expect(() => loadConfig()).toThrow('exact .service');
    base({ ACORNOPS_AGENT_WRITE_ENABLED: 'sometimes' }); expect(() => loadConfig()).toThrow('boolean');
    base({ ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED: 'sometimes' }); expect(() => loadConfig()).toThrow('boolean');
  });
  it('permits mock restart actions only with an explicit mock write configuration', () => {
    base({ ACORNOPS_VM_COLLECTOR_MODE: 'mock', ACORNOPS_AGENT_WRITE_ENABLED: 'true', ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED: 'true' });
    expect(loadConfig().mockActionsEnabled).toBe(true);
    base({ ACORNOPS_VM_COLLECTOR_MODE: 'mock', ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED: 'true' });
    expect(() => loadConfig()).toThrow('ACORNOPS_AGENT_WRITE_ENABLED=true');
    base({ ACORNOPS_AGENT_MOCK_ACTIONS_ENABLED: 'true' });
    expect(() => loadConfig()).toThrow('requires mock collector mode');
  });
  it('rejects credential-bearing URLs and malformed local identifiers', () => {
    base({ ACORNOPS_AGENT_PLATFORM_URL: 'https://user:password@example.com' }); expect(() => loadConfig()).toThrow('must not contain credentials');
    base({ ACORNOPS_TARGET_ID: '../vm-1' }); expect(() => loadConfig()).toThrow('invalid format');
    base({ ACORNOPS_AGENT_ACTIONS_SOCKET: 'relative.sock' }); expect(() => loadConfig()).toThrow('absolute path');
    base({ ACORNOPS_AGENT_KEY: 'x'.repeat(4097) }); expect(() => loadConfig()).toThrow('4096');
  });
  it('rejects unsupported log levels', () => {
    base({ ACORNOPS_AGENT_LOG_LEVEL: 'verbose' }); expect(() => loadConfig()).toThrow('must be debug, info, warn, or error');
  });
  it('redacts credentials without exposing short values', () => {
    expect(redact('')).toBe('<redacted>'); expect(redact('short')).toBe('<redacted>'); expect(redact('agent-key-12345678')).toBe('agen...5678');
  });
});
