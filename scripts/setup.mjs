import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../src/config.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || major === 24 && minor < 9) throw new Error('需要 Node.js 24.9 或更新版本');
await mkdir(resolve(config.statePath), {recursive: true});
console.log(`Skillinter setup OK · ${process.version} · 无第三方依赖。npm run demo / npm start`);
