import { aiRoutes } from '../ai/routes.js';
import { aiSection } from '../ai/report-section.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** AI models: the AI step, gateways, budgets and the usage log. */
export default defineFeature({
  name: 'ai',
  module: 'ai',
  routes: [aiRoutes],
  jobs: [
    // reservations of calls that never got an answer, retention of the usage log, the "AI usage" dataset
    every5Minutes('ai-usage', 2 * MINUTE, async () => {
      const { env } = await import('../config.js');
      return import('../ai/dataset.js').then((m) => m.runAiUsageJob(env.SM_AI_USAGE_RETENTION_DAYS));
    }),
  ],
  reportSections: [aiSection],
  datasets: [
    // the usage of AI models (ai/dataset.ts): administrators and auditors, like the usage log
    { name: 'ai', owns: (id) => id.startsWith('ai:'), visible: () => capabilities(currentUser()).viewAudit },
  ],
});
