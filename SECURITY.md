# Security policy

Steward stores credentials for production platforms and can change data on them,
so we take security reports seriously. Thank you for helping keep its users safe.

## Supported versions

Steward is pre-1.0. Security fixes are made on `main` and released as a new
version; only the **latest release** receives them. Please update before
reporting, and check whether the issue still exists on `main`.

| Version | Supported |
| --- | --- |
| latest release (0.x) | ✅ |
| older releases | ❌ – please update |

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

| Step | Target time |
| --- | --- |
| Acknowledgement of your report | 3 working days |
| First assessment (confirmed or not, severity) | 10 working days |
| Fix released – critical / high | 14 / 30 days after confirmation |
| Fix released – medium / low | 90 days after confirmation |

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
backups of database *and* `vault.json`, signed audit checkpoints shipped to a
SIEM, and keeping Chromium current. Personal data and retention:
[docs/PRIVACY.md](docs/PRIVACY.md).

## How we keep Steward secure

The CI runs secret scanning, dependency and container vulnerability scans,
static analysis (Semgrep, CodeQL), workflow linting and OpenSSF Scorecard; see
[docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md). The security model
of the application is described in the [README](README.md#security-model), and
what optional error reporting sends in [docs/ERROR-REPORTING.md](docs/ERROR-REPORTING.md).
