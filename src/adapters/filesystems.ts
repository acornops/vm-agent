import { readFile } from 'node:fs/promises';
import { runCommand } from './command-runner.js';
import type { CollectorHealth, FilesystemSummary } from './types.js';

const PSEUDO = new Set(['autofs', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts', 'devtmpfs', 'fusectl', 'hugetlbfs', 'mqueue', 'proc', 'pstore', 'securityfs', 'sysfs', 'tracefs']);
type CommandRunner = typeof runCommand;
type MountInfoReader = (signal?: AbortSignal) => Promise<string>;

/** Parse GNU df POSIX-format output represented by the Debian and RHEL fixtures. */
export function parseFilesystemOutput(text: string): Map<string, { source: string; type: string; total: number; used: number; free: number; percent: number }> {
  const result = new Map<string, { source: string; type: string; total: number; used: number; free: number; percent: number }>();
  for (const line of text.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    const mount = fields.slice(6).join(' ').replace(/\\040/g, ' ');
    result.set(mount, { source: fields[0], type: fields[1], total: Number(fields[2]) || 0, used: Number(fields[3]) || 0, free: Number(fields[4]) || 0, percent: Number.parseFloat(fields[5]) || 0 });
  }
  return result;
}

/** Collect byte and inode filesystem capacity from fixed GNU df invocations. */
export class FilesystemAdapter {
  constructor(
    private readonly command: CommandRunner = runCommand,
    private readonly readMountInfo: MountInfoReader = (signal) => readFile('/proc/self/mountinfo', { encoding: 'utf8', signal }),
  ) {}

  async list(input: { mount?: string; include_pseudo: boolean; limit: number }, signal?: AbortSignal): Promise<{ items: FilesystemSummary[]; original_count: number; omitted_count: number; truncated: boolean; health: CollectorHealth }> {
    const started = Date.now();
    const [bytes, inodes, mounts] = await Promise.all([
      this.command('/bin/df', ['-P', '-T', '-B1'], { timeoutMs: 5000, maxBytes: 1024 * 1024, signal }),
      this.command('/bin/df', ['-P', '-T', '-i'], { timeoutMs: 5000, maxBytes: 1024 * 1024, signal }),
      this.readMountInfo(signal),
    ]);
    const inodeMap = parseFilesystemOutput(inodes.stdout);
    const readOnly = new Set(mounts.split('\n').flatMap((line) => {
      const fields = line.split(' '); const separator = fields.indexOf('-');
      return separator > 5 && fields[5].split(',').includes('ro') ? [fields[4].replace(/\\040/g, ' ')] : [];
    }));
    let items = [...parseFilesystemOutput(bytes.stdout)].map(([mount, value]) => ({
      filesystem: value.source, mount, type: value.type, total_bytes: value.total, used_bytes: value.used, free_bytes: value.free,
      used_percent: value.percent, inode_used_percent: inodeMap.get(mount)?.percent ?? null, read_only: readOnly.has(mount),
    }));
    if (!input.include_pseudo) items = items.filter((item) => !PSEUDO.has(item.type));
    if (input.mount) items = items.filter((item) => item.mount === input.mount);
    items.sort((a, b) => a.mount.localeCompare(b.mount));
    const original = items.length;
    return { items: items.slice(0, input.limit), original_count: original, omitted_count: Math.max(0, original - input.limit), truncated: original > input.limit, health: { collector: 'filesystems', status: 'ok', duration_ms: Date.now() - started } };
  }
}
