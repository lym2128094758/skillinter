import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { auditWorkflow, digest, reportFingerprint } from '../src/workflow.mjs';
import { cases, fixtureModel } from '../bench/cases.mjs';
import { recordedModel } from '../src/replay.mjs';
import { config } from '../src/config.mjs';
import { auditRuntime, skillRegistry } from '../src/audit-skills.mjs';

const [argument, caseId] = process.argv.slice(2);
const replayPath = argument === '--case' ? null : argument;
const replay = replayPath ? JSON.parse(await readFile(replayPath, 'utf8')) : null;
if (replay && (replay.version !== 4 || replay.runtime?.sha256 !== auditRuntime.sha256 || replay.skillRegistry?.sha256 !== skillRegistry.sha256)) {
  throw new Error('回放需要录制时固定的运行器与技能注册表版本，见 docs/skill-design.md。');
}
const test = cases.find(item => item.id === (caseId ?? '36-multiple-records'));
if (!test) throw new Error(`用例不存在：${caseId}`);
const text = replay?.source.text ?? test.text;
if (replay && digest(text) !== replay.source.sha256) throw new Error('回放源文件哈希不一致');
if (replay && !replay.offlineExecutable) throw new Error('此记录支持查看执行轨迹，无法原样重跑（引导、中止或运行错误）');
const result = await auditWorkflow({file: {id: replay?.source.id ?? '00000000-0000-0000-0000-000000000001',
  name: replay?.source.name ?? `${test.id}.csv`, bytes: Buffer.from(text), sha256: digest(text)},
  task: replay?.task ?? '00000000-0000-0000-0000-000000000002', goal: replay?.goal ?? test.goal,
  request: replay?.request ?? test.request, limits: replay?.limits ?? {...config.audit, ...test.limits}, compact: replay?.compact,
  model: replay ? recordedModel(replay) : fixtureModel(test)});
const output = resolve('.skillinter/demo');
if (replay && reportFingerprint(result.report) !== replay.reportHash) throw new Error('回放结果与录制不一致');
if (replay && digest(result.skillTrace) !== replay.skillTraceHash) throw new Error('回放计划或执行状态与录制不一致');
await mkdir(output, {recursive: true});
for (const artifact of result.artifacts) await writeFile(resolve(output, basename(artifact.name)), artifact.bytes);
console.log(replay ? '离线录制回放（不请求模型）' : '离线回归示例（人工计划夹具，不请求模型）');
console.log(result.summary); console.log(output);
if (!replay && result.report.status !== test.expected.status) process.exitCode = 1;
