import {spawn} from 'node:child_process';
import {join} from 'node:path';

export function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'});
    killer.on('error', () => child.kill());
    killer.on('exit', code => {if (code) child.kill();});
  } else {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
}

export async function runProcess(executable, args, {cwd, signal, input, timeoutMs = 60000, maxBytes = 128000, env: extra = {},onOutput} = {}) {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|home|userprofile|lang|lc_all)$/i.test(key)));
  const started = Date.now();
  const bound = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  return new Promise(resolve => {
    const child = spawn(executable, args, {cwd, env: {...env, ...extra}, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = {stdout: [], stderr: []};
    const sizes = {stdout: 0, stderr: 0};
    let truncated = false, done = false, rescue;
    for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
      onOutput?.(name,bytes.toString('utf8'));
      const remaining = Math.max(0, maxBytes - sizes[name]);
      if (bytes.length > remaining) truncated = true;
      if (remaining) chunks[name].push(bytes.subarray(0, remaining));
      sizes[name] += Math.min(remaining, bytes.length);
    });
    function finish(value) {
      if (done) return; done = true; clearTimeout(rescue); bound.removeEventListener('abort', stop);
      resolve({...value, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        truncated, aborted: bound.aborted, elapsedMs: Date.now() - started});
    }
    function stop() {
      stopProcessTree(child);
      rescue = setTimeout(() => {child.stdout.destroy();child.stderr.destroy();finish({exitCode: null});}, 1500);
    }
    child.on('error', () => finish({exitCode: null, unavailable: true}));
    child.on('close', exitCode => finish({exitCode}));
    child.stdin.on('error', () => {});
    bound.addEventListener('abort', stop, {once: true});
    child.stdin.end(input);
    if (bound.aborted) stop();
  });
}
