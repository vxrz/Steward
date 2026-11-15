/**
 * The contacts directory in the web app (ADR 0038, docs/CONTACTS.md): the picker for an item's contacts, the picker for
 * who decided a documented decision, the form, a read-only view of an item's contacts, inherited contacts and the hint
 * of expected roles (0.26.0, ADR 0039), and the section of an item's page.
 */
export {
  ContactPicker,
  ContactLinksView,
  ExpectedRolesHint,
  InheritedContactsView,
  fromLinks,
  toLinkInputs,
  sameContacts,
  type ContactPickerValue,
} from './ContactPicker';
export { ItemContactsSection } from './ItemContactsSection';
export { ContactSnapshotPicker, type ContactSnapshotValue } from './ContactSnapshotPicker';
export { ContactLine, ContactSearchSelect } from './ContactSearch';
export { ContactForm } from './ContactForm';
export { CONTACT_ROLES_KEY, useContactRoleLabel, useContactRoles, useContactSearch, useEmailMatches } from './hooks';
