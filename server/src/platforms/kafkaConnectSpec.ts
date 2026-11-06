import { spec } from './gitSpecs.js';

/**
 * The read endpoints of the Kafka Connect REST API that Steward uses (0.9.0, #223), attached to platforms made from the
 * preset so process steps and MCP clients can look them up. Changing endpoints (POST, PUT, PATCH, DELETE: create,
 * restart, pause, resume, stop, delete) are left out and refused for the kind whatever asks (platforms/deniedPaths.ts);
 * every answer has its secret-looking configuration values removed. Reference:
 * https://kafka.apache.org/documentation/#connect_rest
 */
export const kafkaConnectSpec = () =>
  spec('Kafka Connect REST API (read endpoints, Steward subset)', 'https://kafka.apache.org/documentation/#connect_rest', [
    ['/', 'getWorker', 'The worker: Kafka Connect version, commit and Kafka cluster id'],
    ['/connectors', 'listConnectors', 'Connector names; expand=status adds states, expand=info the type and the configuration (secrets removed)', ['expand']],
    ['/connectors/{name}', 'getConnector', 'A connector: type, tasks and configuration (secrets removed)'],
    ['/connectors/{name}/config', 'getConnectorConfig', 'The configuration of a connector (secrets removed)'],
    ['/connectors/{name}/status', 'getConnectorStatus', 'The state of a connector and its tasks, with the error trace of a failed one (trimmed)'],
    ['/connectors/{name}/tasks', 'listConnectorTasks', 'The tasks of a connector with their configuration (secrets removed)'],
    ['/connectors/{name}/tasks/{taskId}/status', 'getTaskStatus', 'The state of one task'],
    ['/connectors/{name}/topics', 'getConnectorTopics', 'The topics a connector has used (active topics)'],
    ['/connectors/{name}/offsets', 'getConnectorOffsets', 'The offsets of a connector (Kafka 3.6 and newer)'],
    ['/connector-plugins', 'listConnectorPlugins', 'Installed connector plugins with class, type and version', ['connectorsOnly']],
  ]);
