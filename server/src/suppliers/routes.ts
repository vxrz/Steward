import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SUPPLIER_STATUSES,
  supplierArchiveInput,
  supplierCertificateInput,
  supplierContactInput,
  supplierContractInput,
  supplierInput,
  supplierMergeInput,
} from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { params } from '../routes/params.js';
import * as s from './service.js';

/**
 * Suppliers (0.17.0, ADR 0029), mounted under /api – the web app's API; /api/v1 and MCP only read:
 *   GET    /suppliers[?status=unconfirmed|active|archived]   list (everyone signed in, team scope)
 *   POST   /suppliers                                         create (designers, administrators)
 *   GET    /suppliers/options                                 the picker of the forms (not archived)
 *   GET    /suppliers/:id                                     read
 *   PUT    /suppliers/:id                                     change (designers, administrators, its owners)
 *   POST   /suppliers/:id/archive | confirm | merge | not-a-supplier   (designers, administrators; decisions in a session)
 *   POST|PUT|DELETE /suppliers/:id/contacts|contracts|certificates[/:itemId]   (who may change the supplier)
 */
const listQuery = z.object({ status: z.enum(SUPPLIER_STATUSES).optional() });

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  app.get('/suppliers', async (req) => s.listSuppliers({ status: listQuery.parse(req.query).status }));
  app.post('/suppliers', async (req) => s.createSupplier(supplierInput.parse(req.body)));
  app.get('/suppliers/options', async () => s.supplierOptions());
  app.get('/suppliers/:id', async (req) => s.getSupplier(params(req).id!));
  app.put('/suppliers/:id', async (req) => s.updateSupplier(params(req).id!, supplierInput.parse(req.body)));
  app.post('/suppliers/:id/archive', { config: { access: ACCESS.session } }, async (req) =>
    s.setSupplierArchived(params(req).id!, supplierArchiveInput.parse(req.body).archived),
  );
  // the "To confirm" list: decisions of people in a session (ADR 0029, decided 9)
  app.post('/suppliers/:id/confirm', { config: { access: ACCESS.session } }, async (req) => s.confirmSupplier(params(req).id!));
  app.post('/suppliers/:id/merge', { config: { access: ACCESS.session } }, async (req) =>
    s.mergeSupplier(params(req).id!, supplierMergeInput.parse(req.body).into),
  );
  app.post('/suppliers/:id/not-a-supplier', { config: { access: ACCESS.session } }, async (req) => s.dismissSupplier(params(req).id!));

  app.post('/suppliers/:id/contacts', async (req) => s.addContact(params(req).id!, supplierContactInput.parse(req.body)));
  app.put('/suppliers/:id/contacts/:contactId', async (req) => s.updateContact(params(req).id!, params(req).contactId!, supplierContactInput.parse(req.body)));
  app.delete('/suppliers/:id/contacts/:contactId', async (req) => s.removeContact(params(req).id!, params(req).contactId!));

  app.post('/suppliers/:id/contracts', async (req) => s.addContract(params(req).id!, supplierContractInput.parse(req.body)));
  app.put('/suppliers/:id/contracts/:contractId', async (req) =>
    s.updateContract(params(req).id!, params(req).contractId!, supplierContractInput.parse(req.body)),
  );
  app.delete('/suppliers/:id/contracts/:contractId', async (req) => s.removeContract(params(req).id!, params(req).contractId!));

  app.post('/suppliers/:id/certificates', async (req) => s.addCertificate(params(req).id!, supplierCertificateInput.parse(req.body)));
  app.put('/suppliers/:id/certificates/:certificateId', async (req) =>
    s.updateCertificate(params(req).id!, params(req).certificateId!, supplierCertificateInput.parse(req.body)),
  );
  app.delete('/suppliers/:id/certificates/:certificateId', async (req) => s.removeCertificate(params(req).id!, params(req).certificateId!));
}
