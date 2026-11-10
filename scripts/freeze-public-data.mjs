import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicSpec } from '../bench/public-spec.mjs';
import { parseCsv } from '../src/skills.mjs';
import { digest } from '../src/workflow.mjs';

const root = fileURLToPath(new URL('../bench/public-data/', import.meta.url));
await mkdir(root, {recursive: true});
const downloaded = new Map();
async function snapshot(url) {
  for (let retry = 0; ; retry++) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = await response.text();
      return {text, sourceSha256: digest(text), retrievedAt: new Date().toISOString()};
    } catch (error) { if (retry === 2) throw error; }
  }
}
const manifest = [];
for (const spec of publicSpec) {
  if (!downloaded.has(spec.download)) downloaded.set(spec.download, await snapshot(spec.download));
  const original = downloaded.get(spec.download);
  const {header, rows} = parseCsv(original.text);
  if (Object.values(spec.gold).some(column => !header.includes(column))) throw new Error('Ground truth is not a real header: ' + spec.id);
  const colorIndex = header.indexOf('color');
  const selected = spec.color ? rows.filter(row => row[colorIndex] === spec.color) : rows;
  if (!selected.length) throw new Error('Empty table: ' + spec.id);
  const text = spec.color ? [header, ...selected].map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\n') + '\n' : original.text;
  const name = spec.id + '.csv';
  await writeFile(join(root, name), text, 'utf8');
  manifest.push({...spec, name, rows: selected.length, sha256: digest(text),
    originalSha256: original.sourceSha256, retrievedAt: original.retrievedAt,
    transform: spec.color ? 'Filter the original CSV by color, then serialize its unchanged cells.' : 'Unmodified published CSV text.'});
  console.log(spec.id, selected.length);
}
await writeFile(join(root, 'manifest.json'), JSON.stringify({version: 1, license: 'CC BY 4.0', tables: manifest}, null, 2) + '\n');
