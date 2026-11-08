# Releases and support

How Steward is versioned, which versions get fixes, how a release is tested before it is tagged, and how to check what you download. The policy below is a proposal for a project with one maintainer; the parts marked _(to confirm)_ are the owner's decision and may change before 1.0.

## Versions

Steward uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **Before 1.0**, a minor release (`0.11.0`) can add features, add database migrations and change behaviour. Changes you have to act on are marked **Check before updating** in the [CHANGELOG](../CHANGELOG.md).
- A **patch release** (`0.11.1`) only fixes bugs and security issues. It adds no features and no behaviour change you have to act on. It may add a migration when a fix needs one.
- A tag with a suffix (`v0.11.0-beta.1`) is a **pre-release**: not for production, no support.
- Updates go **forward only**: a version refuses to start on a database that a newer version has upgraded. To go back, restore the backup taken before the update ([INSTALL.md](INSTALL.md#6-updating)).

## Which versions get fixes _(to confirm)_

| Version                                   | Bug fixes | Security fixes                                      |
| ----------------------------------------- | --------- | --------------------------------------------------- |
| The latest minor release (e.g. 0.11.x)    | ✅        | ✅                                                  |
| The minor release before it (e.g. 0.10.x) | ❌        | ✅ for **30 days** after the next minor is released |
| Older releases                            | ❌        | ❌ – please update                                  |

- A security fix for the previous minor is released as a patch release of that line (`0.10.2`), cut from a release branch (`release/0.10`), so you can take it without the features and migrations of the next minor.
- Fixes are made on `main` first and then applied to the supported lines.
- Severe vulnerabilities are fixed first; the advisory names the fixed versions ([SECURITY.md](../SECURITY.md)).

## How a release is tested

- **CI on `main` is green.** A release is tagged only from a commit on `main` whose CI run passed: type checks, lint, the server suite on SQLite and PostgreSQL, the browser tests and the security scans ([ci/SECURITY-PIPELINE.md](ci/SECURITY-PIPELINE.md)).
- **Upgrades are tested from every minor release.** `server/test/fixtures/upgrade/` holds a data folder written by each minor release, and every test run starts the current version on each of them – on SQLite and, after a copy, on PostgreSQL ([TESTING.md](TESTING.md#upgrade-tests)). A fixture of the new release is added right after it is tagged.
- **The release workflows smoke-test what they publish:** the desktop executables are started and checked on Windows, macOS and Linux, and the container image is scanned before it is pushed.
- Each release PR carries a checklist and a short security self-review of what changed (`.github/PULL_REQUEST_TEMPLATE/release.md`).

## How to verify a download

- **Desktop executables:** check the checksum and the build provenance: `sha256sum -c SHA256SUMS.txt` and `gh attestation verify <archive> --repo vxrz/Steward`.
- **Container image:** `ghcr.io/vxrz/steward:<version>` is signed with cosign (keyless) and carries SLSA provenance and an SBOM. Check the signature before you run it.

The exact commands are in [SECURITY-HARDENING.md](SECURITY-HARDENING.md#verifying-downloads).

## Image tags

| Tag         | Points to                                             |
| ----------- | ----------------------------------------------------- |
| `<version>` | One release, e.g. `0.11.0`. Pin this in production.   |
| `<minor>`   | The newest patch release of a minor line, e.g. `0.11` |
| `latest`    | The newest release                                    |
| `…-browser` | The same, with Chromium for browser steps             |

A pre-release only gets its own tag. How the tags are computed: `scripts/ci/image-tags.sh`.
