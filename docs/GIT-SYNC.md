# Git sync

Git sync keeps processes, dashboards, monitors and record types in a Git repository and brings changes into Steward after a review. Use it to version your library in Git, to review changes in pull requests, and to roll the same library out to several Steward installations (local, test, production).

- **Optional.** Git sync is off until an administrator adds a source or turns on [Steward's example library](#stewards-example-library), which every installation has as a disabled source.
- **Pull only.** Steward only reads the repository. It never pushes, and it never changes the repository (pushing changes back is planned, see issue #20).
- **Nothing is applied by itself.** Every new or changed file waits in **Updates from Git**. A designer or administrator looks at the difference and accepts it (a new version) or rejects it.

## How it works

1. An administrator adds a **source**: Git host, repository, branch or tag, folder, what to sync and, for private repositories, a read-only access token.
2. Steward **fetches** the source by hand (_Fetch now_), on a schedule (every N minutes) or when the Git host calls its **webhook** after a push.
3. Every `.yaml`, `.yml` and `.json` file below the folder is checked with the same validators as an import (`npm run validate`). Each new or changed file becomes a **pending update**. Files that cannot be used are listed as **invalid** with the reason.
4. In **Updates from Git** (sidebar, _Automate_) a reviewer opens an update, reads the diff against the item in Steward and accepts or rejects it.
5. Accepting creates or updates the item through the normal services, with the reviewer's rights. A process gets a **new version** with the comment `From Git: <source> <file> @ <commit>`. The item shows a **From Git** badge that links to the file at that commit.

A rejected change stays rejected until the file changes again in Git.

Reviewers only see updates of items they may see. When a file in Git maps to a process or monitor that the reviewer has no view right on, the update is not listed for them, and opening, accepting or rejecting it answers _not found_. Administrators see every update.

### Signed commits

With _Require signed commits_ a fetch checks the signature of **every commit that is new since the last fetched commit**, not only the newest one. Steward asks the Git host which commits are new (Forgejo/Gitea and GitHub: the compare API; GitLab: the commits API and one signature request per commit) and whether the host verified each signature.

- If one commit is not signed with a key the host verified, the **whole fetch is refused**: nothing is staged, the source shows the error with the commit, and the audit log has a `sync.fetch_failed` entry. A newer signed commit on top does not help, and neither does a signed revert: the unsigned commit stays in the history. To go on, reset the branch to the last fetched commit (the source shows it) and push the changes again as signed commits.
- **The first fetch** (a new source, or after the repository, branch or folder changed) has no last commit. It checks the newest commit only and **trusts the history up to it**. The same applies to commits fetched while the setting was off: turning it on later trusts everything fetched before.
- **Allowed signers** (optional): logins on the Git host or e-mail addresses. With a list, every checked commit must also be signed by one of them. Forgejo/Gitea report the signer. GitHub and GitLab verify a signature only when the key belongs to the committer, so their committer login and committer e-mail are compared. Commits made in GitHub's web interface are signed by GitHub (committer `web-flow`).
- At most 250 new commits are checked per fetch. More fail with _too many new commits_: fetch more often (webhook or schedule).
- If the Git host cannot list the commits since the last fetched commit (the history was rewritten and the old commit is gone, or Forgejo older than 7 / Gitea older than 1.22, which have no compare API), the fetch is refused. Check the branch on the Git host. If you trust it, turn _Require signed commits_ off, fetch once, review the staged updates and turn it on again. Both changes are in the audit log.

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

### Files that need a newer Steward

A YAML file can name the oldest Steward version that can use it, in a comment line at the top:

```yaml
# Uses $ts(), new in 0.2.1
# steward-min-version: 0.2.1
name: Insights Hub – inactive users
```

On an older Steward the file is listed as **invalid** with _Needs Steward 0.2.1 or newer_ and is not staged. After the upgrade, the next fetch stages it, even when nothing changed in Git. For every importer the line is a comment, so the same file still imports into versions that don't know the marker (0.2.0 and older). JSON files have no comments and no marker.

The marker matters when a source follows a branch such as `main`. A source that follows the tag of its own version (`v{version}`) only sees files of that release.

### Auto-accept new items (optional)

_Accept new items automatically_ creates items that do not exist in Steward yet right away, with the rights of the administrator who created the source. Monitors are created **disabled**. Changes to existing items still wait for a review. The default is off.

## Set up a source

_Settings → Git sync → Manage Git sync → New source._

| Field                  | What to enter                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Git host               | Forgejo / Gitea, GitHub or GitLab                                                                                             |
| Repository URL         | The web address, e.g. `https://git.example.com/team/steward-library`. `https://` only (`http://` only for `localhost`).       |
| API URL                | Usually empty. GitHub Enterprise: `https://github.example.com/api/v3`; GitLab under a sub-path: `https://host/gitlab/api/v4`. |
| Follow                 | **Branch** (its newest commit) or **Tag** (the commit the tag points to). See [Branches and tags](#branches-and-tags).        |
| Branch / Tag           | e.g. `main`, `release-2026-10` or `v{version}`                                                                                |
| Folder                 | e.g. `steward` – only files below it are read. Empty = the whole repository.                                                  |
| What to sync           | Processes, dashboards, monitors, record types                                                                                 |
| Access token           | A read-only token (see below). Empty for public repositories.                                                                 |
| Fetch every (minutes)  | 0 = no schedule. At least 5.                                                                                                  |
| Accept webhook calls   | On: the Git host calls Steward after every push                                                                               |
| Require signed commits | On: a fetch fails and stages nothing unless the Git host verified every new commit (see [Signed commits](#signed-commits))    |
| Allowed signers        | Optional, with signed commits: Git host logins or e-mail addresses whose signatures are accepted. Empty = any verified one.   |

### Branches and tags

- A **branch** source fetches the newest commit of the branch.
- A **tag** source fetches the commit the tag points to; annotated tags are followed to their commit. When the tag is moved to another commit, the next fetch stages the changes like a new commit on a branch. A tag that is pushed again sends a push event with `refs/tags/<tag>`, which the webhook accepts.
- **`{version}`** in the name stands for this installation's Steward version: `v{version}` is `v0.2.1` on Steward 0.2.1. It is resolved at every fetch, so after an upgrade the source follows the new release's tag by itself. The source list shows the resolved name, the audit entry `sync.fetched` names the branch or tag and the commit.
- Signed commits work for tags too: the commits between the last fetched commit and the tag's commit are checked, so a tag moved to unrelated history is refused like a rewritten branch.
- Changing the branch, tag or type starts over: the next fetch is treated as a first fetch.

### Steward's example library

Every installation has the source **Steward example library** (badge _Steward examples_): GitHub, `https://github.com/vxrz/Steward`, tag `v{version}`, folder `examples`, processes, dashboards and monitors. It brings improved example templates of your version into **Updates from Git**, where you review them like any other change; with `v{version}` it only shows examples made for the Steward you run.

- It is **disabled**: nothing is fetched until an administrator turns it on (_Edit source → Enabled_). No token, no schedule, no webhook, no automatic acceptance.
- To use it, allow `api.github.com` in the outbound policy (_Settings → Outbound access_).
- It is added **once**: on a new installation and on the upgrade to 0.2.1, after the vault is unlocked (audit entry `sync.source_created` by `system`). Your changes to it stay, and a deleted one is not brought back.
- Examples you imported by hand before have the same ids (the file name without its number). The first fetch shows them as conflicts (_The item exists in Steward but did not come from this source_) or links them when they are identical, so nothing you changed is overwritten without a decision.

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

## Best practice

Use Git sync in two roles: Steward's example library as a source of **suggestions**, and your own repository as the **source of truth** for what you build.

### Steward's example library

- **Turn it on and fetch by hand after each upgrade.** It follows your version's tag, so nothing changes in between, and no schedule or webhook is needed.
- **Accept updates of examples you use unchanged** (for example the timestamp fixes in 0.2.1). After accepting a process, start it once as a dry run.
- **Examples you adapted:** an update is marked as a conflict. Read the diff, take over what helps into your process by hand and **reject** the update. _Accept anyway_ replaces your version (it stays in the version history).
- **Reject offers you don't need.** A rejected file stays quiet until it changes again.
- **To build on an example**, copy it into your own repository under a new file name. It is then yours, and updates of the example don't touch it.

### Your own repository

- **One repository** (GitLab, GitHub Enterprise or Forgejo) with one folder, e.g. `steward/`, holding your processes, dashboards, monitors and record types – one item per file.
- **The file name is the id** (a leading number like `10-` is ignored). Keep ids stable; the display name (`name:`) can change any time.
- **Review in Git, apply in Steward:** changes go through merge requests with a reviewer (the four-eyes step happens in Git). _Updates from Git_ is the second gate, on the instance.
- **Environments:** the test instance follows `main` (webhook or every 15 minutes); production follows a tag or a release branch (e.g. tags `lib-1.4.0`). You promote a version by tagging it.
- **Edit synced items in Git, not in Steward.** A local edit turns the next change into a conflict.
- **Mark files that need a newer Steward** with `# steward-min-version: x.y.z`, so instances on an older version list them instead of importing them.
- **Monitors:** use platform names that exist on every instance (e.g. `Insights Hub (production)` on all of them), or pick the platform when accepting.
- **Security:** a read-only token, _Require signed commits_ with allowed signers, protected branches and tags. Auto-accept of new items only on a test instance, if at all.

### What Git sync does not do (yet)

- It never writes to Git, and a file deleted in Git does not remove the item in Steward. Both are planned (#20).
- It does not merge your local changes with incoming ones: you choose one version, and the other stays in the history.

## Security

- **Outbound policy.** Every request goes to the API of the configured host and is checked like a process request: the host must be a platform origin or on the allow-list, cloud-metadata addresses and Steward's own API are never reachable, the address is pinned against DNS rebinding.
- **Token.** Stored encrypted in the vault (re-encrypted when the data key rotates), never shown again, never logged, sent only to the API base of the source. Redirects are refused, so the token cannot be forwarded to another host.
- **Limits.** At most 200 definition files per fetch, 256 KB per file, 4 MB together; answers of the Git host are size-capped while they are read.
- **Integrity.** Every file is checked against its Git object id from the commit's tree: SHA-1, or SHA-256 for repositories in the SHA-256 object format. With _Require signed commits_ every new commit since the last fetch must carry a signature the host verified, optionally by an allowed signer.
- **Retention.** Updates replaced by a newer version of the file (_superseded_) are deleted after 30 days. Rejected updates keep their decision (so the file is not staged again until it changes), but their content is removed after 30 days. Open and accepted updates are kept; an accepted process change is also in the process's version history.
- **Path confinement.** Only regular files below the folder are read: no `..`, no symbolic links, no submodules.
- **No code from the repository.** Files are parsed as data only (YAML core schema, no custom tags, bounded aliases). Nothing in them is run while fetching or reviewing.
- **No secrets in Git.** A file that looks like it contains a key, token or password (the credentials register's checks: private keys, GitHub/GitLab/AWS/Slack tokens, passwords in URLs, …) is refused as a whole. Platforms are referenced by name or id; credentials stay in Steward's vault.
- **Rights.** Sources are managed by administrators in a signed-in session (API tokens cannot create, change or delete them). Reviewing needs the designer role; accepting needs the same right as the change by hand (create processes, edit this process, manage record types, …). Updates of processes and monitors the reviewer cannot see are hidden.
- **Webhook.** Authenticated by the source's secret (HMAC-SHA256 of the body for Forgejo/Gitea/GitHub, the secret token for GitLab), at most 12 calls per minute per source, unknown or disabled sources answer 404. The payload only says _something changed_: Steward reads the repository through the API like any other fetch.
- **Example library.** The built-in source is created disabled, without a token or webhook secret, and reads a public repository through the same outbound policy as every source. Turning it on is a source change in the audit log.
- **Audit.** Every source change, fetch, acceptance (with the resulting version), rejection and refused webhook call is in the audit log. A fetch writes one `sync.fetched` entry with the commit and the staged and invalid files (the first 100 listed by path, all counted); a refused fetch writes `sync.fetch_failed` with the reason.

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

The repository holds one process, dashboard, monitor and record type. `steward/private` needs the token `mock-git-token-0123456789`. Tests add commits with `POST /mock/git/_commit` (`signed`, `signer`, `email`, and `objectFormat: "sha256"` for a new SHA-256 repository), create or move tags with `POST /mock/git/_tag` (`annotated: true` for a tag object) and serve wrong file content with `POST /mock/git/_tamper`.
