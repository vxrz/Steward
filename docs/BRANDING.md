# Name and branding

The product is called **Steward**. The tagline is _Repeatable, auditable service procedures for your platforms_.

## Where branding lives

| What                                                                         | Where                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, tagline, slug, colour, repository URL, author, licence, copyright year | [`shared/src/brand.ts`](../shared/src/brand.ts)                                                                                                                                                           |
| Logo: a flow drawn as an "S" that ends in a check mark                       | `web/public/icon.svg` (app icon), `web/public/icon-maskable.svg` (Android/PWA safe zone), `docs/logo.svg`, React component `web/src/components/brand/Logo.tsx`. The PNG icons are rendered from the SVGs. |
| Footer (app and sign-in page)                                                | `web/src/components/brand/AppFooter.tsx`                                                                                                                                                                  |
| Theme set by an administrator (colours, display name, logo)                  | _Settings → Appearance_, see [Theming](#theming-settings--appearance)                                                                                                                                     |
| Franconian rake shown in the footer                                          | `web/src/components/brand/FrankenRechen.tsx`                                                                                                                                                              |

The page title, PWA manifest, app window, console banner, notifications (e-mail subject, Teams card – unless an administrator sets an app name or a [look for notifications](NOTIFICATIONS.md#look-of-e-mails-and-teams-messages)), protocols, log/trace service name, executable name (`steward[.exe]`), per-user data folder, container and release file names are all derived from `brand.ts`.

These technical identifiers keep their old names, so existing data keeps working:

- environment variables `SM_*`,
- the cookie `sm_session`,
- the SQLite file `service-manager.db`,
- the vault check value.

Export files are now written as `steward-bundle` and `steward-connector`. Files exported before the rename (`service-manager-…`) can still be imported.

**When the GitHub repository is renamed** to `steward`, update `repoUrl` in `brand.ts`. GitHub redirects the old URL until then.

## Theming (Settings → Appearance)

Administrators can adapt the look of an installation for everyone, e.g. to the company colours. It applies at once (open pages pick it up within a minute) and already on the sign-in page.

| Setting                   | Effect                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary colour**        | Buttons, links, active navigation, focus, the primary colour of every component                                                                                                                                                                                                       |
| **Accent colour**         | Counters and highlights, e.g. the open-tasks badge                                                                                                                                                                                                                                    |
| **Default colour scheme** | _Like the system_, _Light_ or _Dark_ for people who have not chosen one; everyone keeps their own light/dark switch                                                                                                                                                                   |
| **Corner radius**         | Small, medium (default) or large                                                                                                                                                                                                                                                      |
| **Display name**          | Header, window title, sign-in page and installed-app name, e.g. "ACME Steward". The footer and the About page keep the product name _Steward_.                                                                                                                                        |
| **Logo**                  | Header and sign-in page. PNG, JPEG or WebP, at most 512 KB and 4096 × 4096 pixels, recognised by its content (not its file name). **SVG is refused** because an SVG file can contain scripts. Served from `/api/theme/logo` with `nosniff` and a restrictive content security policy. |

**Readable in every case.** From each colour Steward generates a ten-shade palette (OKLCH lightness ramp; the colour itself is shade 6, as in Mantine's palettes; Steward's defaults keep Mantine's blue and violet unchanged). Then, for the light and the dark scheme separately:

- **Text on filled buttons and badges** is white where white reaches WCAG AA (4.5 : 1) on the colour or on up to two shades darker – like Steward's blue – and black otherwise (auto contrast). Bright colours such as yellow therefore get black text instead of unreadable white.
- **Links and coloured text** (light, outline and subtle variants, active navigation, alerts) use the first shade that reaches AA on the page and on the tinted backgrounds; in the dark scheme a lighter shade. If no shade of the palette does, a darker or lighter variant is computed.
- In the dark scheme, filled buttons must also stand out from the page (at least 2 : 1), so very dark colours switch to a lighter shade with dark text.

The settings card explains every adjustment (e.g. "too light for text on a white page, so links use the darker #826c00") and warns when filled buttons barely stand out from the page. The live preview shows header, navigation, buttons, badges, a link and an alert in both colour schemes before saving. _Reset to Steward defaults_ restores everything and removes the logo. The UI tests run the accessibility checks with a bright yellow primary colour in light and dark mode.

**How it is delivered.** `GET /api/theme` is public (the sign-in page needs it) and contains only the theme: colours, scheme, radius, display name and the logo URL – no secrets. It is cacheable with an ETag (`304 Not Modified` while unchanged); the browser also keeps the last theme in local storage so the next visit starts in the right colours, and open pages check for changes every minute. The web app manifest is served by the server (`/manifest.webmanifest`) with the display name and the primary colour; the static manifest of the web build remains the fallback (e.g. `npm run dev`). The settings are stored in the database (internal settings `theme.*`, logo included), so all instances behind a load balancer show the same theme and database backups contain it.

Changes are audited: `theme.updated` (changed fields, old and new value), `theme.logo_uploaded` (type, size, dimensions, SHA-256), `theme.logo_removed`, `theme.reset`.

API (administrators): `GET`/`PUT /api/settings/theme`, `POST /api/settings/theme/reset`, `POST`/`DELETE /api/settings/theme/logo` (multipart or `{ "contentBase64": "…" }`).

**E-mails and Teams messages** have their own look (_Settings → Look of e-mails and Teams messages_): name, colour, logo (the app logo, the report logo or an own one), footer, header style, logo size and position, button colour, corners and font. Empty fields follow the Appearance settings. See [NOTIFICATIONS.md](NOTIFICATIONS.md#look-of-e-mails-and-teams-messages).

## Footer

> Made with ❤️ in Erlangen, Germany · Metropolregion Nürnberg [Franconian rake] · Designed & built by uebelacker.io with AI
> © 2026 uebelacker.io · Open source (Apache-2.0) · GitHub · Steward 0.2.6 · About Steward

The version comes from the web build; _About Steward_ (signed-in users) opens the About page with build details, links and the third-party licences.

**Franconian rake vs. coat of arms.** The footer shows the _Fränkischer Rechen_: in red, three silver points. It is the free regional symbol of Franconia, also used on the Franconian flag. The _official_ coat of arms of the Bezirk Mittelfranken combines the rake with the Nuremberg burgraviate and the Hohenzollern arms. Under Bavarian law, third parties may only use official coats of arms of public bodies with permission. If you want the official Bezirk arms, ask the Bezirk Mittelfranken first.

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
