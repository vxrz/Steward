import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Kafka: topics of applications and topic prefixes. */
export default defineFeature({
  name: 'kafka',
  jobs: [
    every5Minutes('kafka', 30 * MINUTE, () => import('../kafka/service.js').then((m) => m.runKafkaJob())),
    // topic prefixes kept in sync (kafka/prefixes.ts)
    every5Minutes('kafka-topic-prefixes', 10 * MINUTE, () => import('../kafka/prefixes.js').then((m) => m.runTopicPrefixJob())),
  ],
});
