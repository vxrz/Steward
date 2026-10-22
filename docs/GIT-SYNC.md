# Git sync

Git sync keeps processes, dashboards, monitors and record types in a Git repository and brings changes into Steward after a review. Use it to version your library in Git, to review changes in pull requests, and to roll the same library out to several Steward installations (local, test, production).

- **Optional.** Git sync is off until an administrator adds a source.
- **Pull only.** Steward only reads the repository. It never pushes, and it never changes the repository.
- **Nothing is applied by itself.** Every new or changed file waits in **Updates from Git**. A designer or administrator looks at the difference and accepts it (a new version) or rejects it.

## How it works

1. An administrator adds a **source**: Git host, repository, branch, folder, what to sync and, for private repositories, a read-only access token.
2. Steward **fetches** the source by hand (_Fetch now_), on a schedule (every N minutes) or when the Git host calls its **webhook** after a push.
3. Every `.yaml`, `.yml` and `.json` file below the folder is checked with the same validators as an import (`npm run validate`). Each new or changed file becomes a **pending update**. Files that cannot be used are listed as **invalid** with the reason.
4. In **Updates from Git** (sidebar, _Automate_) a reviewer opens an update, reads the diff against the item in Steward and accepts or rejects it.
5. Accepting creates or updates the item through the normal services, with the reviewer's rights. A process gets a **new version** with the comment `From Git: <source> <file> @ <commit>`. The item shows a **From Git** badge that links to the file at that commit.

A rejected change stays rejected until the file changes again in Git.

### Conflicts

Steward remembers what it applied. When an item was edited in Steward after the last sync, or an item with the same id exists but never came from Git, the update is marked as a **conflict**. It is not applied by accident: the reviewer has to choose _Accept anyway_. For processes the local version stays in the version history.

### Files and formats

Use the formats Steward exports and the example library uses, one item per file:

| Kind        | File                                                                     | Steward id                                                           |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Process     | Process YAML/JSON (graph or sequential `steps`), as _Export YAML_ writes | `id:` in the file, otherwise the file name (`10-name.yaml` → `name`) |
| Dashboard   | Dashboard YAML (`widgets:`)                                              | `id:` in the file, otherwise the file name                           |
| Monitor     | `kind: monitor` or `kind: monitorTemplate` (monitor _Export_)            | `key:`                                                               |
| Record type | `kind: recordType` with `key`, `name`, `workflow`, `template`, `fields`  | `key:`                                                               |

Example record type file:

```yaml
kind: recordType
key: PIR
name: Post-incident review
workflow: decision
template: |
  ## What happened
fields:
  - { key: incident, label: Incident number, kind: text, required: true }
```

Platforms are referenced **by name or id only** (monitor checks, process bindings stay in Steward). A file that refers to a platform Steward does not know is invalid. Bundles (`format: steward-bundle`) are not synced: keep one item per file.

Deleting a file in Git does not delete anything in Steward.

### Auto-accept new items (optional)

_Accept new items automatically_ creates items that do not exist in Steward yet right away, with the rights of the administrator who created the source. Monitors are created **disabled**. Changes to existing items still wait for a review. The default is off.

## Set up a source

_Settings → Git sync → Manage Git sync → New source._

| Field                  | What to enter                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Git host               | Forgejo / Gitea, GitHub or GitLab                                                                                             |
| Repository URL         | The web address, e.g. `https://git.example.com/team/steward-library`. `https://` only (`http://` only for `localhost`).       |
| API URL                | Usually empty. GitHub Enterprise: `https://github.example.com/api/v3`; GitLab under a sub-path: `https://host/gitlab/api/v4`. |
| Branch                 | e.g. `main`                                                                                                                   |
| Folder                 | e.g. `steward` – only files below it are read. Empty = the whole repository.                                                  |
| What to sync           | Processes, dashboards, monitors, record types                                                                                 |
| Access token           | A read-only token (see below). Empty for public repositories.                                                                 |
| Fetch every (minutes)  | 0 = no schedule. At least 5.                                                                                                  |
| Accept webhook calls   | On: the Git host calls Steward after every push                                                                               |
| Require signed commits | On: a fetch fails unless the Git host verified the signature of the branch's newest commit                                    |

**The repository host must be allowed by the outbound policy** (_Settings → Outbound access_): add its host to the allow-list, e.g. `git.example.com` or, for GitHub, `api.github.com`. Otherwise the fetch fails with _Blocked by the outbound policy_.

### Forgejo / Gitea

1. Create a token: _Settings → Applications → Generate new token_. Repository and organization access: the repository (or all public). Permission: **repository: Read**. Nothing else.
2. Repository URL: `https://forgejo.example.com/<owner>/<repository>`. The API is found at `/api/v1`.
3. Webhook (optional): repository _Settings → Webhooks → Add webhook → Forgejo_ (or _Gitea_).
   - Target URL: the _Payload URL_ Steward shows after saving (`https://steward.example.com/api/hooks/sync/<id>`).
   - HTTP method POST, content type `application/json`.
   - Secret: the webhook secret Steward shows once.
   - Trigger on: **Push events**. Branch filter: your branch.
