# Name and branding

The product is called **Steward**. The tagline is *Repeatable, auditable service procedures for your platforms*.

## Where branding lives

| What | Where |
| --- | --- |
| Name, tagline, slug, colour, repository URL, author, licence, copyright year | [`shared/src/brand.ts`](../shared/src/brand.ts) |
| Logo: a flow drawn as an "S" that ends in a check mark | `web/public/icon.svg` (app icon), `web/public/icon-maskable.svg` (Android/PWA safe zone), `docs/logo.svg`, React component `web/src/components/brand/Logo.tsx`. The PNG icons are rendered from the SVGs. |
| Footer (app and sign-in page) | `web/src/components/brand/AppFooter.tsx` |
| Franconian rake shown in the footer | `web/src/components/brand/FrankenRechen.tsx` |

The page title, PWA manifest, app window, console banner, notifications (e-mail subject, Teams card), protocols, log/trace service name, executable name (`steward[.exe]`), per-user data folder, container and release file names are all derived from `brand.ts`.

These technical identifiers keep their old names, so existing data keeps working:

- environment variables `SM_*`,
- the cookie `sm_session`,
- the SQLite file `service-manager.db`,
- the vault check value.

Export files are now written as `steward-bundle` and `steward-connector`. Files exported before the rename (`service-manager-…`) can still be imported.

**When the GitHub repository is renamed** to `steward`, update `repoUrl` in `brand.ts`. GitHub redirects the old URL until then.

## Footer

> Made with ❤️ in Erlangen, Germany · Metropolregion Mittelfranken [Franconian rake] · Designed and developed by uebelacker.io with AI
> © 2026 uebelacker.io · Open source (Apache-2.0) · GitHub

**Franconian rake vs. coat of arms.** The footer shows the *Fränkischer Rechen*: in red, three silver points. It is the free regional symbol of Franconia, also used on the Franconian flag. The *official* coat of arms of the Bezirk Mittelfranken combines the rake with the Nuremberg burgraviate and the Hohenzollern arms. Under Bavarian law, third parties may only use official coats of arms of public bodies with permission. If you want the official Bezirk arms, ask the Bezirk Mittelfranken first.

**Copyright notice.** A © line fits an open-source project: the licence grants rights, but copyright stays with the author.

- The year is the first publication year; it can become a range later (`2026–2027`).
- `uebelacker.io` is used as the holder. You may prefer your legal name or company, e.g. "© 2026 Arvid Übelacker".
- Change it in `brand.ts` and `NOTICE`.

## Licence

**Apache License 2.0**, chosen over MIT:

- **Patent grant.** Every contributor licenses any patents that cover their contribution, and loses that licence if they sue over the code. This matters in industrial and corporate settings, and companies' legal teams know and accept it.
- **Contribution terms.** Contributions are under the same licence by default (section 5), so no separate CLA is needed for a small project.
- **NOTICE file.** Attribution travels with redistributions.

MIT is shorter but has no patent clause. Both are permissive and allow commercial use.

**Before you publish**, check whether your employment contract or your employer's open-source policy covers code written for work. Many companies, Siemens included, have a short approval process for publishing. The process is usually easy, but it should happen before the repository goes public.
