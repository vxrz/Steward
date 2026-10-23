/**
 * Product branding in one place. The UI title, header, footer, app window,
 * PWA manifest, executable and data-folder names use these values.
 */
export const BRAND = {
  name: 'Steward',
  shortName: 'Steward',
  tagline: 'Repeatable, auditable service procedures for your platforms',
  /** Used for executables, data folder, container and service names */
  slug: 'steward',
  /** Theme colour (PWA, app window) */
  color: '#1c7ed6',
  /** Source code. GitHub redirects automatically after the repository is renamed. */
  repoUrl: 'https://github.com/vxrz/steward',
  author: 'uebelacker.io',
  authorUrl: 'https://uebelacker.io',
  license: 'Apache-2.0',
  copyrightYear: 2026,
} as const;