4. Signed commits: Forgejo marks a commit as verified when the signing key (GPG or SSH) belongs to a user of the instance.

### GitHub

1. Create a **fine-grained personal access token** (or a GitHub App installation token): _Settings → Developer settings → Fine-grained tokens_. Repository access: only the library repository. Permissions: **Contents: Read-only** (Metadata: Read-only is added automatically). Nothing else.
2. Repository URL: `https://github.com/<owner>/<repository>`. Steward uses `https://api.github.com` – allow `api.github.com` in the outbound policy. GitHub Enterprise Server: `https://github.example.com/<owner>/<repository>`, the API at `/api/v3`.
3. Webhook (optional): repository _Settings → Webhooks → Add webhook_.
   - Payload URL: the URL Steward shows. Content type: `application/json`.
   - Secret: the webhook secret. GitHub signs every call (`X-Hub-Signature-256`).
   - _Just the push event._
4. Signed commits: GitHub shows _Verified_ for commits signed with a key of the committer's account; Steward reads the same verification.

### GitLab (optional)

1. Create a **project access token** with the role _Reporter_ and the scope **read_api** (or `read_repository` plus `read_api`).
2. Repository URL: `https://gitlab.example.com/<group>/<project>` (subgroups are fine). The API is found at `/api/v4`.
3. Webhook: project _Settings → Webhooks_. URL: the Payload URL; **Secret token**: the webhook secret (GitLab sends it as `X-Gitlab-Token`); trigger **Push events**.

### Plain Git servers

Git sync uses the Git hosts' HTTP APIs, not the Git protocol. This needs no `git` program (it works in the desktop executable), downloads only the files of the folder and keeps every request a simple HTTPS GET that the outbound policy can check. A plain Git server without one of these APIs is not supported – mirror the repository to Forgejo, GitHub or GitLab.

## Security

- **Outbound policy.** Every request goes to the API of the configured host and is checked like a process request: the host must be a platform origin or on the allow-list, cloud-metadata addresses and Steward's own API are never reachable, the address is pinned against DNS rebinding.
- **Token.** Stored encrypted in the vault (re-encrypted when the data key rotates), never shown again, never logged, sent only to the API base of the source. Redirects are refused, so the token cannot be forwarded to another host.
- **Limits.** At most 200 definition files per fetch, 256 KB per file, 4 MB together; answers of the Git host are size-capped while they are read.
- **Integrity.** Every file is checked against its Git object id from the commit's tree. With _Require signed commits_ the newest commit must carry a signature the host verified.
- **Path confinement.** Only regular files below the folder are read: no `..`, no symbolic links, no submodules.
- **No code from the repository.** Files are parsed as data only (YAML core schema, no custom tags, bounded aliases). Nothing in them is run while fetching or reviewing.
- **No secrets in Git.** A file that looks like it contains a key, token or password (the credentials register's checks: private keys, GitHub/GitLab/AWS/Slack tokens, passwords in URLs, …) is refused as a whole. Platforms are referenced by name or id; credentials stay in Steward's vault.
- **Rights.** Sources are managed by administrators in a signed-in session (API tokens cannot create, change or delete them). Reviewing needs the designer role; accepting needs the same right as the change by hand (create processes, edit this process, manage record types, …).
- **Webhook.** Authenticated by the source's secret (HMAC-SHA256 of the body for Forgejo/Gitea/GitHub, the secret token for GitLab), at most 12 calls per minute per source, unknown or disabled sources answer 404. The payload only says _something changed_: Steward reads the repository through the API like any other fetch.
- **Audit.** Every source change, fetch (with the commit), staged update, acceptance (with the resulting version), rejection and refused webhook call is in the audit log.

## API

| Route                                                                                                          | Who                                                    |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET/POST /api/sync-sources`, `GET/PUT/DELETE /api/sync-sources/:id`                                           | administrators (changes: signed-in session)            |
| `POST /api/sync-sources/:id/rotate-webhook-secret`                                                             | administrators, signed-in session                      |
| `POST /api/sync-sources/:id/fetch`                                                                             | administrators                                         |
| `GET /api/sync-updates[?status=pending,invalid&sourceId=]`, `GET /api/sync-updates/:id`                        | designers, administrators                              |
| `POST /api/sync-updates/:id/accept` `{ comment?, force? }`, `POST /api/sync-updates/:id/reject` `{ comment? }` | designers, administrators (and the right for the item) |
| `GET /api/sync-origins[?kind=process]`                                                                         | everyone, for the items they can see                   |
| `POST /api/hooks/sync/:id`                                                                                     | the Git host (webhook secret)                          |

## Demo and tests

The demo server includes a small Git host (`server/src/mock/mockGit.ts`) that speaks the Forgejo, GitHub and GitLab API subsets:

- Forgejo: repository URL `http://127.0.0.1:<port>/mock/git/steward/library`, folder `steward`.
- GitHub: `…/mock/github/steward/library`.
- GitLab: `…/mock/gitlab/steward/library` with the API URL `…/mock/gitlab/api/v4`.

The repository holds one process, dashboard, monitor and record type. `steward/private` needs the token `mock-git-token-0123456789`. Tests add commits with `POST /mock/git/_commit`.
