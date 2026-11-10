import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const evidence = new URL('docs/evidence/v4/', root);
const arms = [
  ['规范化精确匹配', 'rules-v4-final'],
  ['开发集适配词典', 'rules-dictionary-v4-final'],
  ['MiniMax-M3，两阶段规划', 'minimax-m3-v4-final'],
];
let reference;
async function score(name) {
  const data = JSON.parse(await readFile(new URL(name + '.json', evidence), 'utf8'));
  assert.equal(data.runs, 10);
  assert.equal(data.repeats, 1);
  assert.equal(data.results.length, 10);
  const fields = data.results.flatMap(row => row.fields);
  assert.equal(fields.length, 20);
  for (const field of fields) {
    assert.equal(field.outcome, field.predicted === field.gold ? 'correct' : field.predicted ? 'wrong' : 'missing');
  }
  for (const row of data.results) {
    assert.equal(row.taskCorrect, row.status === 'completed' && row.fields.every(field => field.outcome === 'correct') && row.issueCount === 0);
  }
  assert.equal(data.confusion.correct, fields.filter(field => field.outcome === 'correct').length);
  assert.equal(data.taskSuccess, data.results.filter(row => row.taskCorrect).length);
  const rows = data.results.map(row => [row.table, row.originalSha256, row.dataRowsHash, row.sourceRows]);
  reference ??= rows;
  assert.deepEqual(rows, reference, '各组必须使用相同数据行和来源快照');
  return `${data.confusion.correct}/20 | ${data.taskSuccess}/10`;
}
const lines = [];
for (const [label, original] of arms) {
  const variant = original.replace('-v4-final', '-headers-v4-final');
  lines.push(`| ${label} | ${await score(original)} | ${await score(variant)} |`);
}
const block = `<!-- scorecard:start -->
本表作为已饱和的公开表回归基线，用于核对流程不退化。每组 10 张公开表、20 个映射决策（n=20），每个字段错误改变 5 个百分点。中文表头由脚本改写，数据行指纹逐表一致，文件名匿名化。词典与模型在本批同分。

| 方法 | 原表头正确字段 | 原表头完整任务 | 中文表头正确字段 | 中文表头完整任务 |
| --- | ---: | ---: | ---: | ---: |
${lines.join('\n')}
<!-- scorecard:end -->`;
const path = new URL('README.md', root);
const readme = await readFile(path, 'utf8');
const pattern = /<!-- scorecard:start -->[\s\S]*?<!-- scorecard:end -->/;
assert.match(readme, pattern);
if (process.argv.includes('--write')) await writeFile(path, readme.replace(pattern, block.replaceAll('\n', readme.includes('\r\n') ? '\r\n' : '\n')));
else assert.equal(readme.match(pattern)[0].replaceAll('\r\n', '\n'), block, 'README 成绩与证据不一致，请运行 npm run check:scores -- --write');
console.log('成绩表与六组逐字段记录一致，配对数据行指纹一致。');
