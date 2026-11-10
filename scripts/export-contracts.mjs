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

const docs = new URL('../docs/', import.meta.url);
await mkdir(docs, {recursive: true});
await writeFile(new URL('tool-registry.json', docs), JSON.stringify({
  generatedFrom: ['src/tools.mjs', 'src/chat-skills.mjs', 'src/skill-session.mjs', 'src/skill-applicability.mjs', 'src/skill-delivery.mjs', 'src/skill-execution.mjs', 'src/task-plan.mjs', 'src/project-tests.mjs', 'src/preflight.mjs', 'src/audit-tools.mjs', 'src/audit-planner.mjs', 'src/workflow.mjs', 'src/skill-registry.mjs', 'src/skill-intelligence.mjs', 'config.yaml'],
  skillRegistry:registryContract,
  skillIntelligence: skillIntelligenceContract,
  file: {version: CONTRACT_VERSION, tools: fileToolRegistry},
  conversation: {version: 1, tools: chatSkillRegistry, skillApplicability: {parameters: applicabilitySchema, result: applicabilityResultSchema},
    skillDelivery: {parameters: deliverySchema, result: deliveryResultSchema},
    skillExecution: {plan:executionPlanSchema,tools:executionTools,scope:'isolated-file-execution'}},
  audit: {version: 2, tools: auditTools, requestSchema, planSchema, reportSchema,
    plannerStages: {mapping: mappingDecisionSchema, steps: optionalDecisionSchema}},
}, null, 2) + '\n');
