# Git platforms

Steward reads GitHub (also GitHub Enterprise Server), GitLab and Forgejo/Gitea (also Codeberg) with a **read-only token**. It never changes anything on a Git host.

| What                                                                                         | Where                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pipeline, release, security alerts, packages, deploy keys and tokens of a repository         | application components of type **Repository** (read every 6 hours, or _Read now_)             |
| The tech stack from the repository's files (Dockerfile, package.json, go.mod …), end of life | the same components – the stack entries have the source _read from the repository files_      |
| Does the default branch build, are there too many open alerts                                | monitors with the check type **Repository pipeline**                                          |
| Who has which rights in an organisation, group or repository                                 | access reviews with the source **Git** ([COMPLIANCE.md](COMPLIANCE.md#access-reconciliation)) |
| Several repositories at a glance                                                             | the example process _GitHub – repository health_ and the dashboard **Repositories**           |

Git sync ([GIT-SYNC.md](GIT-SYNC.md)) – processes and monitors kept in a repository – is separate and has its own sources.

## Connect a Git host

_Platforms → New_, then one of:

| Platform type                                 | Base URL (the API)                                                       | Token                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub (repositories, read-only)**          | `https://api.github.com`, GitHub Enterprise Server `https://HOST/api/v3` | Fine-grained personal access token or GitHub App installation token, read-only: _Metadata_, _Contents_, _Actions_, _Administration_ (deploy keys, collaborators), _Dependabot alerts_; organisation _Members_ for access reviews; a classic token with `read:packages` for container packages |
| **GitLab (projects, read-only)**              | `https://gitlab.com/api/v4` or `https://HOST/api/v4`                     | Group, project or personal access token with `read_api`; role _Reporter_ (deploy keys and tokens need _Maintainer_)                                                                                                                                                                           |
| **Forgejo / Gitea (repositories, read-only)** | `https://HOST/api/v1` (Codeberg: `https://codeberg.org/api/v1`)          | Token with read access to _repository_, _organization_, _package_ and _user_ (Settings → Applications)                                                                                                                                                                                        |

The token goes into the platform's credential **token** (stored encrypted, sent as `Authorization: Bearer`). The outbound policy must allow the host. _Test connection_ calls `/rate_limit` (GitHub) or `/version`. Each platform comes with a small API description of the endpoints Steward uses, so process steps can look operations up; add the host's full specification if you need more.

## Repositories of an application

On the application page, _Components → Add_: type **Repository**, the **Git platform**, and the repository path as name – `acme/shop-web`, GitLab `acme/shop/web`. Without a platform a repository stays a plain entry, as before. Steward reads it every 6 hours – with the rights of whoever last changed the component – and on _Read now_ (refresh icon):

- **Default branch and pipeline**: GitHub – the newest run of each workflow on the default branch (pull-request runs, cancelled and skipped runs left out); GitLab – the newest pipeline of the branch; Forgejo/Gitea – the combined commit status of the head commit (Forgejo Actions, Woodpecker and other CI that reports statuses). Shown as passed, failed (with the failing workflows), running or none.
- **Latest release** with its date.
- **Open security alerts** by severity: GitHub Dependabot. GitLab keeps vulnerabilities in its Ultimate tier's GraphQL API and Forgejo has none; there the line is left out.
- **Packages and container images**: GitHub container packages of the repository, GitLab container repositories and packages, Forgejo packages linked to the repository.
- **Deploy keys and tokens**: deploy keys (read-only or with write access), and on GitLab deploy tokens and project access tokens with their scopes, expiry and last use. Never their values. Each has a key button: _Add to the credentials register_ opens a new register entry filled in from it (name, type, the component it belongs to, read or write as a role, created and expiry dates) – you review and save it ([CREDENTIALS.md](CREDENTIALS.md)).
- **Tech stack from the files** at the head of the default branch: `Dockerfile` / `Containerfile` (every `FROM`, `ARG` defaults filled in, stage names and `scratch` left out; images mapped like Kubernetes images, [KUBERNETES.md](KUBERNETES.md#namespaces-of-an-application), own images under _End of life → settings_), `package.json` (`engines.node`, dependencies such as React, Angular, Vue, Next.js, Express), `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.tool-versions`, `go.mod`, `global.json` (.NET), `composer.json` (PHP, Laravel, Symfony) and `pom.xml` (Spring Boot parent, Java release). Only products on the endoflife.date list count; when several files name one product, the oldest version counts. The entries have the source _read from the repository files_; they follow the files, and an entry changed by hand wins. Images Steward cannot map are listed as _not mapped_.

End-of-life messages, the scorecard part _Tech stack_ and the end-of-life overview then cover repositories like any component ([APPLICATIONS.md](APPLICATIONS.md#end-of-life)). A read that changes the stack is audited as `application.component_repository_read`; a read that fails keeps the stack and shows why (`no permission (403)`, `no repository "acme/x"` …).

## Monitor check

```yaml
checks:
  - { id: web, name: Shop web pipeline, type: git, platform: GitHub (prod), repository: acme/shop-web }
  - { id: api, name: Shop API pipeline, type: git, platform: GitLab, repository: acme/shop/api, branch: release, failedAs: degraded }
  - { id: alerts, name: Shop web alerts, type: git, platform: GitHub (prod), repository: acme/shop-web, maxCritical: 0, maxHigh: 3 }
```

Up when the pipeline of the branch (default: the default branch) passed or is running; **down** when it failed (`failedAs: degraded` makes that degraded); **unknown** when the branch has no pipeline run or the branch does not exist. With `maxCritical` / `maxHigh` (GitHub Dependabot; `maxHigh` counts critical and high) more open alerts make it **degraded**. The message names the failing workflows: `Git: acme/shop-api@main – pipeline failed (CI)`.

## Access reviews

_Compliance → Access reconciliation → New_, a Git platform, source **Git** and the **scope**:

| Scope                                                  | GitHub                                                                                                                                               | GitLab                                              | Forgejo / Gitea                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| An organisation or group: `acme`                       | members as `owner` or `member`, outside collaborators as `outside-collaborator`                                                                      | group members with their role (`developer` …)       | team members: the Owners team as `owner`, others as `team:<name>` |
| A repository: `acme/shop-web` (GitLab `acme/shop/web`) | collaborators with their role (`admin`, `write` …), outside collaborators marked, access through a team or the organisation marked `via-team-or-org` | project members with their role, inherited ones too | collaborators with their role                                     |

Every run is a snapshot compared with the previous one and the documented access changes, like the other sources. All pages are read (at most 2,000 entries per list).

## Demo and tests

Demo mode adds **GitHub (demo)**, **GitLab (demo)** and **Forgejo (demo)**, simulated hosts (`server/src/mock/mockGitPlatforms.ts`) with the organisation `acme` and the repositories `shop-web` (pipeline green, a release, Dependabot alerts, a container package, deploy keys) and `shop-api` (pipeline red); GitLab names them `acme/shop/web` and `acme/shop/api`. Tests: `server/test/git-platforms.test.ts` and the example run in `server/test/examples.test.ts`.
