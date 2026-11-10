import { digest } from './workflow.mjs';

export function recordedModel(replay) {
  let index = 0;
  return {label: replay.model, kind: replay.modelKind, async invoke({messages, maxTokens}) {
    const recorded = replay.transcript[index++];
    if (!recorded || recorded.requestHash !== digest(messages) || recorded.maxTokens !== maxTokens) {
      throw new Error('回放输入与录制不一致，拒绝套用其他任务的响应');
    }
    return recorded.response;
  }};
}
