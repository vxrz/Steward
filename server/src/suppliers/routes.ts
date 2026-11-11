import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SUPPLIER_STATUSES,
  supplierArchiveInput,
  supplierCertificateInput,
  supplierContactInput,
  supplierContractInput,
  supplierContractServiceInput,
  supplierInput,
  supplierMergeInput,
  supplierOpenInput,
  supplierSharedMergeInput,
} from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { params } from '../routes/params.js';
import * as s from './service.js';
import * as shared from './shared.js';
import { contractScopeNotice, dismissContractScopeNotice } from './contract-scope.js';

/**
 * Suppliers (0.17.0, ADR 0029), mounted under /api – the web app's API; /api/v1 and MCP only read:
 *   GET    /suppliers[?status=unconfirmed|active|archived]   list (everyone signed in, team scope)
 *   POST   /suppliers                                         create (designers, administrators)
 *   GET    /suppliers/options                                 the picker of the forms (not archived)
 *   GET    /suppliers/:id                                     read
 *   PUT    /suppliers/:id                                     change (designers, administrators, its owners)
 *   POST   /suppliers/:id/archive | confirm | merge | not-a-supplier   (designers, administrators; decisions in a session)
 *   POST|PUT|DELETE /suppliers/:id/contacts|contracts|certificates[/:itemId]   (who may change the supplier; contracts: ADR 0031)
 *   GET    /suppliers/:id/contracts/:contractId              the contract page (404 for who may not see it)
 *   PUT|DELETE /suppliers/:id/contracts/:contractId/services/:serviceId   add, purpose, confirm; leave or dismiss
 *   GET    /services/:id/contracts                            the contracts covering a service (its "Suppliers" section)
 *   GET    /suppliers/shared-suggestions, POST …/:key/keep-separate   "Same supplier in several teams" (administrators)
 *   POST   /suppliers/merge/preview | merge                    a merge of up to ten suppliers (widening: administrators)
 *   POST   /suppliers/:id/open/preview | open                  new owning teams with the protections (administrators)
 *
 * Every change is a decision of a person in a session in the app – also marking a certificate as looked at (ADR 0029
 * decision 9): the changing routes refuse API tokens. Reading one supplier with an API token gives what /api/v1 gives –
 * contacts without e-mail and phone (decision 8).
 */
const listQuery = z.object({ status: z.enum(SUPPLIER_STATUSES).optional() });
const scopedQuery = z.object({ kind: z.enum(['application', 'system']), id: z.string().min(1).max(100) });
/**
 * Removing a contract (ADR 0031): `orderForms=standalone` says the order forms of a master become standalone;
 * `replacedBy` names the contract of the same supplier that takes over what named it
 */
