import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './src/server.mjs';
import { config } from './src/config.mjs';

const {values} = parseArgs({options: {port: {type: 'string', default: String(config.port)}, open: {type: 'boolean', default: false}}});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1 到 65535 之间的整数');
const url = `http://${config.host}:${port}/`;
function openBrowser() {
  if (!values.open || process.platform !== 'win32') return;
  const browser = spawn('explorer.exe', [url], {windowsHide: true, stdio: 'ignore'});
  browser.on('error', () => console.log(`请在浏览器打开 ${url}`));
}
// Reuse before opening the state database: a second launch must not recover an
// already-running service's tasks or start another server.
let existing = false;
try {
  const response = await fetch(url + 'api/health', {redirect: 'error', signal: AbortSignal.timeout(2000)});
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.ok !== true || !Number.isInteger(health.toolContractVersion) || !Number.isInteger(health.reportVersion)) {
    throw new Error('目标端口已被其他服务占用。');
  }
  existing = true;
} catch (error) {
  if (error.cause?.code !== 'ECONNREFUSED') {
    console.error(`无法确认端口 ${port} 的服务状态，请检查后再启动。`);
    process.exit(1);
  }
}
if (existing) {
  console.log(`Skillinter 已在运行，复用 ${url}`);
  openBrowser();
  process.exit(0);
}
const app = await createApp({
  state: resolve(fileURLToPath(new URL('.', import.meta.url)), config.statePath),
  env: process.env,
  userSkillsPath: resolve(homedir(), '.sih', 'skills'),
});
app.server.listen(port, config.host, () => {
  console.log(`Skillinter ${url}`);
  openBrowser();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
