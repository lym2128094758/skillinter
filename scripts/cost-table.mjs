import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../src/config.mjs';

const dir = resolve('.skillinter/evaluation/public');
const benchmark = process.argv[2] ?? 'minimax-m3';
if (!/^[a-z0-9.-]{1,64}$/i.test(benchmark)) throw Error('无效的评测文件名');
const data = JSON.parse(await readFile(resolve(dir, benchmark + '.json'), 'utf8'));
const {currency, checkedOn, source, models} = config.pricing;
const price = models[data.requestedModel];
if (!price || data.results.some(row => row.reportedModels.some(label => label !== data.requestedModel))) {
  throw new Error('计费表和实际响应模型不匹配');
}
const rows = data.results.map(row => ({
  table: row.table, model: data.requestedModel, status: row.status, inputTokens: row.inputTokens, outputTokens: row.outputTokens, elapsedMs: row.elapsedMs,
  estimatedCost: row.inputTokens === null || row.outputTokens === null ? null :
    Number(((row.inputTokens * price.uncachedInputPerMillion + row.outputTokens * price.outputPerMillion) / 1e6).toFixed(8)),
  currency, remotePeakGpuBytes: null,
}));
const available = rows.filter(row => row.estimatedCost !== null);
const mean = available.length ? available.reduce((sum, row) => sum + row.estimatedCost, 0) / available.length : null;
const summary = {tariff: {price, currency, checkedOn, source}, basis: '按实测 usage 和未命中缓存单价估算；实际扣费查账户账单。',
  attempts: rows.length, completed: rows.filter(row => row.status === 'completed').length,
  estimatedMeanCost: mean, p50Ms: data.p50Ms, p95Ms: data.p95Ms, rows};
const header = Object.keys(rows[0]);
const output = benchmark === 'minimax-m3' ? 'cost' : benchmark + '-cost';
await mkdir(dir, {recursive: true});
await writeFile(resolve(dir, output + '.csv'), [header.join(','), ...rows.map(row => header.map(key => row[key] ?? '').join(','))].join('\n') + '\n');
await writeFile(resolve(dir, output + '.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({...summary, rows: undefined}, null, 2));
