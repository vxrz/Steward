/**
 * Duplicating applications and services (0.4.0), with options what to copy along. Platform mappings are never copied
 * (a platform belongs to one application); owners and owning teams are the access settings.
 */
import type { ApplicationDetail, DuplicateOption, ItemLink, ServiceDetail } from '@sm/shared';
import { db } from '../db.js';
import { HttpError } from '../util.js';
import { me } from '../auth/access.js';
import { canCreateServices } from '../records/access.js';
import * as apps from '../catalogue/applications.js';
import * as services from '../catalogue/service.js';
import { addComponent } from '../catalogue/components.js';
import { linkSystem } from '../catalogue/systems.js';
import { scopeOf } from '../catalogue/scope.js';
import type { LinkInput } from '../records/links.js';
import { copyOwningTeams, type Duplicator } from './common.js';

/** Steps that may be refused for this person (a document they may not change …): counted as skipped, the rest goes on. */
function tryEach<T>(items: T[], fn: (x: T) => void): number {
  let skipped = 0;
  for (const x of items) {
    try {
      fn(x);
    } catch (e) {
      if (!(e instanceof HttpError) || e.statusCode >= 500) throw e;
      skipped++;
    }
  }
  return skipped;
}

/** The links of the original the person sees, as inputs for the copy. Links to documents only with that option. */
function linkInputs(links: ItemLink[], documents: boolean): LinkInput[] {
  return links
    .filter((l) => l.visible && (documents || l.kind !== 'record'))
    .map((l): LinkInput =>
      l.kind && l.targetId ? { kind: l.kind, id: l.targetId, note: l.note } : { url: l.url!, label: l.label, note: l.note, linkType: l.linkType },
    );
}

const skip = (what: string, count: number) => (count ? [{ what, count }] : []);

export const applicationDuplicator: Duplicator<ApplicationDetail> = {
  kind: 'application',
  entityType: 'application',
  label: 'Application',
  accessApplies: true,
  options: ['components', 'systems', 'documents'] as const satisfies readonly DuplicateOption[],
  view(id) {
    const a = apps.getApplication(id);
    return { id: a.id, name: a.name, key: null, mayManage: a.canEdit, data: a };
  },
  mayCreate: () => canCreateServices(me()),
  nameTaken: (n) => !!db().get('SELECT 1 FROM applications WHERE lower(name) = lower(?) AND archived = 0', n),
  optionCounts: (src) => [
    { option: 'components', count: src.data.components.length },
    { option: 'systems', count: src.data.systems.length },
    { option: 'documents', count: src.data.documents.length + src.data.links.filter((l) => l.visible && l.kind === 'record').length },
  ],
  copy(src, input) {
    const a = src.data;
    const made = apps.createApplication(
      apps.applicationInput.parse({
        name: input.name,
        description: a.description,
        vendor: a.vendor,
        version: a.version,
        url: a.url,
        // owners may change the application: they are its access settings
        owners: input.copyAccess ? a.owners : [],
        criticality: a.criticality,
        tags: a.tags,
        // the CMDB entry names the original (a copy is a different configuration item)
        cmdb: null,
      }),
    );
    if (input.copyAccess) copyOwningTeams('application', a.id, made.id);
    const skipped: { what: string; count: number }[] = [];
    const opt = new Set(input.options);
    if (opt.has('components'))
      skipped.push(
        ...skip(
          'components',
          tryEach(a.components, (c) =>
            addComponent(
              made.id,
              {
                type: c.type,
                name: c.name,
                url: c.url,
                note: c.note,
                environment: c.environment,
                platformId: c.platformId ?? null,
                // the stack entered by hand; what was read (SBOM, cluster, repository) is the original's
                stack: c.stack.filter((x) => x.source === 'manual').map((x) => ({ product: x.product, version: x.version })),
                dependencyTrack: c.dependencyTrack ? { platformId: c.dependencyTrack.platformId, project: c.dependencyTrack.project } : null,
              },
              apps.canEditApplication,
            ),
          ),
        ),
      );
    if (opt.has('systems'))
      skipped.push(
        ...skip(
          'systems',
          tryEach(a.systems, (s) => linkSystem(made.id, { systemId: s.systemId, environment: s.environment, note: s.note }, apps.canEditApplication)),
        ),
      );
    if (opt.has('documents'))
      // the documents that apply to the original apply to the copy too (a change of each document: who may change it)
      skipped.push(
        ...skip(
          'documents',
          tryEach(a.documents, (d) =>
            apps.setDocumentScope(d.id, [
              ...scopeOf(d.id)
                .map((x) => x.id)
                .filter((x) => x !== made.id),
              made.id,
            ]),
          ),
        ),
      );
    skipped.push(
      ...skip(
        'links',
        tryEach(linkInputs(a.links, opt.has('documents')), (l) => apps.addApplicationLink(made.id, l)),
      ),
    );
    return { id: made.id, name: made.name, key: null, skipped, details: { platformMappings: 'not copied' } };
  },
  paths: (id) => ({ path: `/applications/${id}`, editPath: `/applications/${id}?edit=1` }),
};

export const serviceDuplicator: Duplicator<ServiceDetail> = {
  kind: 'service',
  entityType: 'service',
  label: 'Service',
  accessApplies: true,
  options: ['applications', 'documents'] as const satisfies readonly DuplicateOption[],
  view(id) {
    const s = services.getService(id);
    return { id: s.id, name: s.name, key: null, mayManage: s.canEdit, data: s };
  },
  mayCreate: () => canCreateServices(me()),
  nameTaken: (n) => !!db().get('SELECT 1 FROM services WHERE lower(name) = lower(?) AND archived = 0', n),
  optionCounts: (src) => [
    { option: 'applications', count: src.data.applications.length },
    { option: 'documents', count: src.data.links.filter((l) => l.visible && l.kind === 'record').length },
  ],
  copy(src, input) {
    const s = src.data;
    const made = services.createService(
      services.serviceInput.parse({
        name: input.name,
        description: s.description,
        contacts: s.contacts,
        owners: input.copyAccess ? s.owners : [],
        criticality: s.criticality,
        tags: s.tags,
        cmdb: null,
      }),
    );
    if (input.copyAccess) copyOwningTeams('service', s.id, made.id);
    const skipped: { what: string; count: number }[] = [];
    const opt = new Set(input.options);
    if (opt.has('applications'))
      skipped.push(
        ...skip(
          'applications',
          tryEach(
            s.applications.filter((x) => !x.archived),
            (x) => apps.setServiceApplication(made.id, x.id, { role: x.role, roleText: x.roleText }),
          ),
        ),
      );
    // documents the service links to are linked from the copy (documents that link to the service stay as they are)
    skipped.push(
      ...skip(
        'links',
        tryEach(linkInputs(s.links, opt.has('documents')), (l) => services.addServiceLink(made.id, l)),
      ),
    );
    return { id: made.id, name: made.name, key: null, skipped };
  },
  paths: (id) => ({ path: `/services/${id}`, editPath: `/services/${id}?edit=1` }),
};
