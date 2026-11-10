import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function sourceFingerprint() {
  const paths = ['package.json', 'package-lock.json', 'config.yaml', '.node-version', 'start.mjs', 'start.bat', 'docs/tool-registry.json'];
  for (const entry of await readdir(projectRoot)) if (entry.endsWith('.test.mjs')) paths.push(entry);
  async function walk(directory) {
    for (const entry of await readdir(new URL(directory + '/', new URL('../', import.meta.url)), {withFileTypes: true})) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  for (const directory of ['src', 'web', 'scripts', 'bench']) await walk(directory);
  const files = [];
  for (const path of paths.sort()) {
    const bytes = await readFile(new URL('../' + path, import.meta.url));
    files.push({path, bytes: bytes.length, sha256: sha256(bytes)});
  }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true}).trim(); }
  catch { /* A source export can be verified without Git metadata. */ }
  return {algorithm: 'SHA-256', sha256: sha256(JSON.stringify(files)), commit,
    commitAvailable: Boolean(commit), scope: 'src/, web/, scripts/, bench/、根目录测试、运行配置和导出的工具契约。其他文档、证据和私有状态不参与计算。', files};
}
