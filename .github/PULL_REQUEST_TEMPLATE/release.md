## Release vX.Y.Z

<!-- Open with ?template=release.md. Version in package.json (root, server, web, shared), package-lock.json,
server/src/config.ts, docs/BRANDING.md; compose files pull the new image tag; CHANGELOG section with date and links. -->

- [ ] Version, lockfile, compose image tags and CHANGELOG updated; migrations of this release listed in the CHANGELOG
- [ ] Upgrade tests pass from every fixture (SQLite and PostgreSQL); after the tag: images verified, upgrade fixture added

## Security self-review (OWASP ASVS 4.0, level 2)

For each area: what changed in this release, and the evidence (tests, review, scan). "No change" is a valid answer.

| Area (ASVS chapter)                        | What changed | Evidence |
| ------------------------------------------ | ------------ | -------- |
| Authentication and sessions (V2, V3)       |              |          |
| Access control, new routes and rights (V4) |              |          |
| Input validation and output encoding (V5)  |              |          |
| Secrets, cryptography, the vault (V6)      |              |          |
| Logging, audit and error handling (V7)     |              |          |
| Data protection and personal data (V8)     |              |          |
| Outbound connections and SSRF (V12, V13)   |              |          |
| Dependencies and the build (V14)           |              |          |

- [ ] Route permission matrix covers every new route
- [ ] CodeQL, Semgrep, Trivy, gitleaks, npm audit and OSV-Scanner are green on the release commit
- [ ] No secrets, credentials or personal data in code, tests, fixtures or screenshots
