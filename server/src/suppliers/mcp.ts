import { z } from 'zod';
import { SUPPLIER_STATUSES } from '@sm/shared';
import { pageArray } from '../api/v1/pagination.js';
import { ToolError, cursorArg, defineTool, idArg, limitArg, type ToolDef } from '../mcp/tooling.js';
import { HttpError } from '../util.js';
import { getSupplier, listSuppliers, toPublic } from './service.js';

/**
 * Suppliers for AI assistants (0.17.0, ADR 0029): read only, with the rights of the token owner; contacts without
 * e-mail and phone. Writes – and the decisions of the "To confirm" list – stay in the app.
 */
export const supplierTools: ToolDef[] = [
  defineTool({
    name: 'list_suppliers',
    title: 'List suppliers',
    description:
      'Suppliers (SaaS, managed platforms, software vendors, service providers) that you may see, ordered by name: type, status (unconfirmed suppliers were made from free-text vendors and wait for a person to confirm them), whether they process personal data and the data processing agreement, the next notice-by date of their contracts, the next certificate expiry, the derived criticality and how many applications, systems, tickets, page watches, cost plan lines and duties link them. Default: unconfirmed and active.',
    input: z
      .object({
        status: z.enum(SUPPLIER_STATUSES).optional().describe('Only this status'),
        query: z.string().max(200).optional().describe('Case-insensitive text in name, spellings and description'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      const needle = a.query?.trim().toLowerCase();
      const list = listSuppliers({ status: a.status ?? ['unconfirmed', 'active'] })
        .filter((s) => !needle || [s.name, s.description, ...s.aliases].some((x) => x.toLowerCase().includes(needle)))
        .map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          website: s.website,
          owners: s.owners,
          personalData: s.personalData,
          dpaStatus: s.dpaStatus,
          contracts: s.contractCount,
          certificates: s.certificateCount,
          nextNoticeBy: s.nextNoticeBy,
          nextCertificateExpiry: s.nextCertificateExpiry,
          criticality: s.criticality,
          usage: s.usage,
        }));
      return pageArray(list, (s) => [s.name.toLowerCase(), s.id], a, { status: a.status, query: a.query });
    },
  }),
  defineTool({
    name: 'get_supplier',
    title: 'Get a supplier',
    description:
      'One supplier: contracts (term, notice-by date, renewal, SLA availability, support hours, response times, contractual RTO and RPO in hours, the cost plan lines that pay for them), certificates (ISO/IEC 27001, SOC 2 … with validity), contacts with name and role only (no e-mail or phone), the items that link it and its supplier review duties with their last periods.',
    input: z.object({ supplierId: idArg('Supplier id (sup_…, from list_suppliers)') }).strict(),
    handler: (a) => {
      try {
        return toPublic(getSupplier(a.supplierId));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw new ToolError(`Supplier ${a.supplierId} not found`);
        throw e;
      }
    },
  }),
];
