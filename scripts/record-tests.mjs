import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sourceFingerprint, projectRoot } from './source-fingerprint.mjs';

const output = new URL('../docs/evidence/', import.meta.url);
await mkdir(output, {recursive: true});
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const [command, flag, ...files] = pkg.scripts.test.split(/\s+/);
if (command !== 'node' || flag !== '--test' || files.some(path => !path.endsWith('.test.mjs'))) throw new Error('Unsupported test command');
const startedAt = new Date().toISOString();
const source = await sourceFingerprint();
const args = ['--test', '--test-reporter=junit', ...files];
const child = spawn(process.execPath, args, {cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
const stdout = [], stderr = [];
child.stdout.on('data', chunk => stdout.push(chunk));
child.stderr.on('data', chunk => stderr.push(chunk));
const [exitCode] = await once(child, 'close');
const xml = Buffer.concat(stdout).toString('utf8');
await writeFile(new URL('test-run.junit.xml', output), xml);
const cases = (xml.match(/<testcase\b/g) ?? []).length;
const failures = (xml.match(/<failure\b/g) ?? []).length;
const skipped = (xml.match(/<skipped\b/g) ?? []).length;
const record = {startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  command: ['node', ...args], basedOnPackageScript: pkg.scripts.test, exitCode, passed: exitCode === 0 && failures === 0,
  counts: {testFiles: files.length, testCases: cases, failures, skipped, unit: 'node:test 测试用例，非 assert 断言次数'},
  junit: 'test-run.junit.xml', stderr: Buffer.concat(stderr).toString('utf8'), source};
await writeFile(new URL('test-run.json', output), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({passed: record.passed, ...record.counts, sourceSha256: source.sha256}));
process.exitCode = exitCode ?? 1;