const removeContractQuery = z.object({ orderForms: z.enum(['standalone']).optional(), replacedBy: z.string().min(1).max(100).optional() });
const session = { config: { access: ACCESS.session } };
/** The request comes with an API token (no session in the app). */
const viaToken = (req: FastifyRequest) => !!(req as unknown as { smToken?: string }).smToken;

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  app.get('/suppliers', async (req) => s.listSuppliers({ status: listQuery.parse(req.query).status }));
  app.post('/suppliers', session, async (req) => s.createSupplier(supplierInput.parse(req.body)));
  app.get('/suppliers/options', async () => s.supplierOptions());
  // the contacts scoped to an application or system (its "Suppliers" panel, ADR 0031)
  app.get('/suppliers/scoped-contacts', async (req) => {
    const q = scopedQuery.parse(req.query ?? {});
    const list = s.scopedContacts(q.kind, q.id);
    // with an API token: name, role and note only (ADR 0029 decided 8)
    return viaToken(req) ? list.map((x) => ({ supplier: x.supplier, contacts: x.contacts.map(s.toPublicContact) })) : list;
  });
  // the administrators' one-time notice after the upgrade to 0.18 (ADR 0031 part 9)
  app.get('/suppliers/scope-notice', async () => ({ notice: contractScopeNotice() }));
  app.delete('/suppliers/scope-notice', { config: { access: ACCESS.adminSession } }, async () => dismissContractScopeNotice());
  app.get('/suppliers/:id', async (req) => {
    const d = s.getSupplier(params(req).id!);
    return viaToken(req) ? s.toPublic(d) : d;
  });
  app.put('/suppliers/:id', session, async (req) => s.updateSupplier(params(req).id!, supplierInput.parse(req.body)));
  app.post('/suppliers/:id/archive', session, async (req) => s.setSupplierArchived(params(req).id!, supplierArchiveInput.parse(req.body).archived));
  // the "To confirm" list: decisions of people in a session (ADR 0029, decided 9)
  app.post('/suppliers/:id/confirm', session, async (req) => s.confirmSupplier(params(req).id!));
  app.post('/suppliers/:id/merge', session, async (req) => shared.mergeOne(params(req).id!, supplierMergeInput.parse(req.body).into));
  // shared suppliers (ADR 0031 part 8): suggestions, the preview, the merge of up to ten, opening a team-scoped one
  app.get('/suppliers/shared-suggestions', { config: { access: ACCESS.admin } }, async () => shared.sharedSuggestions());
  app.post('/suppliers/shared-suggestions/:key/keep-separate', { config: { access: ACCESS.adminSession } }, async (req) =>
    shared.keepSeparate(params(req).key!),
  );
  app.post('/suppliers/merge/preview', session, async (req) => shared.mergePreview(supplierSharedMergeInput.parse(req.body)));
  app.post('/suppliers/merge', session, async (req) => shared.mergeSuppliers(supplierSharedMergeInput.parse(req.body)));
  app.post('/suppliers/:id/open/preview', { config: { access: ACCESS.admin } }, async (req) => {
    const b = supplierOpenInput.parse(req.body);
    return shared.openPreview(params(req).id!, b.teamIds, b.contacts ?? {});
  });
  app.post('/suppliers/:id/open', { config: { access: ACCESS.adminSession } }, async (req) => {
    const b = supplierOpenInput.parse(req.body);
    return shared.openSupplier(params(req).id!, b.teamIds, b.contacts ?? {});
  });
  // contracts with services proposed by the update to 0.18, for who may confirm them ("To confirm")
  app.get('/suppliers/proposed-services', async () => s.proposedServices());
  app.post('/suppliers/:id/not-a-supplier', session, async (req) => s.dismissSupplier(params(req).id!));

  app.post('/suppliers/:id/contacts', session, async (req) => s.addContact(params(req).id!, supplierContactInput.parse(req.body)));
  app.put('/suppliers/:id/contacts/:contactId', session, async (req) =>
    s.updateContact(params(req).id!, params(req).contactId!, supplierContactInput.parse(req.body)),
  );
  app.delete('/suppliers/:id/contacts/:contactId', session, async (req) => s.removeContact(params(req).id!, params(req).contactId!));

  app.post('/suppliers/:id/contracts', session, async (req) => s.addContract(params(req).id!, supplierContractInput.parse(req.body)));
  app.put('/suppliers/:id/contracts/:contractId', session, async (req) =>
    s.updateContract(params(req).id!, params(req).contractId!, supplierContractInput.parse(req.body)),
  );
  app.delete('/suppliers/:id/contracts/:contractId', session, async (req) =>
    s.removeContract(params(req).id!, params(req).contractId!, removeContractQuery.parse(req.query ?? {})),
  );
  // contracts with their own scope (ADR 0031): the contract page, covered services, the service's contracts
  app.get('/suppliers/:id/contracts/:contractId', async (req) => {
    const d = s.getContract(params(req).id!, params(req).contractId!);
    // with an API token: the contacts scoped to the contract without e-mail and phone (ADR 0029 decided 8)
    return viaToken(req) ? { ...d, contacts: d.contacts.map(s.toPublicContact) } : d;
  });
  app.put('/suppliers/:id/contracts/:contractId/services/:serviceId', session, async (req) =>
    s.setContractService(params(req).id!, params(req).contractId!, params(req).serviceId!, supplierContractServiceInput.parse(req.body ?? {})),
  );
  app.delete('/suppliers/:id/contracts/:contractId/services/:serviceId', session, async (req) =>
    s.removeContractService(params(req).id!, params(req).contractId!, params(req).serviceId!),
  );
  app.get('/services/:id/contracts', async (req) => s.serviceContracts(params(req).id!));

  app.post('/suppliers/:id/certificates', session, async (req) => s.addCertificate(params(req).id!, supplierCertificateInput.parse(req.body)));
  app.put('/suppliers/:id/certificates/:certificateId', session, async (req) =>
    s.updateCertificate(params(req).id!, params(req).certificateId!, supplierCertificateInput.parse(req.body)),
  );
  app.delete('/suppliers/:id/certificates/:certificateId', session, async (req) => s.removeCertificate(params(req).id!, params(req).certificateId!));
}
