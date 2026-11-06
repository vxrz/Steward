import fs from 'node:fs';
import path from 'node:path';
import { webhookTriggerExampleSchema, type WebhookTriggerExample } from '@sm/shared';
import { config } from '../config.js';
import { logger } from '../log.js';
import { parseYaml } from '../yaml-safe.js';

/**
 * Example webhook triggers (examples/triggers/*.yaml, 0.9.0, #242): the input mapping of a sender's payload onto a
 * process template, a sample payload and how to set up the sender. They are not created on their own – the trigger
 * editor offers an example's mapping when the chosen process has its inputs, and the secret dialog shows the sender's
 * setup. A file that does not match the format is left out (and reported by `npm run validate`).
 */

const examplesDir = () => path.join(config.examplesDir, 'triggers');
const MAX_BYTES = 64 * 1024;

export function listTriggerExamples(): WebhookTriggerExample[] {
  const dir = examplesDir();
  if (!fs.existsSync(dir)) return [];
  const templates = path.join(config.examplesDir, 'processes');
  return fs
    .readdirSync(dir)
    .filter((f) => /^[\w.-]+\.ya?ml$/i.test(f))
    .sort()
    .flatMap((f) => {
      try {
        const e = webhookTriggerExampleSchema.parse(parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'), { maxBytes: MAX_BYTES }));
        const file = path.join(templates, `${e.process}.yaml`);
        let processName: string | null = null;
        if (fs.existsSync(file)) {
          const name = (parseYaml(fs.readFileSync(file, 'utf8'), { maxBytes: 1024 * 1024 }) as { name?: unknown }).name;
          processName = typeof name === 'string' ? name : null;
        }
        return [{ ...e, id: f.replace(/\.ya?ml$/i, ''), processName }];
      } catch (err) {
        logger.warn({ err: (err as Error).message, file: f }, 'example trigger not readable');
        return [];
      }
    });
}
