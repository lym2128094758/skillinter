import { readFileSync } from 'node:fs';

// JSON is a YAML 1.2 subset and keeps this local application dependency-free.
export const config = JSON.parse(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8'));
for (const key of ['maxSeconds', 'maxToolCalls', 'maxConcurrent', 'maxInputTokens', 'maxOutputTokens',
  'contextTokens', 'historyTokens', 'toolResultBytes', 'imageTokens']) {
  if (!Number.isSafeInteger(config.runBudget?.[key]) || config.runBudget[key] < 1) throw new Error('Invalid root run budget: ' + key);
}
if (config.runBudget.toolResultBytes < 512 || config.runBudget.historyTokens >= config.runBudget.contextTokens ||
    config.runBudget.maxSeconds > 86400) throw new Error('Invalid root run budget bounds');
for (const key of ['maxModelCalls', 'maxToolCalls', 'maxReplans', 'maxSeconds', 'maxInputTokens', 'maxOutputTokens', 'maxRows',
  'maxIssues', 'maxTokensPerPlan', 'internS2MaxSeconds', 'sampleRows', 'sampleChars']) {
  if (!Number.isInteger(config.audit[key]) || config.audit[key] < 1) throw new Error(`Invalid audit configuration: ${key}`);
}
for (const key of ['depth', 'entries', 'visited', 'fileBytes', 'lines', 'characters', 'timeoutMs']) {
  if (!Number.isInteger(config.tools[key]) || config.tools[key] < 1) throw new Error('Invalid tool configuration: ' + key);
}
if (config.tools.depth < 3 || config.tools.lines < 100) throw new Error('Tool limits must support documented defaults');
if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.statePath !== 'string') throw new Error('Invalid local server configuration');
for (const key of ['inputPricePerMillion', 'outputPricePerMillion']) {
  if (config.audit[key] !== null && (typeof config.audit[key] !== 'number' || config.audit[key] < 0)) throw new Error(`Invalid price configuration: ${key}`);
}
