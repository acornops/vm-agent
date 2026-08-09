import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bootstrap = path.join(root, 'release', 'install-agentv.sh');
const source = await readFile(bootstrap, 'utf8');
const workerSource = await readFile(path.join(root, 'packaging/systemd/install-worker.sh'), 'utf8');
const completeInstallerSource = `${source}\n${workerSource}`;

for (const required of [
  "--proto-redir '=https'",
  '--retry 3',
  'sha256sum',
  'tar -tzf',
  'tar -tvzf',
  '--no-same-owner --no-same-permissions',
  'acornops-agentv-doctor',
  'candidate-doctor.json',
  'systemctl enable acornops-agentv.service',
  'ACORNOPS_AGENT_WRITE_ENABLED=false',
]) assert.ok(completeInstallerSource.includes(required), `bootstrap is missing required behavior: ${required}`);
assert.ok(source.includes('exec bash'), 'bootstrap must replace the token-bearing process with a secret-free worker');
assert.ok(!workerSource.includes('--enrollment-token'), 'worker argv must not accept an enrollment token');

async function expectFailure(file, args, expected, secret, env = {}) {
  try {
    await execFileAsync(file, args, { env: { ...process.env, ...env } });
    assert.fail(`bootstrap unexpectedly accepted arguments: ${args.join(' ')}`);
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    assert.match(output, expected);
    if (secret) assert.ok(!output.includes(secret), 'bootstrap failure output exposed the AgentV key');
  }
}

const secret = 'aev_11111111-1111-4111-8111-111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
await expectFailure(bootstrap, [], /--release-base-url is required/);
await expectFailure(bootstrap, ['--unexpected', 'value'], /unknown argument/);
await expectFailure(bootstrap, [
  '--release-base-url', 'https://artifacts.example.test',
  '--platform-url', 'https://api.example.test',
  '--target-id', 'vm-1',
  '--enrollment-token', 'aev_111111111111-1111-4111-8111-111111111111_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
], /enrollment-token has an invalid format/);
await expectFailure(bootstrap, [
  '--release-base-url', 'http://artifacts.example.test',
  '--platform-url', 'https://api.example.test',
  '--target-id', 'vm-1',
  '--enrollment-token', secret,
], /release-base-url must be an HTTPS URL/, secret);
await expectFailure(bootstrap, [
  '--release-base-url', 'https://artifacts.example.test',
  '--platform-url', 'https://api.example.test?unsafe=true',
  '--target-id', 'vm-1',
  '--enrollment-token', secret,
], /platform-url must be an HTTPS URL/, secret);
await expectFailure(bootstrap, [
  '--release-base-url', 'https://artifacts.example.test',
  '--platform-url', 'https://api.example.test',
  '--target-id', '../unsafe',
  '--enrollment-token', secret,
], /target-id has an invalid format/, secret);
await expectFailure(bootstrap, [
  '--release-base-url', 'https://artifacts.example.test',
  '--platform-url', 'https://api.example.test\nINJECTED=true',
  '--target-id', 'vm-1',
  '--enrollment-token', secret,
], /configuration values must be single-line/, secret);
await expectFailure(bootstrap, [
  '--release-base-url', "https://artifacts.example.test/'unsafe'",
  '--platform-url', 'https://api.example.test',
  '--target-id', 'vm-1',
  '--enrollment-token', secret,
], /URLs must not contain quotes or backslashes/, secret);

