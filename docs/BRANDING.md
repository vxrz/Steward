# Name and branding

## Changing the name

All product branding lives in [`shared/src/brand.ts`](../shared/src/brand.ts):

- `name` and `shortName`
- `tagline`
- `slug`: executable, data folder and autostart entry
- `color`: theme colour of the window, PWA and icon background

The page title, the PWA manifest, the app window, the console banner and the executable name are all derived from it. The icon is in `web/public/icon.svg`. The PNGs are rendered from it.

Technical identifiers stay the same so existing installations keep working:

- environment variables (`SM_*`),
- the session cookie,
- the database file name.

**Before you settle on a name:**

1. Run a quick trademark and app-store search.
2. Search your company's internal app catalogue.
3. Keep Siemens product names (Insights Hub, Industrial Edge, MindSphere) out of the product name. The tool is platform-agnostic, and using those names suggests an official Siemens product.

## Name ideas

The tool turns recurring service work into repeatable, approved, evidenced procedures for any platform. Names that carry *care*, *routine* and *proof* fit better than generic "manager" names.

| Name | Why it fits | Watch out for |
| --- | --- | --- |
| **Steward** (e.g. "Platform Steward") | Stewardship means looking after something on someone else's behalf, accountably. That is exactly access reviews, housekeeping and evidence. It reads well in sentences: "Steward found 12 inactive users". | Common English word. Fine for an internal tool; for a public product, combine it ("Platform Steward"). |
| **Runbook Studio** | Self-explanatory for IT and OT people: you design runbooks and run them. | Descriptive, so harder to protect as a brand. |
| **Proctor** | Supervises and certifies. Fits the audit and four-eyes angle. | Associated with exam supervision in the US. |
| **Custodian** | Guardianship of access and assets; resonates with ISO 27001 "asset owner/custodian" wording. | Long. |
| **Attest** | Every run ends with sealed evidence, an attestation. Short, and good for the audit story. | Used by some security vendors. |
| **Cadence** | Recurring routines on a schedule. | Taken by a Temporal-like workflow engine (Uber Cadence), which is confusing in this space. |
| **Keeper**, **Warden**, **Loom** | | Already strong brands (Keeper Security, Bitwarden, Atlassian Loom). Avoid. |

**Recommendation: *Steward*.** The full name would be "Platform Steward" and the tagline "Repeatable, auditable service procedures for your platforms". It describes the purpose rather than the technology, it survives the tool growing beyond Insights Hub and Industrial Edge, and the current icon (a flow ending in a check mark) already fits.
