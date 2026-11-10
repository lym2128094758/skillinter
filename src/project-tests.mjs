import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { projectDirectory, samePath, writableScope } from './file-scope.mjs';
import { object, string, validate } from './schema.mjs';
import { checkResult, failure, resultSchema, success } from './tool-contract.mjs';

const args = ['--test', '--test-reporter=tap'];
const command = 'node ' + args.join(' ');
const approvalMs = 120_000;
const timeoutMs = 120_000;
const outputLimit = 12_000;
const windows = process.platform === 'win32';
const errors = {
  INVALID_ARGUMENT: '项目测试不接受命令或路径参数。',
  TEST_NOT_ALLOWED: '项目测试需要绑定项目并开启写入权限。',
  PROJECT_UNAVAILABLE: '项目目录已变化或无法访问。',
  APPROVAL_DECLINED: '用户拒绝了本次项目测试。',
  APPROVAL_EXPIRED: '项目测试确认已过期。',
  APPROVAL_SUPERSEDED: '收到新的引导，已撤回待确认的项目测试。',
  ABORTED: '项目测试已停止。',
  TIMEOUT: '项目测试超过 120 秒，已停止。',
  TEST_START_FAILED: '项目测试进程无法启动。',
};

export const projectTestTool = {
  name: 'run_project_tests',
  description: `在当前项目目录运行 ${command}。根据运行设置自动同意或等待用户确认。根据实际 status、退出码和输出判断测试结果。`,
  parameters: object({}),
  returns: resultSchema(object({
    kind: {enum: ['project_tests']}, status: {enum: ['passed', 'failed', 'no_tests']},
    command: string, cwd: {type: 'string'}, exitCode: {anyOf: [{type: 'integer'}, {enum: [null]}]},
    tests: {anyOf: [{type: 'integer', minimum: 0}, {enum: [null]}]},
    summary: string, stdout: {type: 'string', maxLength: outputLimit}, stderr: {type: 'string', maxLength: outputLimit},
    truncated: {type: 'boolean'}, volatile: object({elapsedMs: {type: 'integer', minimum: 0}}),
  })),
  errors, timeoutMs, approvalTimeoutMs: approvalMs, idempotent: false,
  timeoutMode: '确认和执行分别计时。停止或执行超时时终止测试进程并记录已捕获的输出。',
  volatile: ['data.volatile.elapsedMs', 'data.stdout', 'data.stderr'],
  authorization: '绑定项目且具备写入权限。按运行设置自动同意或逐次确认。项目代码使用当前系统账号运行。',
  ordering: '标准输出和标准错误分别按进程写入顺序保留末尾，超限标记 truncated。',
};

export function canRunProjectTests(scope) {
  return Boolean(scope?.projectId && scope.projectPath && writableScope(scope.mode));
}

async function projectIdentity(scope) {
  const cwd = await projectDirectory(scope.projectPath, scope.state);
  if (!samePath(cwd, scope.projectPath)) throw new Error('Project moved');
  const {dev, ino} = await lstat(cwd, {bigint: true});
  return `${dev}:${ino}`;
}

export async function requestApproval({entry, signal, store, run, cwd, requestedCommand=command,
  executable=process.execPath, purpose='project_tests', waitMs=approvalMs}) {
  const id = randomUUID();
  const deadline = AbortSignal.timeout(waitMs);
  const approved = Promise.withResolvers();
  const stop = () => approved.resolve('aborted');
  const expire = () => approved.resolve('expired');
  const decide = decision => {
    if (signal.aborted || deadline.aborted || entry.testApproval?.id !== id) return false;
    entry.testApproval = null;
    approved.resolve(decision);
    return true;
  };
  entry.testApproval = {id, decide};
  signal.addEventListener('abort', stop, {once: true});
  deadline.addEventListener('abort', expire, {once: true});
  try {
    if (signal.aborted) return 'aborted';
    if (entry.autoApproveExecution === true) {
      if (store.hasGuidance(run)) return 'superseded';
      store.record(run, 'project_test_decision', {id, decision:'approve', automatic:true, command:requestedCommand, cwd, purpose});
      return 'approve';
    }
    store.record(run, 'project_test_request', {id, command:requestedCommand, executable, purpose, cwd, expires: Date.now() + waitMs});
    const decision = await approved.promise;
    store.record(run, 'project_test_decision', {id, decision});
    return decision;
  } finally {
    entry.testApproval = null;
    signal.removeEventListener('abort', stop);
    deadline.removeEventListener('abort', expire);
  }
}

