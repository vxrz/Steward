import { dataGovernanceSettingsInput, type DataGovernanceSettings } from '@sm/shared';
import { audit } from '../audit.js';
import { forbid } from '../auth/access.js';
import { db } from '../db.js';
import { mayChangeModuleSetting } from '../modules/access.js';
import { readSetting, writeSetting } from '../settings.js';

/**
 * The data products module's governance settings (0.25.1, ADR 0038 part 4), for the whole module:
 *
 * - `portReviewFourEyes` (off by default): a port access review is approved by a second IT person who may edit the
 *   product – never who submitted it or entered a decision – before it is sealed. Off: submitting seals it. A review
 *   keeps the setting it was started with.
 *
 * Read by everyone who uses the module; changed by administrators and granted managers of the module (the module's
 * manager setting `governance`), audited (`dataproduct.governance_settings_changed`).
 */
const KEY = 'modules.dataProducts.governance';
const DEFAULTS: Omit<DataGovernanceSettings, 'mayChange'> = { portReviewFourEyes: false };

export function governanceSettings(): Omit<DataGovernanceSettings, 'mayChange'> {
  const v = readSetting<Partial<DataGovernanceSettings>>(KEY, {});
  return { portReviewFourEyes: typeof v.portReviewFourEyes === 'boolean' ? v.portReviewFourEyes : DEFAULTS.portReviewFourEyes };
}

/** GET /api/data-products/governance-settings */
export const governanceSettingsView = (): DataGovernanceSettings => ({
  ...governanceSettings(),
  mayChange: mayChangeModuleSetting('dataProducts', 'governance'),
});

/** PUT /api/data-products/governance-settings (session only) */
export function putGovernanceSettings(body: unknown): DataGovernanceSettings {
  if (!mayChangeModuleSetting('dataProducts', 'governance')) forbid('change the governance settings of data products', 'moduleSettings');
  const input = dataGovernanceSettingsInput.parse(body);
  const before = governanceSettings();
  db().tx(() => {
    writeSetting(KEY, { portReviewFourEyes: input.portReviewFourEyes });
    audit({
      action: 'dataproduct.governance_settings_changed',
      entityType: 'settings',
      entityId: KEY,
      summary: `Data products: four eyes for port access reviews ${input.portReviewFourEyes ? 'on' : 'off'}`,
      details: { before, after: input },
    });
  });
  return governanceSettingsView();
}
