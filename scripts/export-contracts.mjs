import { mkdir, writeFile } from 'node:fs/promises';
import { auditTools, requestSchema } from '../src/audit-tools.mjs';
import { CONTRACT_VERSION, fileToolRegistry } from '../src/tools.mjs';
import { planSchema, reportSchema } from '../src/workflow.mjs';
import { chatSkillRegistry } from '../src/chat-skills.mjs';
import { mappingDecisionSchema, optionalDecisionSchema } from '../src/audit-planner.mjs';
import { applicabilitySchema, applicabilityResultSchema } from '../src/skill-applicability.mjs';
import { deliverySchema, deliveryResultSchema } from '../src/skill-delivery.mjs';
import {executionPlanSchema,executionTools} from '../src/skill-execution.mjs';
import {registryContract} from '../src/skill-registry.mjs';
import {skillIntelligenceContract} from '../src/skill-intelligence.mjs';
import {workerTool} from '../src/readonly-workers.mjs';
import {findingsSchema} from '../src/citation-verifier.mjs';

const docs = new URL('../docs/', import.meta.url);
await mkdir(docs, {recursive: true});
await writeFile(new URL('tool-registry.json', docs), JSON.stringify({
  generatedFrom: ['src/github-access.mjs', 'src/git-skill-source.mjs', 'src/task-capabilities.mjs', 'src/document-tools.mjs', 'src/task-preparation.mjs', 'src/online-skills.mjs', 'src/python-tool.mjs', 'src/process-runtime.mjs', 'scripts/extract-document.py', 'src/tools.mjs', 'src/chat-skills.mjs', 'src/skill-session.mjs', 'src/skill-applicability.mjs', 'src/skill-delivery.mjs', 'src/citation-verifier.mjs', 'src/skill-execution.mjs', 'src/task-plan.mjs', 'src/project-tests.mjs', 'src/preflight.mjs', 'src/audit-tools.mjs', 'src/audit-planner.mjs', 'src/workflow.mjs', 'src/skill-registry.mjs', 'src/skill-intelligence.mjs', 'src/readonly-workers.mjs', 'config.yaml'],
  skillRegistry:registryContract,
  skillIntelligence: skillIntelligenceContract,
  file: {version: CONTRACT_VERSION, tools: fileToolRegistry},
  workers: [workerTool],
  conversation: {version: 1, tools: chatSkillRegistry, skillApplicability: {parameters: applicabilitySchema, result: applicabilityResultSchema},
    skillDelivery: {parameters: deliverySchema, result: deliveryResultSchema},
    citedFindings: findingsSchema,
    skillExecution: {plan:executionPlanSchema,tools:executionTools,scope:'isolated-file-execution'}},
  audit: {version: 2, tools: auditTools, requestSchema, planSchema, reportSchema,
    plannerStages: {mapping: mappingDecisionSchema, steps: optionalDecisionSchema}},
}, null, 2) + '\n');
