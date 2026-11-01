/** /api/v1 route for the Apache Ossie semantic model of the API. */
import YAML from 'yaml';
import { semanticModel, type OssieVersion } from '../../semantic/ossie.js';
import * as S from './schemas.js';
import { query, type Get } from './helpers.js';

export function semanticModelRoutes(get: Get): void {
  get(
    '/semantic-model',
    {
      operationId: 'getSemanticModel',
      tag: 'Semantic model',
      summary: 'Data model of this API as an Apache Ossie semantic model',
      description:
        'Datasets (the API resources), fields with types, relationships and metrics such as the run success rate or monitor availability, as an [Apache Ossie](https://github.com/apache/ossie) (formerly OSI) document. JSON or YAML (`Accept: application/yaml` or `format=yaml`). The model describes the schema, not data, and is the same for every token. See docs/SEMANTIC-MODEL.md.',
      query: S.SemanticModelQuery,
      response: {
        content: {
          'application/json': { schema: S.ossieDocumentSchema },
          'application/yaml': { schema: { type: 'string', description: 'The same document as YAML' } },
        },
      },
    },
    async (req, reply) => {
      const q = query<{ format?: 'json' | 'yaml'; version: OssieVersion }>(req);
      const accept = String(req.headers.accept ?? '');
      const yamlFirst = /yaml/i.test(accept) && (!/json/i.test(accept) || accept.search(/yaml/i) < accept.search(/json/i));
      const doc = semanticModel(q.version);
      if (q.format === 'yaml' || (!q.format && yamlFirst)) {
        return reply.type('application/yaml; charset=utf-8').send(YAML.stringify(doc, { lineWidth: 0 }));
      }
      return reply.type('application/json; charset=utf-8').send(JSON.stringify(doc));
    },
  );
}