const directory = await mkdtemp(path.join(os.tmpdir(), 'agentv-bootstrap-smoke-'));
try {
  const systemdDirectory = path.join(directory, 'systemd');
  const fakeBin = path.join(directory, 'bin');
  await mkdir(systemdDirectory);
  await mkdir(fakeBin);
  const sha256sum = path.join(fakeBin, 'sha256sum');
  await writeFile(sha256sum, `#!${process.execPath}\nconst fs=require('node:fs');const crypto=require('node:crypto');for(const file of process.argv.slice(2)){const digest=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');process.stdout.write(digest+'  '+file+'\\n');}\n`);
  await chmod(sha256sum, 0o755);

  async function makeHarness(name, nodeMajor, requiredCommands) {
    const fakeNode = path.join(directory, `node-${name}`);
    await writeFile(fakeNode, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${nodeMajor}.0.0; else echo ${nodeMajor}; fi\n`);
    await chmod(fakeNode, 0o755);
    const harness = path.join(directory, `install-${name}.sh`);
    const harnessSource = source
      .replace('[[ "$(id -u)" -eq 0 ]] || fail "run the generated command with sudo"', ':')
      .replace('[[ "$(uname -s)" == Linux ]] || fail "AgentV requires Linux"', ':')
      .replace('[[ -d /run/systemd/system ]] || fail "AgentV requires a host booted with systemd"', `[[ -d '${systemdDirectory}' ]]`)
      .replace(/for command_name in curl tar sha256sum[^;]+; do/, `for command_name in ${requiredCommands}; do`)
      .replace('[[ -x /usr/sbin/runuser ]] || fail "required command is missing: /usr/sbin/runuser"', ':')
      .replace('/run/lock/acornops-agentv-install.lock', path.join(directory, `install-${name}.lock`))
      .replace('flock -n 9 || fail "another AgentV installation is already running"', ':')
      .replaceAll('/usr/bin/node', fakeNode);
    await writeFile(harness, harnessSource);
    await chmod(harness, 0o755);
    return harness;
  }

  const baseArgs = (releaseBaseUrl) => [
    '--release-base-url', releaseBaseUrl,
    '--platform-url', 'http://127.0.0.1:18081',
    '--target-id', 'vm-1',
    '--enrollment-token', secret,
  ];
  const testEnv = {
    CI: 'true',
    AGENTV_BOOTSTRAP_ALLOW_INSECURE_TEST: 'true',
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
  };

  const missingToolHarness = await makeHarness('missing-tool', 22, 'agentv-required-test-command');
  await expectFailure(missingToolHarness, baseArgs('https://artifacts.example.test'), /required command is missing: agentv-required-test-command/, secret, testEnv);
  const oldNodeHarness = await makeHarness('old-node', 20, 'curl tar sha256sum');
  await expectFailure(oldNodeHarness, baseArgs('https://artifacts.example.test'), /Node\.js 22 or newer is required/, secret, testEnv);
  const downloadHarness = await makeHarness('download', 22, 'curl tar sha256sum');

  async function withAssetServer(assets, callback) {
    const server = createServer((request, response) => {
      const body = assets.get(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      if (body === undefined) return void response.writeHead(404).end('not found');
      response.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
      await callback(`http://127.0.0.1:${address.port}/releases/download`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  await withAssetServer(new Map(), async (releaseBaseUrl) => {
    await expectFailure(downloadHarness, baseArgs(releaseBaseUrl), /could not download the AgentV release archive/, secret, testEnv);
  });

  const archiveName = `agentv-${pkg.version}.tar.gz`;
  const assetPath = (name) => `/releases/download/v${pkg.version}/${name}`;
  const invalidArchive = Buffer.from('not the expected archive');
  await withAssetServer(new Map([
    [assetPath(archiveName), invalidArchive],
    [assetPath(`${archiveName}.sha256`), Buffer.from(`${'0'.repeat(64)}  ${archiveName}\n`)],
  ]), async (releaseBaseUrl) => {
    await expectFailure(downloadHarness, baseArgs(releaseBaseUrl), /checksum did not match/, secret, testEnv);
  });

  const unsafeRoot = path.join(directory, `agentv-${pkg.version}`);
  await mkdir(path.join(unsafeRoot, 'packaging', 'systemd'), { recursive: true });
  await writeFile(path.join(unsafeRoot, 'packaging', 'systemd', 'install.sh'), '#!/bin/sh\nexit 99\n');
  await symlink('/etc/passwd', path.join(unsafeRoot, 'unsafe-link'));
  const unsafeArchivePath = path.join(directory, archiveName);
  await execFileAsync('tar', ['-czf', unsafeArchivePath, '-C', directory, `agentv-${pkg.version}`]);
  const unsafeArchive = await readFile(unsafeArchivePath);
  const unsafeDigest = createHash('sha256').update(unsafeArchive).digest('hex');
  await withAssetServer(new Map([
    [assetPath(archiveName), unsafeArchive],
    [assetPath(`${archiveName}.sha256`), Buffer.from(`${unsafeDigest}  ${archiveName}\n`)],
  ]), async (releaseBaseUrl) => {
    await expectFailure(downloadHarness, baseArgs(releaseBaseUrl), /unsupported entry type/, secret, testEnv);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write('Bootstrap validation and failure-path smoke passed.\n');
