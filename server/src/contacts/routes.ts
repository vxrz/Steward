import type { FastifyInstance } from 'fastify';
import { contactInput, contactReplaceInput } from '@sm/shared';
import { ACCESS, type RouteAccess } from '../auth/access.js';
import { params } from '../routes/params.js';
import * as svc from './service.js';
import * as roles from './roles.js';

/**
 * The contacts directory (mounted under /api; ADR 0038, docs/CONTACTS.md). Personal data of people who often have no
 * account: every route needs a signed-in session (no API token), and the service decides who sees and changes each
 * contact. Module-only users (a plant viewer, a data products contributor) reach them too: the picker on their items.
 *   GET    /contacts                 search and list (?q=&status=active|left|all&limit=&offset=): visible ones only
 *   GET    /contacts/duplicates      administrators: contacts that share an e-mail address
 *   GET    /contacts/:id             the where-used page (links on hidden items counted, never named)
 *   POST   /contacts                 create (linked to nothing: seen by its creator, administrators and auditors)
 *   PUT    /contacts/:id             change (who may change one item it is linked to, administrators)
 *   POST   /contacts/:id/replace     Replace with… {targetId, markLeft?}
 *   DELETE /contacts/:id             erase (administrators, step-up, GDPR Art. 17)
 *   GET    /contact-roles            the role catalogue (0.26.0, ADR 0039): every signed-in person (the pickers);
 *                                    administrators also get each role's usage
 *   POST   /contact-roles            administrators: an own role
 *   PUT    /contact-roles/:key       administrators: change a role (a built-in one: labels, kinds of its own, on/off)
 *   DELETE /contact-roles/:key       administrators: an own role nobody names
 */

/**
 * A module-only user too (a plant viewer, a data products contributor): the picker on the items they may change. The
 * service decides who sees, creates and changes each contact.
 */
const READ: RouteAccess = { auth: 'session', plantViewer: true };
const SESSION = READ;

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/contacts', { config: { access: READ } }, async (req) => svc.listContacts((req.query ?? {}) as Record<string, string>));
  app.get('/contacts/duplicates', { config: { access: ACCESS.adminSession } }, async () => svc.contactDuplicates());
  app.get('/contacts/:id', { config: { access: READ } }, async (req) => svc.getContact(params(req).id!));
  app.post('/contacts', { config: { access: SESSION } }, async (req) => svc.createContact(contactInput.parse(req.body ?? {})));
  app.put('/contacts/:id', { config: { access: SESSION } }, async (req) => svc.updateContact(params(req).id!, contactInput.parse(req.body ?? {})));
  app.post('/contacts/:id/replace', { config: { access: SESSION } }, async (req) =>
    svc.replaceContact(params(req).id!, contactReplaceInput.parse(req.body ?? {})),
  );
  app.get('/contact-roles', { config: { access: READ } }, async () => roles.listRoles());
  app.post('/contact-roles', { config: { access: ACCESS.adminSession } }, async (req) => roles.createRole(req.body ?? {}));
  app.put('/contact-roles/:key', { config: { access: ACCESS.adminSession } }, async (req) => roles.updateRole(params(req).key!, req.body ?? {}));
  app.delete('/contact-roles/:key', { config: { access: ACCESS.adminSession } }, async (req) => {
    roles.deleteRole(params(req).key!);
    return { ok: true };
  });
  app.delete('/contacts/:id', { config: { access: ACCESS.adminSession, stepUp: { action: 'eraseContact', who: 'manageUsers' } } }, async (req) => {
    svc.eraseContact(params(req).id!);
    return { ok: true };
  });
}
