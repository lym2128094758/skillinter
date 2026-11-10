import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const [base, task, output] = process.argv.slice(2);
if (!base || !task || !output) throw Error('用法：node scripts/check-citation-ui.mjs <本机URL> <任务ID> <结果目录>');
const url = new URL(base);
assert.equal(url.hostname, '127.0.0.1');
const prefix = join(resolve(tmpdir()), 'sih-citation-ui-');
const scratch = await mkdtemp(prefix);
const chrome = process.env.SKILLINTER_CHROME || join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
let browser, socket, launchError, sequence = 0;
const pending = new Map();
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const result = await check().catch(() => null);
    if (result) return result;
    await sleep(100);
  }
  throw Error('等待引用核验界面超时');
}
async function command(method, params) {
  const id = ++sequence;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {pending.delete(id); reject(Error('浏览器指令超时'));}, 5000);
    pending.set(id, message => {pending.delete(id); clearTimeout(timer); resolve(message);});
    socket.send(JSON.stringify({id, method, params}));
  });
  if (reply.error || reply.result?.exceptionDetails) throw Error('浏览器指令失败');
  return reply.result;
}
async function evaluate(expression) {
  return (await command('Runtime.evaluate', {expression, returnByValue: true})).result.value;
}
try {
  browser = spawn(chrome, ['--headless', '--no-first-run', '--disable-extensions', '--window-size=1280,900',
    '--remote-debugging-port=0', '--user-data-dir=' + scratch, base], {stdio: 'ignore', windowsHide: true});
  browser.on('error', error => {launchError = error;});
  const port = await waitFor(async () => (await readFile(join(scratch, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim());
  const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json())
    .find(item => item.type === 'page'));
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.onmessage = ({data}) => {const message = JSON.parse(data); pending.get(message.id)?.(message);};
  await waitFor(() => evaluate("document.querySelector('#prompt') !== null"));
  await evaluate('localStorage.setItem("skillinter-task",' + JSON.stringify(task) + ');true');
  await command('Page.reload', {});
  const visible = await waitFor(() => evaluate(`(() => {
    const summary = [...document.querySelectorAll('.task-plan summary')].find(node => node.textContent.includes('引用原文核验'));
    if (!summary) return null;
    const panel = summary.parentElement;
    panel.open = true;
    return {title: summary.textContent, link: panel.querySelector('a')?.getAttribute('href'), text: panel.textContent};
  })()`));
  assert.match(visible.title, /通过/);
  const response = await fetch(new URL(visible.link, base));
  assert.ok(response.ok);
  const report = await response.json();
  assert.equal(report.status, 'passed');
  assert.equal(report.findings[0].evidence[0].line, 3);
  const screenshot = await command('Page.captureScreenshot', {format: 'png'});
  await writeFile(join(output, 'chat-citation.png'), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(output, 'chat-ui.json'), JSON.stringify({passed: true, task, ...visible}, null, 2) + '\n');
  console.log('聊天引用卡片和核验记录下载通过');
} finally {
  socket?.close();
  browser?.kill();
  if (scratch.startsWith(prefix)) await rm(scratch, {recursive: true, force: true, maxRetries: 4, retryDelay: 100}).catch(() => {});
}