function stopProcess(child) {
  if (!child.pid) return;
  if (windows) {
    const root = process.env.SystemRoot;
    if (root && isAbsolute(root)) {
      const kill = spawn(join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'});
      kill.once('error', () => child.kill());
      kill.once('exit', code => { if (code !== 0) child.kill(); });
    } else child.kill();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

function capture(stream) {
  const state = {text: '', truncated: false};
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const combined = state.text + chunk;
    state.truncated ||= combined.length > outputLimit;
    state.text = combined.slice(-outputLimit);
  });
  return state;
}

async function executeTests(cwd, signal, onInterrupted) {
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const cancelled = AbortSignal.any([signal, deadline]);
  // Project tests inherit a minimal environment and the user's OS access.
  const names = /^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|home|userprofile|lang|lc_all)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => names.test(key)));
  const child = spawn(process.execPath, args, {cwd, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const stdout = capture(child.stdout), stderr = capture(child.stderr);
  let killDeadline;
  const result = await new Promise(resolve => {
    const stop = () => {
      stopProcess(child);
      killDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({exitCode: null});
      }, 5000);
    };
    child.once('error', () => resolve({startFailed: true}));
    child.once('close', exitCode => resolve({exitCode}));
    cancelled.addEventListener('abort', stop, {once: true});
    child.once('close', () => cancelled.removeEventListener('abort', stop));
    if (cancelled.aborted) stop();
  });
  clearTimeout(killDeadline);
  const {exitCode} = result;
  const captured = {stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated,
    volatile: {elapsedMs: Math.round(performance.now() - started)}};
  if (signal.aborted || deadline.aborted) {
    const code = signal.aborted ? 'ABORTED' : 'TIMEOUT';
    onInterrupted({command, cwd, code, exitCode: exitCode ?? null, ...captured});
    return failure(errors, code);
  }
  if (result.startFailed) return failure(errors, 'TEST_START_FAILED');
  const totals = /^# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?$/m;
  const counts = totals.exec(stdout.text);
  const tests = counts ? Number(counts[1]) : null;
  const passed = counts ? Number(counts[2]) : 0;
  const status = result.exitCode !== 0 || !counts || Number(counts[3]) > 0 ? 'failed' : passed ? 'passed' : 'no_tests';
  const summary = status === 'passed' ? `项目测试通过（${passed}/${tests} 项通过，退出码 0）。` : status === 'no_tests' ? '没有实际通过的 Node.js 测试。' :
    result.exitCode === 0 ? '测试进程退出，但未返回可核验的测试结果。' : `项目测试失败（退出码 ${result.exitCode ?? '无'}）。`;
  return success({kind: 'project_tests', status, command, cwd, exitCode, tests, summary, ...captured});
}

export async function runProjectTests(call, {entry, scope, signal, store, run}) {
  const result = await (async () => {
    if (!entry || !canRunProjectTests(scope)) return failure(errors, 'TEST_NOT_ALLOWED');
    if (entry.testDeclined) return failure(errors, 'APPROVAL_DECLINED');
    let params;
    try { params = JSON.parse(call.function.arguments); } catch { return failure(errors, 'INVALID_ARGUMENT'); }
    if (validate(projectTestTool.parameters, params).length) return failure(errors, 'INVALID_ARGUMENT');
    let identity;
    try { identity = await projectIdentity(scope); } catch { return failure(errors, 'PROJECT_UNAVAILABLE'); }
    if (store.hasGuidance(run)) return failure(errors, 'APPROVAL_SUPERSEDED');
    const decision = await requestApproval({entry, signal, store, run, cwd: scope.projectPath});
    if (decision === 'decline') entry.testDeclined = true;
    const rejected = {decline: 'APPROVAL_DECLINED', expired: 'APPROVAL_EXPIRED', superseded: 'APPROVAL_SUPERSEDED', aborted: 'ABORTED'};
    if (decision !== 'approve') return failure(errors, rejected[decision]);
    try {
      if (identity !== await projectIdentity(scope)) return failure(errors, 'PROJECT_UNAVAILABLE');
    } catch { return failure(errors, 'PROJECT_UNAVAILABLE'); }
    if (signal.aborted) return failure(errors, 'ABORTED');
    if (store.hasGuidance(run)) return failure(errors, 'APPROVAL_SUPERSEDED');
    store.record(run, 'project_test_started', {command, cwd: scope.projectPath});
    return executeTests(scope.projectPath, signal, snapshot => store.record(run, 'project_test_interrupted', snapshot));
  })();
  return checkResult(projectTestTool, result);
}
