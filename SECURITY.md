# Security policy

Steward stores credentials for production platforms and can change data on them,
so we take security reports seriously. Thank you for helping keep its users safe.

## Supported versions

Steward is pre-1.0. Security fixes are made on `main` first and released as a
new version. The latest minor release gets them; the minor release before it gets
security fixes for 30 days after the next minor is out, as patch releases. The
full policy – versions, patch releases, how releases are tested and verified – is
in [docs/RELEASES.md](docs/RELEASES.md). Please update before reporting, and
check whether the issue still exists on `main`.

| Version                                        | Supported              |
| ---------------------------------------------- | ---------------------- |
| latest minor release (0.x)                     | ✅                     |
| previous minor release, 30 days after the next | ✅ security fixes only |
| older releases                                 | ❌ – please update     |

This covers the server, the web UI, the desktop executables and the container
image built from this repository's `Dockerfile`.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security
problem.**

Report it privately via GitHub: **Security → Advisories → Report a
vulnerability** in this repository (GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Only the maintainers can see the report. If you cannot use GitHub, open an
issue that only asks for a private contact – without any details.

Please include, as far as you can:

- the affected version or commit and how Steward runs (desktop executable,
  `npm start`, container; single user or team server; SSO or passwords)
- the impact you see (e.g. reading secrets, bypassing access control or the
  four-eyes approval, tampering with the audit log, code execution)
- steps to reproduce or a proof of concept – against your own installation or
  the demo mode (`SM_DEMO=1`), never against someone else's systems
- whether the issue is already public or known to others

## What happens next

| Step                                          | Target time                     |
| --------------------------------------------- | ------------------------------- |
| Acknowledgement of your report                | 3 working days                  |
| First assessment (confirmed or not, severity) | 10 working days                 |
| Fix released – critical / high                | 14 / 30 days after confirmation |
| Fix released – medium / low                   | 90 days after confirmation      |

We keep you informed about progress, agree on a disclosure date with you
(normally when the fix is released, at the latest 90 days after the report) and
publish a GitHub security advisory, with a CVE where appropriate. We are happy to
credit you in the advisory – tell us the name you would like to be credited with,
or that you prefer to stay anonymous.

This is a small open-source project without a bug bounty. The times above are
our commitment, but not a contractual guarantee.

## Scope

In scope: everything in this repository – for example authentication and
sessions, single sign-on, API tokens, role and access-list checks, the
credential vault, secret redaction in logs, run protocols, reports and error
reports, the audit log chain, CSRF/host checks and the Content Security Policy,
the engine and its expressions, the desktop launcher, the container image and
the release and CI workflows.

Out of scope:

- the mock platforms and demo accounts of the demo mode (`SM_DEMO=1`) – their
  credentials are fake and public by design
- vulnerabilities in the platforms Steward talks to (report those to their
  vendors), and in dependencies that Steward does not use in an exploitable way
  (we still welcome a hint)
- findings that need an administrator account or access to the machine and
  data directory, unless they cross a boundary Steward promises (e.g. a
  non-admin reading secrets, or modifying the audit log undetected once a signed
  checkpoint has been kept outside the system – see
  [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#audit-log-as-evidence))
- missing hardening without a concrete attack (e.g. headers on static files),
  denial of service by flooding, social engineering

## Safe harbour

We will not take legal action against research done in good faith that follows
this policy: test only on installations you own or are allowed to test, do not
access or change other people's data, give us reasonable time to fix the issue
before you disclose it, and stop and tell us if you come across sensitive data.

## Running Steward securely

Before using Steward at work – in particular when its audit log and PDF reports
serve as compliance evidence – go through the hardening checklist in
[docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md): dedicated host, TLS and
reverse proxy settings, SSO, the master passphrase as a file or secret, encrypted
backups of database _and_ `vault.json`, signed audit checkpoints shipped to a
SIEM, and keeping Chromium current. Personal data and retention:
[docs/PRIVACY.md](docs/PRIVACY.md).

## Security review guidelines

For reviewers of pull requests, human or agent. The application's security model is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md), the deployment side in [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md), the CI scans in [docs/ci/SECURITY-PIPELINE.md](docs/ci/SECURITY-PIPELINE.md).

**Where the security-relevant code is**

- Access and policy: `server/src/auth/` – route access declarations (`access.ts`; `ACCESS.public` and `ACCESS.session` deserve a second look), rights on objects (`permissions.ts`, `policy.ts`), step-up (`step-up.ts`, `step-up-rules.ts`), access changes and their audit entries (`access-change.ts`), API tokens (`tokens.ts`), single sign-on (`sso.ts`). `server/test/route-matrix.test.ts` compares routes with their expected access.
- Audit: `server/src/audit.ts` and the other `audit-*.ts` files.
- Secrets: `server/src/vault.ts`, `vault-rotation.ts`, `server/src/credentials/`.
- Outbound calls: `server/src/platforms/` (`destination.ts`, `http.ts`, `deniedPaths.ts`) and the outbound policy ([docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#outbound-connections)).
- MCP: `server/src/mcp/` ([docs/MCP.md](docs/MCP.md)).
- Public routes (`ACCESS.public`), web hooks and push endpoints in `server/src/routes/`.

**Blocking findings**

- Authentication or access bypass: a route without a declared access, a check done after the body is read or only in the web app, an API token doing what needs a signed-in session, access widened without step-up or access-change audit entry.
- Team-scope leaks: a reader who can see, count or be told about items they may not see (list totals, error texts, search, exports, MCP).
- Injection of any kind (SQL, command, template, expression, header, path traversal), and server-side request forgery through outbound calls that skip address safety or the outbound policy, including redirects.
- Secrets in logs, errors, protocols, audit entries, exports or API answers.
- Unsafe deserialisation or parsing of untrusted input (use the safe loaders, for example `yaml-safe.ts`), and regular expressions that can backtrack badly on untrusted input (ReDoS). CodeQL runs on the repository and finds some of these; a review does not rely on it.
- Weakened or removed checks, tests or audit entries.

**Reporting findings on a public repository**

If a finding is an exploitable problem in released code or on `main`, do not describe it in a public pull request comment, issue or review. Report it through [private vulnerability reporting](#reporting-a-vulnerability) and note in the review only that a finding exists, without details. Hardening ideas without a concrete attack can be public.

## Library publisher key

Shared procedure libraries ([docs/LIBRARIES.md](docs/LIBRARIES.md)) are signed
with OpenSSH keys (`ssh-keygen -Y sign -n steward-library`). Steward's own
publisher key (`steward`) is meant to live on a maintainer's hardware key
(`sk-ssh-ed25519`) and to be built in; CI only verifies, it never signs.

**This version has no built-in publisher key**: no installation trusts a
library publisher unless an administrator adds its key (Settings → Libraries).

**Maintainer step, not done yet** (by hand – it needs the hardware key; until then
the paragraph above holds):

1. Create the key on the hardware key: `ssh-keygen -t ed25519-sk -O resident -O verify-required -C steward-library`.
2. Publish its fingerprint here (`ssh-keygen -l -f <key>.pub`):
   `SHA256:<to be added>`.
3. Add the public key line to `BUILT_IN_PUBLISHER_KEYS` in `shared/src/libraries.ts`
   (`{ publisher: 'steward', name: 'Steward', key: 'sk-ssh-ed25519@openssh.com AAAA…' }`).
4. Before each release tag: `npm run library -- build` and `npm run library -- sign -f <key>`
   for Steward's example library, and let the release workflow run `npm run library -- verify`
   against the built-in key.

The example library in `examples/libraries/` is signed with a test key
(`examples/libraries/TEST-PUBLISHER-KEY.pub`) that is never trusted by default.

## How we keep Steward secure

The CI runs secret scanning, dependency and container vulnerability scans,
static analysis (Semgrep, CodeQL), workflow linting and OpenSSF Scorecard; see
[docs/ci/SECURITY-PIPELINE.md](docs/ci/SECURITY-PIPELINE.md). The security model
of the application is described in the [security model](docs/SECURITY-MODEL.md), and
what optional error reporting sends in [docs/ERROR-REPORTING.md](docs/ERROR-REPORTING.md).
