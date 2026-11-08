import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Kafka Connect platforms (#223): connectors, tasks, plugins – read-only. */
export default defineFeature({
  name: 'kafkaconnect',
  jobs: [
    // connectors, tasks and plugins every hour
    every5Minutes('kafka-connect', 15 * MINUTE, () => import('../kafkaconnect/service.js').then((m) => m.runKafkaConnectJob())),
  ],
});
