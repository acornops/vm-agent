import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const basename = `agentv-${pkg.version}.tar.gz`;
const archive = path.join(root, 'release', basename);
const checksumFile = `${archive}.sha256`;
const bootstrap = path.join(root, 'release', 'install-agentv.sh');
const bootstrapChecksumFile = `${bootstrap}.sha256`;
const checksum = (await readFile(checksumFile, 'utf8')).trim();
const expectedChecksum = createHash('sha256').update(await readFile(archive)).digest('hex');
if (checksum !== `${expectedChecksum}  ${basename}`) throw new Error('Archive checksum must contain the exact SHA-256 and basename');
const bootstrapContents = await readFile(bootstrap, 'utf8');
const bootstrapChecksum = (await readFile(bootstrapChecksumFile, 'utf8')).trim();
const expectedBootstrapChecksum = createHash('sha256').update(bootstrapContents).digest('hex');
if (bootstrapChecksum !== `${expectedBootstrapChecksum}  install-agentv.sh`) throw new Error('Bootstrap checksum must contain the exact SHA-256 and basename');
if (!bootstrapContents.includes(`readonly AGENTV_RELEASE_VERSION="${pkg.version}"`)) throw new Error('Bootstrap must embed the exact package version');
if (bootstrapContents.includes('__AGENTV_RELEASE_VERSION__')) throw new Error('Bootstrap contains an unresolved release version placeholder');

const { stdout: listing } = await execFileAsync('tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024 });
const entries = listing.trim().split('\n');
const prefix = `agentv-${pkg.version}/`;
if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Archive contains an unsafe path');
for (const required of [
  `${prefix}runtime/dist/index.js`,
  `${prefix}runtime/dist/helper.js`,
  `${prefix}runtime/dist/doctor.js`,
  `${prefix}runtime/node_modules/ws/package.json`,
  `${prefix}runtime/node_modules/zod/package.json`,
  `${prefix}packaging/systemd/install.sh`,
  `${prefix}packaging/systemd/install-worker.sh`,
  `${prefix}packaging/systemd/uninstall.sh`,
  `${prefix}packaging/systemd/acornops-agentv.service`,
  `${prefix}packaging/systemd/acornops-agentv-actions.socket`,
  `${prefix}packaging/systemd/acornops-agentv-actions.service`,
  `${prefix}packaging/systemd/acornops-agentv-install-recover`,
  `${prefix}packaging/systemd/acornops-agentv-install-recovery.service`,
]) if (!entries.includes(required)) throw new Error(`Archive is missing ${required}`);
if (entries.some((entry) => entry.startsWith(`${prefix}runtime/dist/`) && (/\.spec\.|\.ts$|\/fixtures\//).test(entry))) {
  throw new Error('Runtime dist contains tests, fixtures, or TypeScript sources');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'agentv-package-smoke-'));
try {
  await execFileAsync('tar', ['-xzf', archive, '-C', directory]);
  const extracted = path.join(directory, prefix);
  const runtime = path.join(extracted, 'runtime');
  const installed = (await readdir(path.join(runtime, 'node_modules'))).filter((name) => !name.startsWith('.')).sort();
  if (JSON.stringify(installed) !== JSON.stringify(['ws', 'zod'])) throw new Error(`Unexpected production dependency directories: ${installed.join(', ')}`);
  await execFileAsync('npm', ['ls', '--omit=dev', '--json'], { cwd: runtime, maxBuffer: 1024 * 1024 });
  await execFileAsync(process.execPath, ['--input-type=module', '--eval',
    `await import(${JSON.stringify(new URL(`file://${path.join(runtime, 'dist/actions/client.js')}`).href)});`]);
  for (const executable of [
    'packaging/systemd/install.sh',
    'packaging/systemd/install-worker.sh',
    'packaging/systemd/uninstall.sh',
    'packaging/systemd/acornops-agentv-doctor',
    'packaging/systemd/acornops-agentv-install-recover',
  ]) {
    const mode = (await stat(path.join(extracted, executable))).mode;
    if ((mode & 0o111) === 0) throw new Error(`${executable} is not executable`);
  }
  const systemdInstaller = await readFile(path.join(extracted, 'packaging/systemd/install.sh'), 'utf8');
  const installWorker = await readFile(path.join(extracted, 'packaging/systemd/install-worker.sh'), 'utf8');
  const installRecovery = await readFile(path.join(extracted, 'packaging/systemd/acornops-agentv-install-recover'), 'utf8');
  if (!systemdInstaller.includes('diff -qr --no-dereference')) throw new Error('Systemd installer must verify an existing immutable release before reuse');
  if (!systemdInstaller.includes('[[ -L "${release_root}"')) throw new Error('Systemd installer must reject a symlinked immutable release directory');
  if (!installWorker.includes('mv -f /etc/acornops/.agentv.env.install /etc/acornops/agentv.env')) throw new Error('Bootstrap worker must install AgentV configuration with an atomic rename');
  if (!installWorker.includes('mv -f /etc/acornops/.agentv-actions.json.install /etc/acornops/agentv-actions.json')) throw new Error('Bootstrap worker must install the AgentV action policy with an atomic rename');
  if (!installRecovery.includes('candidate-actions.json') || !installRecovery.includes('previous-actions.json')) {
    throw new Error('Boot recovery must preserve candidate and previous AgentV action policies');
  }
  const releasePreflightOffset = installWorker.indexOf('AGENTV_INSTALL_VERIFY_ONLY=true');
  const enrollmentExchangeOffset = installWorker.indexOf('/api/v1/agentv/enrollments/exchange');
  if (releasePreflightOffset < 0 || enrollmentExchangeOffset < 0 || releasePreflightOffset > enrollmentExchangeOffset) {
    throw new Error('Bootstrap worker must validate an existing immutable release before enrollment exchange');
  }
  const rollbackSnapshotOffset = installWorker.indexOf('Persist the complete rollback snapshot');
  const activeMarkerOffset = installWorker.indexOf('ln -sfn "${transaction_dir}" "${transaction_root}/active"');
  if (rollbackSnapshotOffset < 0 || activeMarkerOffset < 0 || rollbackSnapshotOffset > activeMarkerOffset) {
    throw new Error('Bootstrap worker must persist rollback state before publishing the active transaction marker');
  }
  if (!installRecovery.includes('401|409)')) {
    throw new Error('Boot recovery must retain the committed candidate after either transaction expiry or closed rollback grace');
  }
  if (bootstrapContents.includes('--agent-key')) throw new Error('Bootstrap must not accept a durable AgentV key argument');
  if (((await stat(bootstrap)).mode & 0o111) === 0) throw new Error('release/install-agentv.sh is not executable');
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`Package smoke passed for ${basename}.\n`);
