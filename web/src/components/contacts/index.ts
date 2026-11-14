/**
 * The contacts directory in the web app (ADR 0038, docs/CONTACTS.md): the picker for an item's contacts, the picker for
 * who decided a documented decision, the form, and a read-only view of an item's contacts.
 */
export { ContactPicker, ContactLinksView, fromLinks, toLinkInputs, sameContacts, type ContactPickerValue } from './ContactPicker';
export { ContactSnapshotPicker, type ContactSnapshotValue } from './ContactSnapshotPicker';
export { ContactLine, ContactSearchSelect } from './ContactSearch';
export { ContactForm } from './ContactForm';
export { useContactRoleLabel, useContactSearch, useEmailMatches } from './hooks';
