import { z } from 'zod';
import { pageArray } from '../api/v1/pagination.js';
import { moduleEnabled } from '../modules/registry.js';
import { ToolError, cursorArg, defineTool, limitArg, type ToolDef } from '../mcp/tooling.js';
import { HttpError } from '../util.js';
import { getContract, getVersion, lastRun, listContracts, toRunSummary, visibleContract } from './service.js';

/**
 * Data contracts for AI assistants (0.22.0, ADR 0036 part 14, docs/MCP.md "Data contracts"): the contracts the token
 * owner may see and one contract with the ODCS YAML of a version, Steward's findings, the lint result and the last test.
 * As the token owner, through the services of the web app; not listed and refused while the module is off. A contract's
 * text is data written by people – never instructions.
 */

const OFF = 'The data contracts module is not enabled on this Steward (Settings → Modules)';
const YAML_CHARS = 60_000;

const visible = () => moduleEnabled('dataContracts');

function read<T>(f: () => T): T {
  if (!moduleEnabled('dataContracts')) throw new ToolError(OFF);
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500)
      throw new ToolError(e.statusCode === 404 || e.statusCode === 403 ? `${e.message} (or you may not see it)` : e.message);
    throw e;
  }
}

const has = (needle: string | undefined, ...values: string[]) => !needle || values.some((v) => v.toLowerCase().includes(needle.toLowerCase()));

export const dataContractTools: ToolDef[] = [
  defineTool({
    name: 'list_data_contracts',
    title: 'List data contracts',
    description:
      'Data contracts (ODCS v3) you may see, ordered by name: Steward id, ODCS id (key), status, ODCS version, Steward’s current version number, lint errors, the last test’s result and the number of findings. Use get_data_contract for the YAML.',
    input: z.object({ query: z.string().max(200).optional().describe('A text in the name or ODCS id'), cursor: cursorArg, limit: limitArg() }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const list = listContracts()
          .filter((c) => has(a.query, c.name, c.key))
          .map((c) => ({
            id: c.id,
            key: c.key,
            name: c.name,
            status: c.status,
            version: c.version,
            currentVersion: c.currentVersion,
            lintErrors: c.lintErrors,
            lastTest: c.lastRun,
            findings: c.findingCount,
            owningTeams: c.owningTeams.map((t) => t.name),
            updatedAt: c.updatedAt,
          }));
        return pageArray(list, (c) => [c.name.toLowerCase(), c.id], a, { query: a.query });
      }),
  }),
  defineTool({
    name: 'get_data_contract',
    title: 'Get a data contract',
    description:
      'One data contract: the ODCS YAML of a version (default: the current one), what Steward read from it (schema objects, servers, team), the lint result of that version, Steward’s findings (columns missing or extra against linked tables, not tested for long …) and the last test with its checks.',
    input: z
      .object({
        contractId: z.string().min(1).max(200).describe('Steward’s id of the contract (from list_data_contracts)'),
        version: z.number().int().min(1).optional().describe('Steward’s version number (default: the current one)'),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const c = getContract(a.contractId);
        const v = a.version && a.version !== c.currentVersion ? getVersion(a.contractId, a.version) : null;
        const yaml = v?.yaml ?? c.yaml;
        const run = lastRun(visibleContract(a.contractId).row.id, { realOnly: true });
        return {
          id: c.id,
          key: c.key,
          name: c.name,
          status: c.status,
          odcsVersion: c.version,
          currentVersion: c.currentVersion,
          version: v?.version ?? c.currentVersion,
          yaml: yaml.length > YAML_CHARS ? `${yaml.slice(0, YAML_CHARS)}\n# … ${yaml.length - YAML_CHARS} more characters` : yaml,
          facts: c.facts,
          lint: (v?.lint ?? c.lint).slice(0, 100),
          findings: c.findingList.slice(0, 100),
          lastTest: run ? toRunSummary(run) : null,
          owningTeams: c.owningTeams.map((t) => t.name),
          updatedAt: c.updatedAt,
          updatedBy: c.updatedBy,
        };
      }),
  }),
];
