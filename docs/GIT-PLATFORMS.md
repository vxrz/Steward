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

The token goes into the platform's credential **token** (stored encrypted). GitHub and Forgejo get it as `Authorization: Bearer <token>`; GitLab as `PRIVATE-TOKEN: <token>`, GitLab's own header for personal, group and project access tokens – reverse proxies and sign-in gateways in front of GitLab often take over `Authorization` and pass on a request without it. For a GitLab **OAuth** token set _Settings → Authentication → Header for the token_ to `Authorization`. The token is only sent to the platform's own origin (and its _trusted origins_), never along a redirect to another host.

Reading repositories is a built-in connector read: it goes to the platform's base URL, so it needs **no allow-list entry** (only the always-on address safety applies). Access reviews with the source _Git_ go through the outbound policy, where a configured platform's origin is allowed by default (policy `platforms`); under the policy `allowList` the host needs an entry ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#do-i-need-an-allow-list-entry)). _Test connection_ calls `/rate_limit` (GitHub) or `/version` and fails when the answer is not the API's JSON – for example a redirect to a sign-in page. Each platform comes with a small API description of the endpoints Steward uses, so process steps can look operations up; add the host's full specification if you need more.

### When it does not work

| Message                                                     | Likely cause and fix                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answered HTTP 302 – redirected to https://…/users/sign_in` | The base URL is not the API, or a sign-in gateway (SSO proxy, VPN portal) sits in front of it. Use `https://HOST/api/v4` (GitHub Enterprise `…/api/v3`, Forgejo `…/api/v1`) on an address that is reachable without browser sign-in.                                                                                                                                                         |
| `answered with an HTML page, not the API`                   | The same, without a redirect: a portal or sign-in page answered.                                                                                                                                                                                                                                                                                                                             |
| `refused the token (401)`                                   | The token expired or was revoked; it is the wrong type (GitLab **deploy tokens** and **feed tokens** do not work for the API – use a personal, group or project access token); or a proxy in front of the host removed the header (`PRIVATE-TOKEN` on GitLab, `Authorization` elsewhere). A 401 with an empty answer within milliseconds usually comes from such a proxy, not from the host. |
| `no permission (403): insufficient_scope`                   | The token lacks a scope (GitLab: `read_api`) or the role (Reporter; deploy keys and tokens need Maintainer).                                                                                                                                                                                                                                                                                 |
| `no project "group/project"` although it exists             | Steward sends the project path URL-encoded (`group%2Fproject`), as GitLab requires. A reverse proxy that **decodes `%2F`** turns it into `/projects/group/project`, which GitLab answers with 404. Configure the proxy to pass the path through unchanged (nginx: `proxy_pass` without a URI part; Apache: `AllowEncodedSlashes NoDecode` and `nocanon`).                                    |

A file of the tech stack that cannot be read (too large, a proxy that refuses it) is left out and logged; it no longer fails the whole read.

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
