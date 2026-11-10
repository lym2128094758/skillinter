import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './src/store.mjs';
import { executeRun } from './src/runner.mjs';
import { updatePlan, currentPlan, taskPlanTool } from './src/task-plan.mjs';
import { validate } from './src/schema.mjs';

const call = (name, args) => ({id: name, type: 'function', function: {name, arguments: JSON.stringify(args)}});
const steps = [{id: 'read', title: '读取资料', status: 'in_progress', depends_on: []},
  {id: 'report', title: '整理结论', status: 'pending', depends_on: ['read']}];

test('main conversation updates a plan, associates real receipts, recovers versions, and leaves stopped work unfinished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sih-plan-'));
  const path = join(root, 'tasks.sqlite');
  let store = new Store(path);
  try {
    await writeFile(join(root, 'note.txt'), 'supported fact');
    const {id: task} = store.createTask();
    const {id: run} = store.begin(task, 'run', '核对资料并整理结论', {});
    const signal = new AbortController();
    let calls = 0;
    await executeRun({id: run, task, prompt: '核对资料并整理结论', store, workspace: root, signal: signal.signal, skillAccess: true,
      maxSteps: 5, model: {label: 'fixture', async invoke({tools}) {
        assert.ok(tools.some(tool => tool.function.name === 'update_plan'));
        calls++;
        if (calls === 1) return {tool_calls: [call('update_plan', {expected_revision: 0, explanation: '先读原文再总结', steps})]};
        if (calls === 2) return {tool_calls: [call('read_file', {path: 'note.txt'})]};
        if (calls === 3) return {tool_calls: [call('update_plan', {expected_revision: 1, explanation: '已取得原文',
          steps: steps.map(step => ({...step, status: 'completed'}))})]};
        return {content: '结论 supported fact'};
      }}});
    const record = store.task(task).runs[0];
    assert.equal(record.status, 'completed');
    assert.equal(record.plan.revision, 2);
    assert.equal(record.planReceipts.length, 1);
    assert.equal(record.planReceipts[0].planRevision, 1);
    assert.equal(record.planReceipts[0].name, 'read_file');
    assert.equal(record.planReceipts[0].ok, true);
    assert.equal(record.planReceipts[0].planStepTitle, '读取资料');
    const before = currentPlan(store, task);
    store.db.close(); store = new Store(path);
    assert.deepEqual(currentPlan(store, task), before);
    const {id: next} = store.begin(task, 'next', '继续核对', {});
    const cycle = [{...steps[0], depends_on: ['report']}, steps[1]];
    assert.equal(updatePlan(store, task, next, {expected_revision: 2, explanation: '', steps: cycle}, signal.signal).error.code, 'INVALID_ARGUMENT');
    assert.equal(updatePlan(store, task, next, {expected_revision: 2, explanation: '', steps: [steps[0], {...steps[1], status: 'completed'}]}, signal.signal).error.code, 'DEPENDENCY_INCOMPLETE');
    assert.equal(updatePlan(store, task, next, {expected_revision: 1, explanation: '', steps}, signal.signal).error.code, 'PLAN_CONFLICT');
    const updated = updatePlan(store, task, next, {expected_revision: 2, explanation: '新任务需要补充材料', steps}, signal.signal);
    assert.deepEqual(validate(taskPlanTool.returns, updated), []);
    store.finish(next, 'stopped');
    assert.equal(currentPlan(store, task).steps[0].status, 'in_progress');
    assert.equal(store.task(task).runs[1].status, 'stopped');
  } finally { store.db.close(); await rm(root, {recursive: true, force: true}); }
});
